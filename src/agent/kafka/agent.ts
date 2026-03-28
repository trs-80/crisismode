// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { kafkaRecoveryManifest } from './manifest.js';
import type { BrokerLiveness, KafkaBackend } from './backend.js';
import { KafkaSimulator } from './simulator.js';
import { aiDiagnose } from './ai-diagnosis.js';

export class KafkaRecoveryAgent implements RecoveryAgent {
  manifest = kafkaRecoveryManifest;
  backend: KafkaBackend;

  constructor(backend?: KafkaBackend) {
    this.backend = backend ?? new KafkaSimulator();
  }

  // ---------------------------------------------------------------------------
  // Health assessment
  // ---------------------------------------------------------------------------

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const metadata = await this.backend.getClusterMetadata();
    const urps = await this.backend.getUnderReplicatedPartitions();
    const consumerGroups = await this.backend.getConsumerGroups();
    const allPartitions = await this.backend.getTopicPartitions();

    const urpCount = urps.length;
    const maxLag = Math.max(0, ...consumerGroups.map((g) => g.lag));
    const expectedBrokers = 3;
    const aliveBrokers = metadata.brokers.filter((b) => b.isAlive).length;
    const leaderlessCount = allPartitions.filter((p) => p.leader === -1).length;

    const brokerDown = aliveBrokers < expectedBrokers;
    const urpCritical = urpCount > 2;
    const urpWarning = urpCount > 0;
    const lagCritical = maxLag > 10_000;
    const lagWarning = maxLag > 1_000;

