// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { cephRecoveryManifest } from './manifest.js';
import type { CephBackend } from './backend.js';
import { CephSimulator } from './simulator.js';

export class CephRecoveryAgent implements RecoveryAgent {
  manifest = cephRecoveryManifest;
  backend: CephBackend;

  constructor(backend?: CephBackend) {
    this.backend = backend ?? new CephSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const cluster = await this.backend.getClusterStatus();
    const osds = await this.backend.getOSDTree();
    const pools = await this.backend.getPoolStats();

    const downOSDs = osds.filter((o) => o.status === 'down').length;
    const maxPoolUsage = Math.max(0, ...pools.map((p) => p.percentUsed));

    const clusterCritical = cluster.health === 'HEALTH_ERR';
    const clusterWarning = cluster.health === 'HEALTH_WARN';
    const osdCritical = downOSDs > 1;
    const osdWarning = downOSDs > 0;
    const pgCritical = cluster.pgDegraded > 20;
    const pgWarning = cluster.pgDegraded > 0;
    const poolCritical = maxPoolUsage > 85;
    const poolWarning = maxPoolUsage > 75;

    const status = clusterCritical || osdCritical || pgCritical
      ? 'unhealthy'
      : clusterWarning || osdWarning || pgWarning || poolWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'ceph_cluster_health',
        status: clusterCritical ? 'critical' : clusterWarning ? 'warning' : 'healthy',
        detail: `Cluster health is ${cluster.health}. ${cluster.monCount} monitors, ${cluster.osdUp}/${cluster.osdCount} OSDs up.`,
        observedAt,
      },
      {
        source: 'ceph_osd_status',
        status: osdCritical ? 'critical' : osdWarning ? 'warning' : 'healthy',
        detail: `${downOSDs} OSD(s) down out of ${cluster.osdCount} total. ${cluster.osdIn} in cluster.`,
        observedAt,
      },
      {
        source: 'ceph_pg_status',
        status: pgCritical ? 'critical' : pgWarning ? 'warning' : 'healthy',
        detail: `${cluster.pgDegraded} degraded PG(s), ${cluster.pgRecovering} recovering out of ${cluster.pgCount} total.`,
        observedAt,
      },
      {
        source: 'ceph_pool_usage',
        status: poolCritical ? 'critical' : poolWarning ? 'warning' : 'healthy',
        detail: `Highest pool usage is ${maxPoolUsage.toFixed(1)}%. Cluster usage is ${cluster.usagePercent.toFixed(1)}%.`,
        observedAt,
      },
    ];

    const summary = status === 'healthy'
      ? 'Ceph cluster is healthy. All OSDs are up, PGs are clean, and pool usage is within normal thresholds.'
      : status === 'recovering'
        ? 'Ceph cluster is recovering. Some signals are improved but at least one indicator is still above the healthy target.'
        : 'Ceph cluster is unhealthy. OSD failures, degraded PGs, or pool capacity require immediate action.';

    const recommendedActions = status === 'healthy'
      ? ['No action required. Continue monitoring Ceph cluster health and capacity.']
      : status === 'recovering'
        ? ['Continue monitoring until all OSDs are up, PGs are clean, and pool usage returns to healthy thresholds.']
        : ['Run the Ceph recovery workflow in dry-run mode to determine the next safe mitigation step.'];

    return {
      status,
      confidence: 0.95,
      summary,
      observedAt,
      signals,
      recommendedActions,
    };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const cluster = await this.backend.getClusterStatus();
    const osds = await this.backend.getOSDTree();
    const pools = await this.backend.getPoolStats();
    const health = await this.backend.getHealthDetail();

    const downOSDs = osds.filter((o) => o.status === 'down');
    const maxPoolUsage = Math.max(0, ...pools.map((p) => p.percentUsed));

    const scenario = downOSDs.length > 0
      ? 'osd_down_cascade'
      : cluster.pgDegraded > 0
        ? 'pg_degraded'
        : maxPoolUsage > 85
          ? 'pool_nearfull'
          : 'osd_down_cascade';

    const confidence = downOSDs.length > 1 && cluster.pgDegraded > 20 ? 0.95 : 0.82;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'ceph_cluster_health',
          observation: `Cluster health: ${cluster.health}. ${cluster.monCount} monitors, ${cluster.osdUp}/${cluster.osdCount} OSDs up, ${cluster.osdIn} in cluster.`,
          severity: cluster.health === 'HEALTH_ERR' ? 'critical' : cluster.health === 'HEALTH_WARN' ? 'warning' : 'info',
          data: { health: cluster.health, monCount: cluster.monCount, osdUp: cluster.osdUp, osdCount: cluster.osdCount },
        },
        {
          source: 'ceph_osd_status',
          observation: downOSDs.length > 0
            ? `${downOSDs.length} OSD(s) down: ${downOSDs.map((o) => `${o.name} on ${o.host}`).join(', ')}.`
            : 'All OSDs are up.',
          severity: downOSDs.length > 1 ? 'critical' : downOSDs.length > 0 ? 'warning' : 'info',
          data: { downOSDs: downOSDs.map((o) => ({ id: o.id, name: o.name, host: o.host })) },
        },
        {
          source: 'ceph_pg_status',
          observation: `${cluster.pgDegraded} degraded PG(s), ${cluster.pgRecovering} recovering out of ${cluster.pgCount} total.`,
          severity: cluster.pgDegraded > 20 ? 'critical' : cluster.pgDegraded > 0 ? 'warning' : 'info',
          data: { pgDegraded: cluster.pgDegraded, pgRecovering: cluster.pgRecovering, pgTotal: cluster.pgCount },
        },
        {
          source: 'ceph_pool_usage',
          observation: pools.map((p) => `Pool ${p.name}: ${p.percentUsed.toFixed(1)}% used`).join('. ') + '.',
          severity: maxPoolUsage > 85 ? 'critical' : maxPoolUsage > 75 ? 'warning' : 'info',
          data: { pools: pools.map((p) => ({ name: p.name, percentUsed: p.percentUsed })) },
        },
        {
          source: 'ceph_health_detail',
          observation: health.checks.length > 0
            ? `Health checks: ${health.checks.map((c) => `${c.type} (${c.severity}): ${c.summary}`).join('; ')}.`
            : 'No active health checks.',
          severity: health.checks.some((c) => c.severity === 'HEALTH_ERR') ? 'critical' : health.checks.length > 0 ? 'warning' : 'info',
          data: { checks: health.checks },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const now = new Date().toISOString();
    const cluster = String(context.trigger.payload.instance || 'ceph-cluster-01');

    const steps: RecoveryStep[] = [
      // Step 1: Capture cluster state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture Ceph cluster state',
        executionContext: 'ceph_read',
        target: cluster,
        command: {
          type: 'structured_command',
          operation: 'cluster_status',
          parameters: { sections: ['health', 'osd', 'pg', 'pool'] },
        },
        outputCapture: {
          name: 'current_cluster_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Ceph storage recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Ceph storage recovery initiated on ${cluster}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_cluster_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture OSD tree and PG state before mutations.',
        stateCaptures: [
          {
            name: 'osd_tree_snapshot',
            captureType: 'command_output',
            statement: 'ceph osd tree',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'pg_state_snapshot',
            captureType: 'command_output',
            statement: 'ceph pg dump',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Human approval for OSD operations
      {
        stepId: 'step-004',
        type: 'human_approval',
        name: 'Approve OSD recovery operations',
        description: 'High-risk OSD operations require explicit approval before proceeding.',
        approvers: [
          { role: 'on_call_engineer', required: true },
          { role: 'storage_lead', required: false },
        ],
        requiredApprovals: 1,
        presentation: {
          summary: `Ready to perform OSD recovery on ${cluster}`,
          detail: `Scenario: ${diagnosis.scenario}. Plan will reweight osd.3, remove osd.5, and repair degraded PGs.`,
          contextReferences: ['current_cluster_state', 'osd_tree_snapshot'],
          proposedActions: [
            'Reweight osd.3 to 0.5 to redistribute data',
            'Remove osd.5 permanently from the CRUSH map',
            'Repair all degraded placement groups',
          ],
          riskSummary: 'High — OSD rebalancing will increase I/O load. OSD removal is irreversible without re-adding.',
          alternatives: [
            { action: 'wait', description: 'Wait for OSDs to self-recover. Degraded PGs will persist.' },
            { action: 'abort', description: 'Abort recovery and investigate storage nodes manually.' },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'engineering_director',
          message: `OSD recovery approval for ${cluster} timed out. Escalating to engineering director.`,
        },
      },
      // Step 5: Reweight failing OSD
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Reweight failing OSD to redistribute data',
        description: 'Gradually reduce the weight of the failing OSD to trigger data rebalancing across healthy OSDs.',
        executionContext: 'ceph_admin',
        target: cluster,
        riskLevel: 'high',
        requiredCapabilities: ['storage.osd.reweight'],
        command: {
          type: 'structured_command',
          operation: 'osd_reweight',
          parameters: { osd: 'osd.3', weight: 0.5 },
        },
        preConditions: [
          {
            description: 'Cluster is accessible and monitors are quorate',
            check: {
              type: 'structured_command',
              statement: 'cluster_health',
              expect: { operator: 'neq', value: 'UNREACHABLE' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'osd_weights_before_reweight',
              captureType: 'command_output',
              statement: 'ceph osd tree',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'osd_weights_after_reweight',
              captureType: 'command_output',
              statement: 'ceph osd tree',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'OSD reweight accepted and rebalancing started',
          check: {
            type: 'structured_command',
            statement: 'osd_up_count',
            expect: { operator: 'gte', value: 5 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Restore original OSD weight via ceph osd reweight.',
        },
        blastRadius: {
          directComponents: [cluster, 'osd.3'],
          indirectComponents: ['rbd-pool', 'cephfs-pool'],
          maxImpact: 'data_rebalancing_across_osds',
          cascadeRisk: 'medium',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Remove dead OSD
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Remove permanently failed OSD from cluster',
        description: 'Mark the unrecoverable OSD as out and remove it from the CRUSH map to prevent further degradation.',
        executionContext: 'ceph_admin',
        target: cluster,
        riskLevel: 'high',
        requiredCapabilities: ['storage.osd.remove'],
        command: {
          type: 'structured_command',
          operation: 'osd_remove',
          parameters: { osd: 'osd.5', purge: true },
        },
        preConditions: [
          {
            description: 'OSD is confirmed down',
            check: {
              type: 'structured_command',
              statement: 'osd_up_count',
              expect: { operator: 'lt', value: 6 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'osd_map_before_remove',
              captureType: 'command_output',
              statement: 'ceph osd tree',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'osd_map_after_remove',
              captureType: 'command_output',
              statement: 'ceph osd tree',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'OSD removed from cluster map',
          check: {
            type: 'structured_command',
            statement: 'osd_up_count',
            expect: { operator: 'gte', value: 4 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Re-add OSD to cluster via ceph osd create and CRUSH map update.',
        },
        blastRadius: {
          directComponents: [cluster, 'osd.5'],
          indirectComponents: ['rbd-pool', 'cephfs-pool'],
          maxImpact: 'osd_permanently_removed',
          cascadeRisk: 'medium',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 7: Repair degraded PGs
      {
        stepId: 'step-007',
        type: 'system_action',
        name: 'Repair degraded placement groups',
        description: 'Trigger PG repair to restore data redundancy after OSD rebalancing.',
        executionContext: 'ceph_admin',
        target: cluster,
        riskLevel: 'elevated',
        requiredCapabilities: ['storage.pg.repair'],
        command: {
          type: 'structured_command',
          operation: 'pg_repair',
          parameters: { scope: 'all_degraded' },
        },
        preConditions: [
          {
            description: 'Rebalancing is in progress or complete',
            check: {
              type: 'structured_command',
              statement: 'pg_degraded_count',
              expect: { operator: 'lte', value: 50 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'pg_state_before_repair',
              captureType: 'command_output',
              statement: 'ceph pg dump',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'pg_state_after_repair',
              captureType: 'command_output',
              statement: 'ceph pg dump',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovered',
        successCriteria: {
          description: 'No degraded PGs remaining',
          check: {
            type: 'structured_command',
            statement: 'pg_degraded_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'PG repair is idempotent. Re-run if interrupted.',
        },
        blastRadius: {
          directComponents: [cluster],
          indirectComponents: ['rbd-pool', 'cephfs-pool'],
          maxImpact: 'increased_io_during_repair',
          cascadeRisk: 'low',
        },
        timeout: 'PT10M',
        retryPolicy: { maxRetries: 2, retryable: true },
      },
      // Step 8: Replanning checkpoint
      {
        stepId: 'step-008',
        type: 'replanning_checkpoint',
        name: 'Verify cluster health after recovery',
        description: 'Check if the cluster has returned to a healthy state or if further action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_cluster_state',
            captureType: 'command_output',
            statement: 'ceph status',
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
          { role: 'storage_lead', urgency: 'medium' },
        ],
        message: {
          summary: `Ceph storage recovery completed on ${cluster}`,
          detail: 'Failing OSDs reweighted/removed, degraded PGs repaired, cluster health restored. Monitor OSD utilization and PG distribution.',
          contextReferences: ['post_recovery_cluster_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: `rp-${now.replace(/[-:T]/g, '').slice(0, 14)}-ceph-osd-001`,
        agentName: 'ceph-storage-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'osd_down_cascade',
        createdAt: now,
        estimatedDuration: 'PT15M',
        summary: `Recover Ceph cluster from OSD failures on ${cluster}: reweight failing OSD, remove dead OSD, repair degraded PGs.`,
        supersedes: null,
      },
      impact: {
        affectedSystems: [
          {
            identifier: cluster,
            technology: 'ceph',
            role: 'storage_cluster',
            impactType: 'data_rebalancing_and_pg_repair',
          },
        ],
        affectedServices: ['block-storage', 'cephfs'],
        estimatedUserImpact: 'Temporary increase in I/O latency during OSD rebalancing and PG repair. No data loss if replication factor is maintained.',
        dataLossRisk: 'low',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'OSD reweight can be reversed. OSD removal requires re-adding the OSD. PG repair is idempotent.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return { action: 'continue' };
  }
}
