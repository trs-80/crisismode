// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { kafkaRecoveryManifest } from './manifest.js';
import type { KafkaBackend } from './backend.js';
import { KafkaSimulator } from './simulator.js';

export class KafkaRecoveryAgent implements RecoveryAgent {
  manifest = kafkaRecoveryManifest;
  backend: KafkaBackend;

  constructor(backend?: KafkaBackend) {
    this.backend = backend ?? new KafkaSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const metadata = await this.backend.getClusterMetadata();
    const urps = await this.backend.getUnderReplicatedPartitions();
    const consumerGroups = await this.backend.getConsumerGroups();

    const urpCount = urps.length;
    const maxLag = Math.max(0, ...consumerGroups.map((g) => g.lag));
    const expectedBrokers = 3;
    const brokerCount = metadata.brokers.length;

    const urpCritical = urpCount > 2;
    const urpWarning = urpCount > 0;
    const lagCritical = maxLag > 10_000;
    const lagWarning = maxLag > 1_000;
    const brokerCritical = brokerCount < expectedBrokers;

    const status: HealthStatus = urpCritical || lagCritical
      ? 'unhealthy'
      : urpWarning || lagWarning || brokerCritical
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'kafka_partition_status',
        status: signalStatus(urpCritical, urpWarning),
        detail: `${urpCount} under-replicated partition(s) across ${metadata.topicCount} topic(s).`,
        observedAt,
      },
      {
        source: 'kafka_consumer_lag',
        status: signalStatus(lagCritical, lagWarning),
        detail: `Maximum consumer group lag is ${maxLag.toLocaleString()} across ${consumerGroups.length} group(s).`,
        observedAt,
      },
      {
        source: 'kafka_broker_status',
        status: signalStatus(brokerCritical),
        detail: `${brokerCount}/${expectedBrokers} broker(s) online. Controller is broker-${metadata.controllerId}.`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: 'Kafka cluster is healthy. All partitions are in-sync, consumer lag is within normal thresholds, and all brokers are online.',
        recovering: 'Kafka cluster is recovering. Under-replicated partitions or elevated consumer lag detected but within manageable thresholds.',
        unhealthy: 'Kafka cluster is unhealthy. Significant under-replicated partitions or critical consumer lag requires immediate action.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring Kafka partition and consumer lag metrics.'],
        recovering: ['Continue monitoring until all partitions are in-sync and consumer lag returns to healthy thresholds.'],
        unhealthy: ['Run the Kafka recovery workflow in dry-run mode to determine the next safe mitigation step.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const metadata = await this.backend.getClusterMetadata();
    const urps = await this.backend.getUnderReplicatedPartitions();
    const consumerGroups = await this.backend.getConsumerGroups();
    const brokerConfigs = await this.backend.getBrokerConfigs(metadata.controllerId);

    const urpCount = urps.length;
    const maxLag = Math.max(0, ...consumerGroups.map((g) => g.lag));

    const scenario = urpCount > 0
      ? 'under_replicated_partitions'
      : maxLag > 10_000
        ? 'consumer_lag_cascade'
        : 'partition_leader_imbalance';

    const confidence = urpCount > 0 ? 0.93 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'kafka_cluster_metadata',
          observation: `Cluster ${metadata.clusterId}: ${metadata.brokers.length} broker(s), ${metadata.topicCount} topic(s), ${metadata.partitionCount} partition(s). Controller: broker-${metadata.controllerId}.`,
          severity: 'info',
          data: { clusterId: metadata.clusterId, brokerCount: metadata.brokers.length, topicCount: metadata.topicCount, partitionCount: metadata.partitionCount },
        },
        {
          source: 'kafka_partition_status',
          observation: `${urpCount} under-replicated partition(s). Affected topics: ${[...new Set(urps.map((p) => p.topic))].join(', ') || 'none'}.`,
          severity: urpCount > 2 ? 'critical' : urpCount > 0 ? 'warning' : 'info',
          data: { urpCount, urps: urps.map((p) => ({ topic: p.topic, partition: p.partition, isr: p.isr, replicas: p.replicas })) },
        },
        {
          source: 'kafka_consumer_lag',
          observation: `${consumerGroups.length} consumer group(s). Max lag: ${maxLag.toLocaleString()}. Groups in non-stable state: ${consumerGroups.filter((g) => g.state !== 'Stable').length}.`,
          severity: maxLag > 10_000 ? 'critical' : maxLag > 1_000 ? 'warning' : 'info',
          data: { consumerGroups: consumerGroups.map((g) => ({ groupId: g.groupId, state: g.state, lag: g.lag })) },
        },
        {
          source: 'kafka_broker_config',
          observation: `Controller broker config: log.flush.interval.messages=${brokerConfigs['log.flush.interval.messages']}, num.replica.fetchers=${brokerConfigs['num.replica.fetchers']}.`,
          severity: brokerConfigs['log.flush.interval.messages'] === 'Long.MAX_VALUE' ? 'warning' : 'info',
          data: { brokerConfigs },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const instance = String(context.trigger.payload.instance || 'kafka-cluster');

    const steps: RecoveryStep[] = [
      // Step 1: Capture cluster state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture Kafka cluster state',
        executionContext: 'kafka_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'cluster_metadata',
          parameters: { includePartitions: true, includeConsumerGroups: true },
        },
        outputCapture: {
          name: 'current_kafka_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Kafka partition recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Kafka under-replicated partition recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[1]?.observation}`,
          contextReferences: ['current_kafka_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint — capture consumer offsets and partition assignments
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture consumer offsets and partition assignments before mutations.',
        stateCaptures: [
          {
            name: 'consumer_offsets_snapshot',
            captureType: 'command_output',
            statement: 'consumer_group_offsets --all',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'partition_assignments_snapshot',
            captureType: 'command_output',
            statement: 'topic_partitions --all',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Preferred leader election
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Trigger preferred leader election',
        description: 'Elect preferred leaders for under-replicated partitions to rebalance leadership.',
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['broker.leader.elect'],
        command: {
          type: 'structured_command',
          operation: 'leader_elect',
          parameters: { electionType: 'preferred', scope: 'under_replicated' },
        },
        preConditions: [
          {
            description: 'All brokers are reachable',
            check: {
              type: 'structured_command',
              statement: 'broker_count',
              expect: { operator: 'gte', value: 3 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'partition_leaders_before',
              captureType: 'command_output',
              statement: 'topic_partitions --leaders',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'partition_leaders_after',
              captureType: 'command_output',
              statement: 'topic_partitions --leaders',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'Under-replicated partition count decreased',
          check: {
            type: 'structured_command',
            statement: 'under_replicated_count',
            expect: { operator: 'lt', value: 4 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Leader election is safe; Kafka will re-elect leaders automatically on failure.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['producer-connections', 'consumer-connections'],
          maxImpact: 'brief_leader_migration',
          cascadeRisk: 'low',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Reassign partitions
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Reassign under-replicated partitions',
        description: 'Trigger partition reassignment to rebuild ISR on lagging brokers.',
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['broker.partition.reassign'],
        command: {
          type: 'structured_command',
          operation: 'partition_reassign',
          parameters: { strategy: 'balanced', throttleBytes: 50_000_000 },
        },
        statePreservation: {
          before: [
            {
              name: 'isr_state_before',
              captureType: 'command_output',
              statement: 'topic_partitions --isr',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'isr_state_after',
              captureType: 'command_output',
              statement: 'topic_partitions --isr',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovered',
        successCriteria: {
          description: 'All partitions are in-sync',
          check: {
            type: 'structured_command',
            statement: 'under_replicated_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Cancel in-progress reassignment via kafka-reassign-partitions --cancel.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['inter-broker-replication'],
          maxImpact: 'increased_replication_traffic',
          cascadeRisk: 'medium',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 6: Replanning checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess partition and lag state after reassignment',
        description: 'Check if ISR is fully rebuilt or if additional action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_reassignment_state',
            captureType: 'command_output',
            statement: 'cluster_metadata --full',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Conditional — verify ISR health
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Verify ISR health and notify or escalate',
        condition: {
          description: 'All partitions are in-sync (0 URPs)',
          check: {
            type: 'structured_command',
            statement: 'under_replicated_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        thenStep: {
          stepId: 'step-007a',
          type: 'human_notification',
          name: 'ISR fully rebuilt — notify team',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `Kafka ISR fully rebuilt on ${instance}`,
            detail: 'All partitions are in-sync. Consumer lag is expected to recover shortly.',
            contextReferences: ['post_reassignment_state'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-007b',
          type: 'human_notification',
          name: 'ISR rebuild incomplete — escalate',
          recipients: [
            { role: 'on_call_engineer', urgency: 'high' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `Kafka ISR rebuild incomplete on ${instance}`,
            detail: 'Under-replicated partitions remain after reassignment. Manual investigation required.',
            contextReferences: ['post_reassignment_state'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 8: Recovery summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Kafka partition recovery completed on ${instance}`,
          detail: 'Preferred leader election and partition reassignment executed. ISR status verified. Monitor consumer lag convergence.',
          contextReferences: ['post_reassignment_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'kafka-urp',
        agentName: 'kafka-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'under_replicated_partitions',
        estimatedDuration: 'PT10M',
        summary: `Recover Kafka from under-replicated partitions on ${instance}: elect preferred leaders, reassign partitions, verify ISR.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'kafka',
            role: 'cluster',
            impactType: 'brief_leader_migration_and_replication_traffic',
          },
        ],
        affectedServices: ['messaging-layer', 'event-streaming'],
        estimatedUserImpact: 'Brief increase in produce/consume latency during leader election and partition reassignment. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each step is independently reversible. Leader election recovers automatically; partition reassignment can be cancelled.',
      },
    };
  }

  replan = defaultReplan;
}