    const status: HealthStatus = brokerDown || urpCritical || lagCritical
      ? 'unhealthy'
      : urpWarning || lagWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'kafka_broker_status',
        status: signalStatus(brokerDown),
        detail: `${aliveBrokers}/${expectedBrokers} broker(s) online. Controller is broker-${metadata.controllerId}.${leaderlessCount > 0 ? ` ${leaderlessCount} leaderless partition(s).` : ''}`,
        observedAt,
      },
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
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: 'Kafka cluster is healthy. All partitions are in-sync, consumer lag is within normal thresholds, and all brokers are online.',
        recovering: 'Kafka cluster is recovering. Under-replicated partitions or elevated consumer lag detected but within manageable thresholds.',
        unhealthy: 'Kafka cluster is unhealthy. Broker failure, significant under-replicated partitions, or critical consumer lag requires immediate action.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring Kafka partition and consumer lag metrics.'],
        recovering: ['Continue monitoring until all partitions are in-sync and consumer lag returns to healthy thresholds.'],
        unhealthy: ['Run the Kafka recovery workflow in dry-run mode to determine the next safe mitigation step.'],
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Diagnosis
  // ---------------------------------------------------------------------------

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const metadata = await this.backend.getClusterMetadata();
    const allPartitions = await this.backend.getTopicPartitions();
    const urps = await this.backend.getUnderReplicatedPartitions();
    const consumerGroups = await this.backend.getConsumerGroups();
    const brokerConfigs = await this.backend.getBrokerConfigs(metadata.controllerId);

    const brokerLiveness: BrokerLiveness[] = await Promise.all(
      [0, 1, 2].map((id) => this.backend.getBrokerLiveness(id)),
    );

    // Try AI diagnosis first
    const aiResult = await aiDiagnose({
      clusterMetadata: metadata,
      partitions: allPartitions,
      consumerGroups,
      brokerConfigs,
      brokerLiveness,
    });

    if (aiResult) {
      const enrichedFindings = aiResult.findings.map((f) => ({
        ...f,
        data: { ...f.data, metadata, partitions: allPartitions, consumerGroups, brokerConfigs, brokerLiveness },
      }));
      return { ...aiResult, findings: enrichedFindings };
    }

    // Fallback: rule-based diagnosis
    return this.ruleBasedDiagnose(metadata, allPartitions, urps, consumerGroups, brokerConfigs, brokerLiveness);
  }

  private ruleBasedDiagnose(
    metadata: Awaited<ReturnType<KafkaBackend['getClusterMetadata']>>,
    allPartitions: Awaited<ReturnType<KafkaBackend['getTopicPartitions']>>,
    urps: Awaited<ReturnType<KafkaBackend['getTopicPartitions']>>,
    consumerGroups: Awaited<ReturnType<KafkaBackend['getConsumerGroups']>>,
    brokerConfigs: Record<string, string>,
    brokerLiveness: BrokerLiveness[],
  ): DiagnosisResult {
    const deadBrokers = brokerLiveness.filter((b) => !b.reachable);
    const leaderlessCount = allPartitions.filter((p) => p.leader === -1).length;
    const urpCount = urps.length;
    const maxLag = Math.max(0, ...consumerGroups.map((g) => g.lag));
    const rebalancingGroups = consumerGroups.filter((g) => g.state !== 'Stable');

    // Priority 1: Broker down
    if (deadBrokers.length > 0 || leaderlessCount > 0) {
      return {
        status: 'identified',
        scenario: 'broker_down',
        confidence: 0.96,
        findings: [
          {
            source: 'kafka_broker_liveness',
            observation: `${deadBrokers.length} broker(s) unreachable: ${deadBrokers.map((b) => `broker-${b.brokerId}`).join(', ') || 'none detected via liveness'}. ${leaderlessCount} leaderless partition(s).`,
            severity: 'critical',
            data: { deadBrokers, leaderlessCount, brokerLiveness },
          },
          {
            source: 'kafka_partition_status',
            observation: `${urpCount} under-replicated partition(s). Affected topics: ${[...new Set(urps.map((p) => p.topic))].join(', ') || 'none'}.`,
            severity: urpCount > 0 ? 'critical' : 'info',
            data: { urpCount, urps: urps.map((p) => ({ topic: p.topic, partition: p.partition, isr: p.isr, replicas: p.replicas })) },
          },
          {
            source: 'kafka_consumer_groups',
            observation: `${rebalancingGroups.length} consumer group(s) rebalancing. Max lag: ${maxLag.toLocaleString()}.`,
            severity: rebalancingGroups.length > 1 ? 'critical' : 'warning',
            data: { consumerGroups: consumerGroups.map((g) => ({ groupId: g.groupId, state: g.state, lag: g.lag })) },
          },
          {
            source: 'kafka_cluster_metadata',
            observation: `Cluster ${metadata.clusterId}: ${metadata.brokers.length} broker(s) registered, ${metadata.brokers.filter((b) => b.isAlive).length} alive. Controller: broker-${metadata.controllerId}.`,
            severity: 'info',
            data: { clusterId: metadata.clusterId, brokerCount: metadata.brokers.length },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    // Priority 2: Under-replicated partitions (no broker down)
    if (urpCount > 0) {
      return {
        status: 'identified',
        scenario: 'under_replicated_partitions',
        confidence: 0.93,
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
            severity: urpCount > 2 ? 'critical' : 'warning',
            data: { urpCount, urps: urps.map((p) => ({ topic: p.topic, partition: p.partition, isr: p.isr, replicas: p.replicas })) },
          },
          {
            source: 'kafka_consumer_lag',
            observation: `${consumerGroups.length} consumer group(s). Max lag: ${maxLag.toLocaleString()}. Groups in non-stable state: ${rebalancingGroups.length}.`,
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

    // Priority 3: Consumer lag cascade (no URPs)
    if (maxLag > 10_000) {
      return {
        status: 'identified',
        scenario: 'consumer_lag_cascade',
        confidence: 0.85,
        findings: [
          {
            source: 'kafka_consumer_lag',
            observation: `Consumer lag cascade detected. ${consumerGroups.length} group(s), max lag: ${maxLag.toLocaleString()}. All partitions are in-sync — issue is consumer-side.`,
            severity: 'critical',
            data: { consumerGroups: consumerGroups.map((g) => ({ groupId: g.groupId, state: g.state, lag: g.lag })) },
          },
          {
            source: 'kafka_broker_config',
            observation: `num.replica.fetchers=${brokerConfigs['num.replica.fetchers']}. Low fetcher count under heavy load can starve consumers.`,
            severity: Number(brokerConfigs['num.replica.fetchers'] ?? '1') <= 1 ? 'warning' : 'info',
            data: { brokerConfigs },
          },
          {
            source: 'kafka_cluster_metadata',
            observation: `Cluster ${metadata.clusterId}: ${metadata.brokers.length} broker(s), all healthy. ${metadata.partitionCount} partition(s), 0 under-replicated.`,
            severity: 'info',
            data: { clusterId: metadata.clusterId, brokerCount: metadata.brokers.length },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    // Priority 4: Partition leader imbalance (fallback)
    return {
      status: 'identified',
      scenario: 'partition_leader_imbalance',
      confidence: 0.80,
      findings: [
        {
          source: 'kafka_cluster_metadata',
          observation: `Cluster ${metadata.clusterId}: ${metadata.brokers.length} broker(s), ${metadata.topicCount} topic(s), ${metadata.partitionCount} partition(s). No critical issues detected — possible leader imbalance.`,
          severity: 'info',
          data: { clusterId: metadata.clusterId, brokerCount: metadata.brokers.length },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Plan routing
  // ---------------------------------------------------------------------------

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    switch (diagnosis.scenario) {
      case 'broker_down':
        return this.planBrokerDown(context, diagnosis);
      case 'consumer_lag_cascade':
        return this.planConsumerLagCascade(context, diagnosis);
      case 'under_replicated_partitions':
      default:
        return this.planUrp(context, diagnosis);
    }
  }

  // ---------------------------------------------------------------------------
  // Plan: Under-replicated partitions (original)
  // ---------------------------------------------------------------------------

  private planUrp(context: AgentContext, diagnosis: DiagnosisResult): RecoveryPlan {
    const instance = String(context.trigger.payload.instance || 'kafka-cluster');

    const steps: RecoveryStep[] = [
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
        outputCapture: { name: 'current_kafka_state', format: 'structured', availableTo: 'subsequent_steps' },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Kafka partition recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Kafka under-replicated partition recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[1]?.observation ?? ''}`,
          contextReferences: ['current_kafka_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture consumer offsets and partition assignments before mutations.',
        stateCaptures: [
          { name: 'consumer_offsets_snapshot', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'required' },
          { name: 'partition_assignments_snapshot', captureType: 'command_output', statement: 'topic_partitions --all', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
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
            check: { type: 'structured_command', statement: 'broker_count', expect: { operator: 'gte', value: 3 } },
          },
        ],
        statePreservation: {
          before: [{ name: 'partition_leaders_before', captureType: 'command_output', statement: 'topic_partitions --leaders', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'partition_leaders_after', captureType: 'command_output', statement: 'topic_partitions --leaders', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'Under-replicated partition count decreased',
          check: { type: 'structured_command', statement: 'under_replicated_count', expect: { operator: 'lt', value: 4 } },
        },
        rollback: { type: 'automatic', description: 'Leader election is safe; Kafka will re-elect leaders automatically on failure.' },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['producer-connections', 'consumer-connections'],
          maxImpact: 'brief_leader_migration',
          cascadeRisk: 'low',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
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
          before: [{ name: 'isr_state_before', captureType: 'command_output', statement: 'topic_partitions --isr', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'isr_state_after', captureType: 'command_output', statement: 'topic_partitions --isr', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        stateTransition: 'recovered',
        successCriteria: {
          description: 'All partitions are in-sync',
          check: { type: 'structured_command', statement: 'under_replicated_count', expect: { operator: 'eq', value: 0 } },
        },
        rollback: { type: 'manual', description: 'Cancel in-progress reassignment via kafka-reassign-partitions --cancel.' },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['inter-broker-replication'],
          maxImpact: 'increased_replication_traffic',
          cascadeRisk: 'medium',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess partition and lag state after reassignment',
        description: 'Check if ISR is fully rebuilt or if additional action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          { name: 'post_reassignment_state', captureType: 'command_output', statement: 'cluster_metadata --full', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Verify ISR health and notify or escalate',
        condition: {
          description: 'All partitions are in-sync (0 URPs)',
          check: { type: 'structured_command', statement: 'under_replicated_count', expect: { operator: 'eq', value: 0 } },
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
        affectedSystems: [{ identifier: instance, technology: 'kafka', role: 'cluster', impactType: 'brief_leader_migration_and_replication_traffic' }],
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

  // ---------------------------------------------------------------------------
  // Plan: Broker down
  // ---------------------------------------------------------------------------

  private planBrokerDown(context: AgentContext, diagnosis: DiagnosisResult): RecoveryPlan {
    const instance = String(context.trigger.payload.instance || 'kafka-cluster');

    const deadBrokerFinding = diagnosis.findings.find((f) => f.source === 'kafka_broker_liveness');
    const deadBrokerIds = (deadBrokerFinding?.data as { deadBrokers?: BrokerLiveness[] })?.deadBrokers?.map((b) => b.brokerId) ?? [];
    const deadBrokerLabel = deadBrokerIds.length > 0 ? deadBrokerIds.map((id) => `broker-${id}`).join(', ') : 'unknown broker';

    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture cluster state and broker liveness',
        executionContext: 'kafka_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'cluster_metadata',
          parameters: { includePartitions: true, includeConsumerGroups: true, includeLiveness: true },
        },
        outputCapture: { name: 'current_kafka_state', format: 'structured', availableTo: 'subsequent_steps' },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Alert on-call — broker offline',
        recipients: [
          { role: 'on_call_engineer', urgency: 'high' },
          { role: 'incident_commander', urgency: 'high' },
        ],
        message: {
          summary: `Kafka broker failure detected on ${instance}: ${deadBrokerLabel} unreachable`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation ?? ''}. Consumer groups are rebalancing.`,
          contextReferences: ['current_kafka_state'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture partition assignments and consumer offsets before mutations.',
        stateCaptures: [
          { name: 'partition_assignments_snapshot', captureType: 'command_output', statement: 'topic_partitions --all', captureCost: 'negligible', capturePolicy: 'required' },
          { name: 'consumer_offsets_snapshot', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Trigger unclean leader election for leaderless partitions',
        description: `Elect new leaders for partitions that lost leadership when ${deadBrokerLabel} went offline. Unclean election may cause minor data loss for uncommitted records.`,
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['broker.leader.elect'],
        command: {
          type: 'structured_command',
          operation: 'unclean_leader_elect',
          parameters: { scope: 'leaderless', deadBrokers: deadBrokerIds },
        },
        preConditions: [
          {
            description: 'At least 2 brokers are alive to accept leadership',
            check: { type: 'structured_command', statement: 'broker_count', expect: { operator: 'gte', value: 2 } },
          },
        ],
        statePreservation: {
          before: [{ name: 'partition_leaders_before_election', captureType: 'command_output', statement: 'topic_partitions --leaders', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'partition_leaders_after_election', captureType: 'command_output', statement: 'topic_partitions --leaders', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'No leaderless partitions remain',
          check: { type: 'structured_command', statement: 'leaderless_partition_count', expect: { operator: 'eq', value: 0 } },
        },
        rollback: { type: 'automatic', description: 'Kafka will re-elect leaders automatically when the dead broker returns.' },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['producer-connections', 'consumer-connections'],
          maxImpact: 'unclean_leader_election_minor_data_loss',
          cascadeRisk: 'medium',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      {
        stepId: 'step-005',
        type: 'human_approval',
        name: 'Approve partition reassignment away from dead broker',
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        timeout: 'PT15M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'engineering_lead',
          message: `Approval timeout reached for Kafka partition reassignment on ${instance}. ${deadBrokerLabel} is still offline.`,
        },
        presentation: {
          summary: `Reassign partitions from ${deadBrokerLabel} to surviving brokers`,
          detail: `${deadBrokerLabel} is unreachable. Partition reassignment will redistribute replicas to the remaining healthy brokers. This increases replication load on surviving brokers.`,
          proposedActions: [
            `Reassign all replicas currently assigned to ${deadBrokerLabel}`,
            'Rebalance partition distribution across surviving brokers',
            'Throttle replication to 50MB/s to limit impact',
            'Verify ISR convergence after reassignment',
          ],
          riskSummary: 'Increased replication traffic on surviving brokers. No additional data loss risk beyond initial broker failure.',
          alternatives: [
            { action: 'skip', description: 'Wait for the dead broker to return and let Kafka auto-recover. Risk: extended consumer lag.' },
            { action: 'abort', description: 'Abort recovery and escalate to engineering lead for manual intervention.' },
          ],
        },
      },
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Reassign partitions from dead broker to surviving brokers',
        description: `Redistribute partition replicas away from ${deadBrokerLabel} to healthy brokers.`,
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['broker.partition.reassign'],
        command: {
          type: 'structured_command',
          operation: 'partition_reassign',
          parameters: { strategy: 'exclude_brokers', excludeBrokers: deadBrokerIds, throttleBytes: 50_000_000 },
        },
        statePreservation: {
          before: [{ name: 'isr_state_before_reassign', captureType: 'command_output', statement: 'topic_partitions --isr', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'isr_state_after_reassign', captureType: 'command_output', statement: 'topic_partitions --isr', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        stateTransition: 'recovered',
        successCriteria: {
          description: 'All partitions are in-sync across surviving brokers',
          check: { type: 'structured_command', statement: 'under_replicated_count', expect: { operator: 'eq', value: 0 } },
        },
        rollback: { type: 'manual', description: 'Cancel in-progress reassignment via kafka-reassign-partitions --cancel.' },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['inter-broker-replication'],
          maxImpact: 'increased_replication_traffic',
          cascadeRisk: 'medium',
        },
        timeout: 'PT10M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Check broker return and consumer state',
        description: 'Assess whether the dead broker has come back online and if consumer groups have stabilized.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          { name: 'post_reassignment_state', captureType: 'command_output', statement: 'cluster_metadata --full', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
      {
        stepId: 'step-008',
        type: 'conditional',
        name: 'Check if dead broker returned',
        condition: {
          description: 'Dead broker is back online',
          check: { type: 'structured_command', statement: `broker_liveness:${deadBrokerIds[0] ?? 2}`, expect: { operator: 'eq', value: 1 } },
        },
        thenStep: {
          stepId: 'step-008a',
          type: 'human_notification',
          name: 'Broker returned — rebalance recommended',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `${deadBrokerLabel} is back online on ${instance}`,
            detail: 'The previously offline broker has returned. Consider running a preferred leader election to rebalance partition leadership.',
            contextReferences: ['post_reassignment_state'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-008b',
          type: 'human_notification',
          name: 'Broker still offline — monitor',
          recipients: [
            { role: 'on_call_engineer', urgency: 'high' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `${deadBrokerLabel} remains offline on ${instance}`,
            detail: 'Partitions have been reassigned to surviving brokers. Continue monitoring and investigate the offline broker.',
            contextReferences: ['post_reassignment_state'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      {
        stepId: 'step-009',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Kafka broker failure recovery completed on ${instance}`,
          detail: `Unclean leader election and partition reassignment executed for ${deadBrokerLabel}. ISR verified on surviving brokers. Monitor consumer lag convergence and broker health.`,
          contextReferences: ['post_reassignment_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'kafka-broker-down',
        agentName: 'kafka-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'broker_down',
        estimatedDuration: 'PT15M',
        summary: `Recover Kafka from broker failure on ${instance}: elect leaders for leaderless partitions, reassign replicas away from ${deadBrokerLabel}.`,
      }),
      impact: {
        affectedSystems: [{ identifier: instance, technology: 'kafka', role: 'cluster', impactType: 'broker_failure_partition_reassignment' }],
        affectedServices: ['messaging-layer', 'event-streaming'],
        estimatedUserImpact: 'Produce/consume unavailable on leaderless partitions until leader election completes. Elevated latency during reassignment. Possible minor data loss on uncommitted records.',
        dataLossRisk: 'low',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Leader election auto-recovers when broker returns. Partition reassignment can be cancelled mid-flight.',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Plan: Consumer lag cascade
  // ---------------------------------------------------------------------------

  private planConsumerLagCascade(context: AgentContext, diagnosis: DiagnosisResult): RecoveryPlan {
    const instance = String(context.trigger.payload.instance || 'kafka-cluster');

    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture cluster and consumer group state',
        executionContext: 'kafka_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'cluster_metadata',
          parameters: { includePartitions: true, includeConsumerGroups: true },
        },
        outputCapture: { name: 'current_kafka_state', format: 'structured', availableTo: 'subsequent_steps' },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Alert on-call — consumer lag cascade',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Kafka consumer lag cascade detected on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation ?? ''}`,
          contextReferences: ['current_kafka_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture consumer offsets before mutations.',
        stateCaptures: [
          { name: 'consumer_offsets_snapshot', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Increase replica fetcher threads',
        description: 'Increase num.replica.fetchers to improve broker-to-broker throughput and reduce fetch lag.',
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['broker.config.set'],
        command: {
          type: 'structured_command',
          operation: 'increase_replica_fetchers',
          parameters: { count: 4 },
        },
        statePreservation: {
          before: [{ name: 'broker_config_before', captureType: 'command_output', statement: 'broker_config --key=num.replica.fetchers', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'broker_config_after', captureType: 'command_output', statement: 'broker_config --key=num.replica.fetchers', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'Configuration updated successfully',
          check: { type: 'structured_command', statement: 'broker_count', expect: { operator: 'gte', value: 3 } },
        },
        rollback: { type: 'automatic', description: 'Revert num.replica.fetchers to previous value via config_set.' },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'increased_broker_thread_count',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Reset stuck consumer groups to latest offset',
        description: 'Reset consumer groups with extreme lag to the latest offset to allow them to resume processing current messages.',
        executionContext: 'kafka_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['consumer.group.reset'],
        command: {
          type: 'structured_command',
          operation: 'consumer_group_reset',
          parameters: { strategy: 'to_latest', scope: 'high_lag', lagThreshold: 100_000 },
        },
        preConditions: [
          {
            description: 'Consumer groups have elevated lag',
            check: { type: 'structured_command', statement: 'consumer_lag', expect: { operator: 'gt', value: 5_000 } },
          },
        ],
        statePreservation: {
          before: [{ name: 'consumer_offsets_before_reset', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'required', retention: 'P30D' }],
          after: [{ name: 'consumer_offsets_after_reset', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'best_effort', retention: 'P30D' }],
        },
        successCriteria: {
          description: 'Consumer lag reduced below 10000',
          check: { type: 'structured_command', statement: 'consumer_lag', expect: { operator: 'lt', value: 10_000 } },
        },
        rollback: { type: 'manual', description: 'Consumer group offsets cannot be automatically restored. Restore from captured consumer_offsets_before_reset if needed.' },
        blastRadius: {
          directComponents: ['consumer-groups'],
          indirectComponents: ['downstream-services'],
          maxImpact: 'skipped_messages_between_old_and_new_offset',
          cascadeRisk: 'medium',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Check lag reduction',
        description: 'Assess whether consumer lag is converging after fetcher increase and offset reset.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          { name: 'post_recovery_lag_state', captureType: 'command_output', statement: 'consumer_group_offsets --all', captureCost: 'negligible', capturePolicy: 'required' },
        ],
      },
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Verify lag resolution',
        condition: {
          description: 'Consumer lag is below 1000',
          check: { type: 'structured_command', statement: 'consumer_lag', expect: { operator: 'lt', value: 1_000 } },
        },
        thenStep: {
          stepId: 'step-007a',
          type: 'human_notification',
          name: 'Consumer lag resolved — notify team',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `Kafka consumer lag resolved on ${instance}`,
            detail: 'Consumer groups have caught up. Lag is within normal thresholds.',
            contextReferences: ['post_recovery_lag_state'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-007b',
          type: 'human_notification',
          name: 'Consumer lag persists — escalate',
          recipients: [
            { role: 'on_call_engineer', urgency: 'high' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `Kafka consumer lag persists on ${instance}`,
            detail: 'Consumer lag remains elevated after fetcher increase and offset reset. Investigate consumer application throughput and broker I/O.',
            contextReferences: ['post_recovery_lag_state'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Kafka consumer lag cascade recovery completed on ${instance}`,
          detail: 'Replica fetchers increased and high-lag consumer groups reset. Monitor lag convergence.',
          contextReferences: ['post_recovery_lag_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'kafka-lag-cascade',
        agentName: 'kafka-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'consumer_lag_cascade',
        estimatedDuration: 'PT8M',
        summary: `Recover Kafka from consumer lag cascade on ${instance}: increase fetcher throughput, reset stuck consumer groups.`,
      }),
      impact: {
        affectedSystems: [{ identifier: instance, technology: 'kafka', role: 'cluster', impactType: 'consumer_lag_recovery' }],
        affectedServices: ['messaging-layer', 'event-streaming'],
        estimatedUserImpact: 'Consumer groups reset to latest offset will skip unprocessed messages between the old and new offset positions.',
        dataLossRisk: 'low',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Fetcher config can be reverted. Consumer offset reset is not automatically reversible but offsets are captured before reset.',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Replan
  // ---------------------------------------------------------------------------

  async replan(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult> {
    this.backend.transition?.('recovering');

    const consumerGroups = await this.backend.getConsumerGroups();
    const instance = String(context.trigger.payload.instance || 'kafka-cluster');

    // After broker_down recovery: check if the dead broker came back
    if (diagnosis.scenario === 'broker_down') {
      const deadBrokerFinding = diagnosis.findings.find((f) => f.source === 'kafka_broker_liveness');
      const deadBrokerIds = (deadBrokerFinding?.data as { deadBrokers?: BrokerLiveness[] })?.deadBrokers?.map((b) => b.brokerId) ?? [2];

      const livenessChecks = await Promise.all(
        deadBrokerIds.map((id) => this.backend.getBrokerLiveness(id)),
      );
      const returnedBrokers = livenessChecks.filter((l) => l.reachable);

      if (returnedBrokers.length > 0) {
        const returnedLabel = returnedBrokers.map((b) => `broker-${b.brokerId}`).join(', ');
        return {
          action: 'revised_plan',
          plan: {
            ...createPlanEnvelope({
              planIdSuffix: 'kafka-broker-down',
              agentName: 'kafka-recovery',
              agentVersion: '1.0.0',
              scenario: 'broker_down',
              estimatedDuration: 'PT5M',
              summary: `Revised plan: ${returnedLabel} returned — rebalance partitions back to restored broker(s).`,
              sequence: 2,
              supersedes: executionState.completedSteps.length > 0 ? 'original' : null,
            }),
            impact: {
              affectedSystems: [{ identifier: instance, technology: 'kafka', role: 'cluster', impactType: 'partition_rebalance' }],
              affectedServices: ['messaging-layer'],
              estimatedUserImpact: 'Brief leader migrations during rebalance. No data loss.',
              dataLossRisk: 'none',
            },
            steps: [
              {
                stepId: 'step-007a',
                type: 'system_action',
                name: 'Rebalance partitions to include returned broker',
                description: `Redistribute partitions to include ${returnedLabel}.`,
                executionContext: 'kafka_admin',
                target: instance,
                riskLevel: 'routine',
                requiredCapabilities: ['broker.partition.reassign'],
                command: {
                  type: 'structured_command',
                  operation: 'partition_reassign',
                  parameters: { strategy: 'balanced', throttleBytes: 50_000_000 },
                },
                statePreservation: { before: [], after: [] },
                successCriteria: {
                  description: 'Partitions balanced across all brokers',
                  check: { type: 'structured_command', statement: 'under_replicated_count', expect: { operator: 'eq', value: 0 } },
                },
                rollback: { type: 'automatic', description: 'Rebalance can be cancelled.' },
                blastRadius: {
                  directComponents: [instance],
                  indirectComponents: ['inter-broker-replication'],
                  maxImpact: 'increased_replication_traffic',
                  cascadeRisk: 'low',
                },
                timeout: 'PT5M',
                retryPolicy: { maxRetries: 1, retryable: true },
              },
            ],
            rollbackStrategy: {
              type: 'stepwise',
              description: 'Rebalance can be cancelled mid-flight.',
            },
          },
        };
      }
    }

    // After any plan: check for stuck consumer groups
    const stuckGroups = consumerGroups.filter(
      (g) => g.state === 'PreparingRebalance' || g.state === 'CompletingRebalance',
    );

    if (stuckGroups.length > 0) {
      return {
        action: 'revised_plan',
        plan: {
          ...createPlanEnvelope({
            planIdSuffix: 'kafka-group-reset',
            agentName: 'kafka-recovery',
            agentVersion: '1.0.0',
            scenario: diagnosis.scenario ?? 'consumer_lag_cascade',
            estimatedDuration: 'PT3M',
            summary: `Revised plan: ${stuckGroups.length} consumer group(s) stuck in rebalance — reset to recover.`,
            sequence: 2,
            supersedes: executionState.completedSteps.length > 0 ? 'original' : null,
          }),
          impact: {
            affectedSystems: [{ identifier: instance, technology: 'kafka', role: 'cluster', impactType: 'consumer_group_reset' }],
            affectedServices: ['messaging-layer'],
            estimatedUserImpact: 'Stuck consumer groups will be reset. Some messages may be reprocessed.',
            dataLossRisk: 'none',
          },
          steps: stuckGroups.map((group, idx) => ({
            stepId: `step-replan-${idx + 1}`,
            type: 'system_action' as const,
            name: `Reset stuck consumer group: ${group.groupId}`,
            description: `Consumer group '${group.groupId}' is stuck in ${group.state}. Reset to resume consumption.`,
            executionContext: 'kafka_admin',
            target: instance,
            riskLevel: 'elevated' as const,
            requiredCapabilities: ['consumer.group.reset'],
            command: {
              type: 'structured_command' as const,
              operation: 'consumer_group_reset',
              parameters: { groupId: group.groupId, strategy: 'to_latest' },
            },
            statePreservation: { before: [], after: [] },
            successCriteria: {
              description: `Consumer group ${group.groupId} is stable`,
              check: { type: 'structured_command' as const, statement: 'consumer_group_rebalancing_count', expect: { operator: 'lt' as const, value: stuckGroups.length } },
            },
            rollback: { type: 'manual' as const, description: 'Consumer offsets cannot be automatically restored.' },
            blastRadius: {
              directComponents: [group.groupId],
              indirectComponents: ['downstream-services'],
              maxImpact: 'consumer_offset_reset',
              cascadeRisk: 'low',
            },
            timeout: 'PT30S',
            retryPolicy: { maxRetries: 0, retryable: false },
          })),
          rollbackStrategy: {
            type: 'stepwise',
            description: 'Consumer offset resets are not automatically reversible.',
          },
        },
      };
    }

    return { action: 'continue' };
  }
}
