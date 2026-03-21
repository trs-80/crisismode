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
import { etcdRecoveryManifest } from './manifest.js';
import type { EtcdBackend } from './backend.js';
import { EtcdSimulator } from './simulator.js';

export class EtcdRecoveryAgent implements RecoveryAgent {
  manifest = etcdRecoveryManifest;
  backend: EtcdBackend;

  constructor(backend?: EtcdBackend) {
    this.backend = backend ?? new EtcdSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const health = await this.backend.getClusterHealth();
    const alarms = await this.backend.getAlarmList();
    const endpoints = await this.backend.getEndpointStatus();

    const hasAlarms = alarms.length > 0;
    const highRaftTerm = health.raftTerm > 100;
    const hasErrors = endpoints.some((ep) => ep.errors.length > 0);

    // Check for storage fragmentation: dbSize much larger than dbSizeInUse
    const maxFragmentation = Math.max(
      0,
      ...endpoints.map((ep) => (ep.dbSizeInUse > 0 ? ep.dbSize / ep.dbSizeInUse : 1)),
    );
    const fragmented = maxFragmentation > 1.5;

    const status: HealthStatus = !health.healthy || hasAlarms
      ? 'unhealthy'
      : highRaftTerm || fragmented || hasErrors
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'etcd_cluster_health',
        status: signalStatus(!health.healthy, highRaftTerm),
        detail: `Cluster healthy: ${health.healthy}. Members: ${health.members}. Leader: ${health.leader}. Raft term: ${health.raftTerm}${highRaftTerm ? ' (high — indicates election instability)' : ''}.`,
        observedAt,
      },
      {
        source: 'etcd_alarms',
        status: signalStatus(hasAlarms),
        detail: hasAlarms
          ? `Active alarms: ${alarms.map((a) => `${a.alarm} on ${a.memberID}`).join(', ')}.`
          : 'No active alarms.',
        observedAt,
      },
      {
        source: 'etcd_storage',
        status: signalStatus(false, fragmented),
        detail: `Max storage fragmentation ratio: ${maxFragmentation.toFixed(1)}x. ${endpoints.length} endpoint(s) reporting.`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'Etcd cluster is healthy. All members are operational, no alarms, and storage fragmentation is within normal bounds.',
        recovering: 'Etcd cluster is recovering. Some indicators (raft term, fragmentation, or endpoint errors) are still above healthy thresholds.',
        unhealthy: 'Etcd cluster is unhealthy. Cluster reports degraded health or active alarms requiring intervention.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring etcd cluster health and raft term stability.'],
        recovering: ['Continue monitoring until raft term stabilizes and storage fragmentation decreases to normal levels.'],
        unhealthy: ['Run the etcd recovery workflow in dry-run mode to determine the next safe mitigation step.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const health = await this.backend.getClusterHealth();
    const members = await this.backend.getMemberList();
    const alarms = await this.backend.getAlarmList();
    const endpoints = await this.backend.getEndpointStatus();

    const scenario = health.raftTerm > 100
      ? 'leader_election_loop'
      : members.length !== 3
        ? 'member_thrashing'
        : alarms.some((a) => a.alarm === 'CORRUPT')
          ? 'snapshot_corruption'
          : 'disk_latency_degradation';

    const confidence = health.raftTerm > 100 && alarms.length > 0 ? 0.93 : 0.80;

    const maxFragmentation = Math.max(
      0,
      ...endpoints.map((ep) => (ep.dbSizeInUse > 0 ? ep.dbSize / ep.dbSizeInUse : 1)),
    );
    const errorEndpoints = endpoints.filter((ep) => ep.errors.length > 0);

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'etcd_cluster_health',
          observation: `Cluster healthy: ${health.healthy}. Leader: ${health.leader}. Raft term: ${health.raftTerm}. Members: ${health.members}.`,
          severity: !health.healthy ? 'critical' : health.raftTerm > 100 ? 'warning' : 'info',
          data: { healthy: health.healthy, leader: health.leader, raftTerm: health.raftTerm, members: health.members },
        },
        {
          source: 'etcd_member_list',
          observation: `${members.length} member(s) in cluster: ${members.map((m) => m.name).join(', ')}.`,
          severity: members.length < 3 ? 'warning' : 'info',
          data: { members },
        },
        {
          source: 'etcd_alarms',
          observation: alarms.length > 0
            ? `${alarms.length} active alarm(s): ${alarms.map((a) => `${a.alarm} on ${a.memberID}`).join(', ')}.`
            : 'No active alarms.',
          severity: alarms.length > 0 ? 'critical' : 'info',
          data: { alarms },
        },
        {
          source: 'etcd_endpoint_status',
          observation: `${endpoints.length} endpoint(s). Max fragmentation ratio: ${maxFragmentation.toFixed(1)}x. ${errorEndpoints.length} endpoint(s) with errors.`,
          severity: errorEndpoints.length > 0 ? 'warning' : 'info',
          data: { endpoints, maxFragmentation, errorEndpoints: errorEndpoints.length },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const instance = String(context.trigger.payload.instance || 'etcd-cluster');

    const steps: RecoveryStep[] = [
      // Step 1: Capture cluster state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture etcd cluster state',
        executionContext: 'etcd_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'member_status',
          parameters: { sections: ['health', 'members', 'alarms', 'endpoints'] },
        },
        outputCapture: {
          name: 'current_etcd_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of etcd cluster recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Etcd cluster recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_etcd_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Snapshot cluster state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture etcd cluster state and member list before mutations.',
        stateCaptures: [
          {
            name: 'etcd_member_snapshot',
            captureType: 'command_output',
            statement: 'etcdctl member list',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'etcd_endpoint_snapshot',
            captureType: 'command_output',
            statement: 'etcdctl endpoint status',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Approve member removal
      {
        stepId: 'step-004',
        type: 'human_approval',
        name: 'Approve problematic member removal',
        description: 'Removing a member from the etcd cluster is a high-risk operation that reduces quorum capacity.',
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `Ready to remove problematic member from ${instance}`,
          detail: `Etcd member causing ${diagnosis.scenario}. Removal required to restore cluster stability. This will temporarily reduce the cluster to 2 members.`,
          contextReferences: ['current_etcd_state'],
          proposedActions: [
            'Remove problematic member (member-2) from the cluster',
            'Defragment remaining members to reclaim disk space',
            'Re-add member with clean data directory',
          ],
          riskSummary: 'High risk — reduces quorum capacity during member replacement. kube-apiserver may experience brief latency.',
          alternatives: [
            {
              action: 'skip',
              description: 'Wait for the member to self-heal. Election loop may continue.',
            },
            {
              action: 'abort',
              description: 'Abort recovery. Restart affected member pod manually instead.',
            },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'escalate',
      },
      // Step 5: Remove problematic member
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Remove problematic member from cluster',
        description: 'Remove the member causing election instability or NOSPACE alarm to restore cluster quorum.',
        executionContext: 'etcd_admin',
        target: instance,
        riskLevel: 'high',
        requiredCapabilities: ['consensus.member.remove'],
        stateTransition: 'recovering',
        command: {
          type: 'structured_command',
          operation: 'member_remove',
          parameters: { memberId: 'member-2' },
        },
        preConditions: [
          {
            description: 'Cluster has quorum (at least 2 of 3 members healthy)',
            check: {
              type: 'structured_command',
              statement: 'cluster_size',
              expect: { operator: 'gte', value: 2 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'member_list_before_removal',
              captureType: 'command_output',
              statement: 'etcdctl member list',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'member_list_after_removal',
              captureType: 'command_output',
              statement: 'etcdctl member list',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Cluster size reduced to 2 members',
          check: {
            type: 'structured_command',
            statement: 'cluster_size',
            expect: { operator: 'eq', value: 2 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Re-add the removed member via etcdctl member add with original peer URLs.',
        },
        blastRadius: {
          directComponents: [instance, 'member-2'],
          indirectComponents: ['kube-apiserver'],
          maxImpact: 'reduced_quorum_capacity',
          cascadeRisk: 'medium',
        },
        timeout: 'PT1M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 6: Defrag remaining members
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Defragment remaining cluster members',
        description: 'Run defragmentation on remaining members to reclaim disk space and reduce DB size.',
        executionContext: 'etcd_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['consensus.defrag'],
        command: {
          type: 'structured_command',
          operation: 'defrag',
          parameters: { endpoints: ['etcd-0', 'etcd-1'] },
        },
        statePreservation: {
          before: [
            {
              name: 'endpoint_status_before_defrag',
              captureType: 'command_output',
              statement: 'etcdctl endpoint status',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'endpoint_status_after_defrag',
              captureType: 'command_output',
              statement: 'etcdctl endpoint status',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'No alarms active after defragmentation',
          check: {
            type: 'structured_command',
            statement: 'alarm_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Defragmentation is safe — no rollback needed. If it fails, the member continues with fragmented storage.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'brief_latency_spike_during_defrag',
          cascadeRisk: 'low',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 7: Add member back
      {
        stepId: 'step-007',
        type: 'system_action',
        name: 'Add member back to cluster',
        description: 'Re-add the previously removed member with a clean data directory to restore full quorum.',
        executionContext: 'etcd_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['consensus.member.add'],
        stateTransition: 'recovered',
        command: {
          type: 'structured_command',
          operation: 'member_add',
          parameters: { memberId: 'member-2', peerURLs: ['https://etcd-2.etcd:2380'] },
        },
        statePreservation: {
          before: [
            {
              name: 'member_list_before_add',
              captureType: 'command_output',
              statement: 'etcdctl member list',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'member_list_after_add',
              captureType: 'command_output',
              statement: 'etcdctl member list',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Cluster restored to 3 members',
          check: {
            type: 'structured_command',
            statement: 'cluster_size',
            expect: { operator: 'eq', value: 3 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Remove the newly added member if it fails to join properly.',
        },
        blastRadius: {
          directComponents: [instance, 'member-2'],
          indirectComponents: ['kube-apiserver'],
          maxImpact: 'member_join_data_sync',
          cascadeRisk: 'low',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 8: Replanning checkpoint
      {
        stepId: 'step-008',
        type: 'replanning_checkpoint',
        name: 'Verify cluster health after recovery',
        description: 'Check if the etcd cluster is fully recovered or if additional intervention is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_cluster_health',
            captureType: 'command_output',
            statement: 'etcdctl endpoint health',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 9: Recovery summary
      {
        stepId: 'step-009',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'platform_lead', urgency: 'medium' },
        ],
        message: {
          summary: `Etcd cluster recovery completed on ${instance}`,
          detail: 'Problematic member removed, remaining members defragmented, member re-added with clean state. Monitor raft term stability and endpoint health.',
          contextReferences: ['post_recovery_cluster_health'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'etcd-rec',
        agentName: 'etcd-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'leader_election_loop',
        estimatedDuration: 'PT10M',
        summary: `Recover etcd cluster on ${instance}: remove problematic member, defragment, re-add with clean state.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'etcd',
            role: 'cluster',
            impactType: 'reduced_quorum_during_member_replacement',
          },
        ],
        affectedServices: ['kube-apiserver', 'kubernetes-control-plane'],
        estimatedUserImpact: 'Brief period of reduced quorum capacity during member removal and re-addition. No data loss expected.',
        dataLossRisk: 'low',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each step is independently reversible. Member removal can be rolled back by re-adding the member. Defragmentation has no rollback needed.',
      },
    };
  }

  replan = defaultReplan;
}
