// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult, DiagnosisFinding } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { awsRdsRecoveryManifest } from './manifest.js';
import { isPermissionMissing } from './backend.js';
import type { RdsRecoveryBackend } from './backend.js';
import { RdsRecoverySimulator } from './simulator.js';

const TWO_GIB_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A single control-plane observation (instance status, storage, connection
 * saturation, security group, events, or a skipped IAM-gated check). Shared
 * shape that assessHealth() renders as a HealthSignal and diagnose() renders
 * as a DiagnosisFinding, so the two never drift from each other.
 */
interface ControlPlaneItem {
  source: string;
  message: string;
  critical: boolean;
  warning: boolean;
  isPermissionMissing: boolean;
  data?: Record<string, unknown>;
}

export class AwsRdsRecoveryAgent implements RecoveryAgent {
  manifest = awsRdsRecoveryManifest;
  backend: RdsRecoveryBackend;

  constructor(backend?: RdsRecoveryBackend) {
    this.backend = backend ?? new RdsRecoverySimulator();
  }

  /**
   * Queries the four control-plane backend methods (instance health, recent
   * events, live metrics, port reachability) and derives one ControlPlaneItem
   * per observation. Any call gated by a missing IAM permission becomes a
   * single 'rds_iam_permissions' item instead of the domain item it would
   * otherwise have produced.
   */
  private async gatherControlPlaneItems(): Promise<ControlPlaneItem[]> {
    const [instanceHealthR, eventsR, metricsR, portR] = await Promise.all([
      this.backend.getInstanceHealth(),
      this.backend.getRecentEvents(24),
      this.backend.getLiveMetrics(),
      this.backend.getPortReachability(),
    ]);

    const items: ControlPlaneItem[] = [];
    const iamItem = (action: string): ControlPlaneItem => ({
      source: 'rds_iam_permissions',
      message: `AWS check skipped — missing ${action}`,
      critical: false,
      warning: false,
      isPermissionMissing: true,
    });

    const instanceHealth = isPermissionMissing(instanceHealthR) ? null : instanceHealthR;
    const instanceStatusFull = instanceHealth?.status === 'storage-full';

    // rds_instance_status
    if (isPermissionMissing(instanceHealthR)) {
      items.push(iamItem(instanceHealthR.permissionMissing));
    } else {
      const statusCritical = instanceHealthR.status !== 'available';
      items.push({
        source: 'rds_instance_status',
        message: statusCritical
          ? `RDS instance status is '${instanceHealthR.status}'${instanceStatusFull ? ' — storage is full' : ''}`
          : `RDS instance status is '${instanceHealthR.status}'`,
        critical: statusCritical,
        warning: false,
        isPermissionMissing: false,
        data: {
          instanceId: instanceHealthR.instanceId,
          status: instanceHealthR.status,
          instanceClass: instanceHealthR.instanceClass,
          allocatedStorageGb: instanceHealthR.allocatedStorageGb,
          pendingModifications: instanceHealthR.pendingModifications,
          vpcSecurityGroupIds: instanceHealthR.vpcSecurityGroupIds,
          endpointPort: instanceHealthR.endpointPort,
        },
      });
    }

    // rds_events
    if (isPermissionMissing(eventsR)) {
      items.push(iamItem(eventsR.permissionMissing));
    } else {
      const notable = eventsR.filter((e) => /failure|failover|low storage/i.test(e.category));
      for (const event of notable) {
        items.push({
          source: 'rds_events',
          message: event.message,
          critical: false,
          warning: true,
          isPermissionMissing: false,
          data: { at: event.at, category: event.category },
        });
      }
    }

    // rds_storage + rds_connection_saturation (both derived from live metrics)
    if (isPermissionMissing(metricsR)) {
      items.push(iamItem(metricsR.permissionMissing));
    } else {
      const freeBytes = metricsR.freeStorageBytes;
      const storageLow = freeBytes !== null && freeBytes < TWO_GIB_BYTES;
      const storageCritical = instanceStatusFull || storageLow;
      const freeGiB = freeBytes !== null ? (freeBytes / (1024 * 1024 * 1024)).toFixed(1) : null;
      items.push({
        source: 'rds_storage',
        message: storageCritical
          ? instanceStatusFull
            ? `RDS storage is full on instance ${instanceHealth?.instanceId ?? 'unknown-instance'}.`
            : `RDS free storage is critically low (${freeGiB} GiB free) — storage is nearly full.`
          : freeGiB !== null
            ? `RDS free storage is ${freeGiB} GiB.`
            : 'RDS storage metrics unavailable.',
        critical: storageCritical,
        warning: false,
        isPermissionMissing: false,
        data: {
          instanceId: instanceHealth?.instanceId,
          freeStorageBytes: freeBytes,
          allocatedStorageGb: instanceHealth?.allocatedStorageGb,
        },
      });

      const conn = metricsR.databaseConnections;
      const maxConn = metricsR.approxMaxConnections;
      if (conn !== null && maxConn !== null && maxConn > 0) {
        const ratio = conn / maxConn;
        const saturationCritical = ratio > 0.95;
        const saturationWarning = ratio > 0.85;
        items.push({
          source: 'rds_connection_saturation',
          message: `${conn} of ~${maxConn} connections in use (${Math.round(ratio * 100)}%).`,
          critical: saturationCritical,
          warning: saturationWarning && !saturationCritical,
          isPermissionMissing: false,
          data: {
            instanceId: instanceHealth?.instanceId,
            databaseConnections: conn,
            approxMaxConnections: maxConn,
          },
        });
      }
    }

    // rds_security_group
    if (isPermissionMissing(portR)) {
      items.push(iamItem(portR.permissionMissing));
    } else {
      const blocked = portR.openTo.length === 0;
      items.push({
        source: 'rds_security_group',
        message: blocked
          ? `Security group allows no sources on port ${portR.port} — clients cannot connect.`
          : `Port ${portR.port} reachable from: ${portR.openTo.join(', ')}.`,
        critical: blocked,
        warning: false,
        isPermissionMissing: false,
        data: {
          instanceId: instanceHealth?.instanceId,
          port: portR.port,
          openTo: portR.openTo,
          vpcSecurityGroupIds: instanceHealth?.vpcSecurityGroupIds,
        },
      });
    }

    return items;
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const config = await this.backend.getInstanceBackupConfig();
    const controlPlaneItems = await this.gatherControlPlaneItems();

    const retentionCritical = config.backupRetentionPeriod === 0;
    const snapshotCritical = config.snapshotCount === 0;
    const snapshotWarning = config.latestSnapshotAge > 86400; // >24h
    const controlPlaneCritical = controlPlaneItems.some((i) => i.critical);
    const controlPlaneWarning = controlPlaneItems.some((i) => i.warning);

    const status: HealthStatus = retentionCritical || snapshotCritical || controlPlaneCritical
      ? 'unhealthy'
      : snapshotWarning || controlPlaneWarning
        ? 'recovering'
        : 'healthy';

    const controlPlaneSignals: HealthSignal[] = controlPlaneItems.map((item) => ({
      source: item.source,
      status: item.isPermissionMissing ? 'unknown' : signalStatus(item.critical, item.warning),
      detail: item.message,
      observedAt,
    }));

    const signals: HealthSignal[] = [
      {
        source: 'rds_backup_retention',
        status: signalStatus(retentionCritical),
        detail: retentionCritical
          ? `Backup retention is disabled (0 days) on instance ${config.instanceId}. No automated backup protection.`
          : `Backup retention is ${config.backupRetentionPeriod} day(s) on instance ${config.instanceId}.`,
        observedAt,
      },
      {
        source: 'rds_snapshot_status',
        status: signalStatus(snapshotCritical, snapshotWarning),
        detail: snapshotCritical
          ? `No snapshots found for instance ${config.instanceId}. No point-in-time recovery possible.`
          : config.latestSnapshotTime
            ? `${config.snapshotCount} snapshot(s) available. Latest snapshot age: ${Math.floor(config.latestSnapshotAge / 3600)}h.`
            : `${config.snapshotCount} snapshot(s) available.`,
        observedAt,
      },
      {
        source: 'rds_instance_status',
        status: signalStatus(config.status !== 'available'),
        detail: `Instance ${config.instanceId} status: ${config.status}. Engine: ${config.engine}. Region: ${config.region}.`,
        observedAt,
      },
      ...controlPlaneSignals,
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: `RDS instance ${config.instanceId} backup health is healthy. Automated backups are enabled with ${config.backupRetentionPeriod}-day retention and ${config.snapshotCount} snapshot(s) available.`,
        recovering: `RDS instance ${config.instanceId} backup health is recovering. Backup retention is configured but snapshot age exceeds 24 hours.`,
        unhealthy: `RDS instance ${config.instanceId} backup health is unhealthy. Automated backups are disabled or no snapshots exist — the instance has no backup protection.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring RDS backup retention and snapshot freshness.'],
        recovering: ['Investigate why the latest snapshot is stale. Verify automated backup window and snapshot creation.'],
        unhealthy: ['Run the RDS backup recovery workflow to enable automated backups and create an immediate snapshot.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const config = await this.backend.getInstanceBackupConfig();
    const controlPlaneItems = await this.gatherControlPlaneItems();

    const backupScenario = config.backupRetentionPeriod === 0
      ? 'backup_disabled'
      : config.snapshotCount === 0
        ? 'missing_backup'
        : config.latestSnapshotAge > 2 * config.backupRetentionPeriod * 86400
          ? 'stale_snapshot'
          : 'healthy';

    // Control-plane issues (storage/security-group/saturation/availability) are
    // surfaced as more urgent than a backup-configuration finding, so they take
    // priority when deciding what scenario the plan should suggest a fix for.
    const storageCriticalItem = controlPlaneItems.find((i) => i.source === 'rds_storage' && i.critical);
    const sgCriticalItem = controlPlaneItems.find((i) => i.source === 'rds_security_group' && i.critical);
    const saturationItem = controlPlaneItems.find(
      (i) => i.source === 'rds_connection_saturation' && (i.critical || i.warning),
    );
    const instanceCriticalItem = controlPlaneItems.find((i) => i.source === 'rds_instance_status' && i.critical);

    const controlPlaneScenario = storageCriticalItem
      ? 'storage_full'
      : sgCriticalItem
        ? 'sg_blocked'
        : saturationItem
          ? 'connection_saturation'
          : instanceCriticalItem
            ? 'instance_unavailable'
            : null;

    const scenario = controlPlaneScenario ?? backupScenario;
    const confidence = controlPlaneScenario
      ? 0.9
      : config.backupRetentionPeriod === 0 ? 0.98 : 0.90;

    const controlPlaneFindings: DiagnosisFinding[] = controlPlaneItems.map((item) => ({
      source: item.source,
      observation: item.message,
      severity: item.isPermissionMissing ? 'info' : item.critical ? 'critical' : item.warning ? 'warning' : 'info',
      ...(item.data ? { data: item.data } : {}),
    }));

    return {
      status: scenario === 'healthy' ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'rds_backup_config',
          observation: config.backupRetentionPeriod === 0
            ? `RDS backup is disabled on instance ${config.instanceId}. Retention period is 0 days — no automated backup protection. This is a backup_disabled / retention_disabled condition.`
            : `RDS backup retention is ${config.backupRetentionPeriod} day(s) on instance ${config.instanceId}. Automated backups: ${config.automatedBackupsEnabled ? 'enabled' : 'disabled'}.`,
          severity: config.backupRetentionPeriod === 0 ? 'critical' : 'info',
          data: {
            instanceId: config.instanceId,
            backupRetentionPeriod: config.backupRetentionPeriod,
            automatedBackupsEnabled: config.automatedBackupsEnabled,
          },
        },
        {
          source: 'rds_snapshot_inventory',
          observation: config.snapshotCount === 0
            ? `No snapshot found for RDS instance ${config.instanceId}. This is a missing_backup / no_backup / no_snapshot condition — no point-in-time recovery is possible.`
            : config.latestSnapshotAge > 2 * config.backupRetentionPeriod * 86400
              ? `Latest snapshot for ${config.instanceId} is ${Math.floor(config.latestSnapshotAge / 3600)}h old — stale_snapshot detected. Snapshot freshness exceeds 2x retention window.`
              : `${config.snapshotCount} snapshot(s) available for ${config.instanceId}. Latest snapshot age: ${Math.floor(config.latestSnapshotAge / 3600)}h.`,
          severity: config.snapshotCount === 0 ? 'critical' : config.latestSnapshotAge > 86400 ? 'warning' : 'info',
          data: {
            snapshotCount: config.snapshotCount,
            latestSnapshotTime: config.latestSnapshotTime,
            latestSnapshotAge: config.latestSnapshotAge,
          },
        },
        {
          source: 'rds_instance_metadata',
          observation: `Instance ${config.instanceId} is ${config.status} in ${config.region}. Engine: ${config.engine}. RDS backup and snapshot retention status captured.`,
          severity: 'info',
          data: {
            engine: config.engine,
            status: config.status,
            region: config.region,
          },
        },
        ...controlPlaneFindings,
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const controlPlaneScenarios = new Set([
      'storage_full',
      'connection_saturation',
      'sg_blocked',
      'instance_unavailable',
    ]);
    if (diagnosis.scenario && controlPlaneScenarios.has(diagnosis.scenario)) {
      return this.buildControlPlaneSuggestionPlan(context, diagnosis);
    }

    // Derive the current retention from the diagnosis so the plan never *lowers*
    // an already-adequate retention window (e.g. a stale_snapshot instance that
    // already retains 14 days). Target is max(current, 7); the modify step is
    // only emitted when that represents a genuine increase.
    const backupConfigFinding = diagnosis.findings.find((f) => f.source === 'rds_backup_config');

    // Prefer the instance id the trigger carried, falling back to the one the
    // diagnosis actually inspected so the plan never targets 'unknown-instance'
    // when diagnosis succeeded against a real instance.
    const diagnosedInstance = backupConfigFinding?.data?.instanceId;
    const instance = String(
      (context.trigger.payload as Record<string, unknown>).instance_id ||
        diagnosedInstance ||
        'unknown-instance',
    );

    const currentRetention =
      typeof backupConfigFinding?.data?.backupRetentionPeriod === 'number'
        ? (backupConfigFinding.data.backupRetentionPeriod as number)
        : 0;
    const targetRetention = Math.max(currentRetention, 7);
    const needsRetentionIncrease = targetRetention > currentRetention;
    const backupsDisabled = currentRetention === 0;

    // Step 5 (conditional): modify retention only when it would increase it.
    const modifyRetentionStep: RecoveryStep = {
      stepId: 'step-005',
      type: 'system_action',
      name: `Enable automated backups with ${targetRetention}-day retention`,
      description: `Set BackupRetentionPeriod to ${targetRetention} days on instance ${instance} to enable automated daily backups.`,
      executionContext: 'rds_write',
      target: instance,
      riskLevel: 'elevated',
      requiredCapabilities: ['rds.instance.modify'],
      command: {
        type: 'structured_command',
        operation: 'modify_db_instance',
        parameters: { instanceId: instance, backupRetentionPeriod: targetRetention },
      },
      preConditions: [
        {
          description: 'RDS instance is in available state',
          check: {
            type: 'structured_command',
            statement: 'instance_status',
            expect: { operator: 'eq', value: 'available' },
          },
        },
      ],
      statePreservation: {
        before: [
          {
            name: 'backup_retention_before',
            captureType: 'command_output',
            statement: 'DescribeDBInstances BackupRetentionPeriod',
            captureCost: 'negligible',
            capturePolicy: 'required',
            retention: 'P30D',
          },
        ],
        after: [
          {
            name: 'backup_retention_after',
            captureType: 'command_output',
            statement: 'DescribeDBInstances BackupRetentionPeriod',
            captureCost: 'negligible',
            capturePolicy: 'best_effort',
            retention: 'P30D',
          },
        ],
      },
      successCriteria: {
        description: `Backup retention period is at least ${targetRetention} days`,
        check: {
          type: 'structured_command',
          statement: 'backup_retention_period',
          expect: { operator: 'gte', value: targetRetention },
        },
      },
      rollback: {
        type: 'manual',
        description: 'Revert BackupRetentionPeriod to previous value via ModifyDBInstance.',
      },
      blastRadius: {
        directComponents: [instance],
        indirectComponents: ['automated-backups'],
        maxImpact: 'backup_retention_changed',
        cascadeRisk: 'none',
      },
      timeout: 'PT2M',
      retryPolicy: { maxRetries: 1, retryable: true },
    };

    const steps: RecoveryStep[] = [
      // Step 1: Capture current RDS backup config
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current RDS backup configuration',
        executionContext: 'rds_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'get_instance_backup_config',
          parameters: { instanceId: instance },
        },
        outputCapture: {
          name: 'current_rds_backup_config',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of RDS backup misconfiguration',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: backupsDisabled
            ? `CRITICAL — RDS backup retention is 0 days on instance ${instance}`
            : `RDS backup issue on instance ${instance} — ${diagnosis.scenario}`,
          detail: `${backupsDisabled
            ? `RDS backup retention is 0 days on instance ${instance}. The instance has NO automated backup protection.`
            : `RDS instance ${instance} has backup retention of ${currentRetention} day(s).`} Scenario: ${diagnosis.scenario}. ${backupConfigFinding?.observation ?? ''}`,
          contextReferences: ['current_rds_backup_config'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture instance config and snapshot inventory before mutations.',
        stateCaptures: [
          {
            name: 'rds_instance_config_snapshot',
            captureType: 'command_output',
            statement: 'DescribeDBInstances',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'rds_snapshot_inventory',
            captureType: 'command_output',
            statement: 'DescribeDBSnapshots',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Human approval gate
      {
        stepId: 'step-004',
        type: 'human_approval',
        name: 'Approve RDS instance modification',
        description: needsRetentionIncrease
          ? `Approve modifying backup retention on instance ${instance} from ${currentRetention} to ${targetRetention} days and creating an immediate snapshot.`
          : `Approve creating an immediate snapshot on instance ${instance} (retention is already ${currentRetention} days).`,
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `Modify RDS instance ${instance} backup configuration`,
          detail: needsRetentionIncrease
            ? `This will set BackupRetentionPeriod to ${targetRetention} days and create an immediate manual snapshot on instance ${instance}.`
            : `This will create an immediate manual snapshot on instance ${instance}. Retention is already ${currentRetention} days and will not be changed.`,
          contextReferences: ['current_rds_backup_config'],
          proposedActions: [
            ...(needsRetentionIncrease
              ? [`Set BackupRetentionPeriod from ${currentRetention} to ${targetRetention} days`]
              : []),
            'Create an immediate manual DB snapshot',
          ],
          riskSummary: 'Enabling backups may cause a brief I/O suspension during the first automated backup window.',
          alternatives: [
            { action: 'skip', description: 'Skip recovery and leave backups disabled (not recommended).' },
            { action: 'custom_retention', description: 'Set a different retention period instead of 7 days.' },
          ],
        },
        timeout: 'PT30M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'database_admin',
          message: `Approval timed out for RDS backup recovery on instance ${instance}. Escalating to database admin.`,
        },
      },
      // Step 5: Modify instance to enable/raise backup retention (only when it
      // would increase the window — never lower an already-adequate retention).
      ...(needsRetentionIncrease ? [modifyRetentionStep] : []),
      // Step 6: Create an immediate manual snapshot
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Create immediate manual snapshot',
        description: `Create a manual snapshot of instance ${instance} to ensure an immediate backup exists.`,
        executionContext: 'rds_write',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['rds.snapshot.create'],
        command: {
          type: 'structured_command',
          operation: 'create_db_snapshot',
          parameters: { instanceId: instance, snapshotId: `crisismode-recovery-${instance}` },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Snapshot count is at least 1',
          check: {
            type: 'structured_command',
            statement: 'snapshot_count',
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Snapshot can be deleted if needed. No impact on running instance.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['snapshots'],
          maxImpact: 'snapshot_created',
          cascadeRisk: 'none',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 7: Replanning checkpoint
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Verify backup retention and snapshot state',
        description: 'Check that backup retention is enabled and a snapshot exists before declaring success.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_backup_config',
            captureType: 'command_output',
            statement: 'DescribeDBInstances',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 8: Recovery summary notification
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'database_admin', urgency: 'medium' },
        ],
        message: {
          summary: `RDS backup recovery completed on instance ${instance}`,
          detail: `${needsRetentionIncrease
            ? `Automated backups enabled with ${targetRetention}-day retention. `
            : `Backup retention left at ${currentRetention} days. `}Manual snapshot created. Monitor backup window and snapshot creation over the next 24 hours.`,
          contextReferences: ['post_recovery_backup_config'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'aws-rds',
        agentName: 'aws-rds-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'backup_disabled',
        estimatedDuration: 'PT10M',
        summary: needsRetentionIncrease
          ? `Recover RDS instance ${instance} from backup misconfiguration: enable automated backups, set ${targetRetention}-day retention, create immediate snapshot.`
          : `Recover RDS instance ${instance}: create an immediate snapshot (retention already ${currentRetention} days).`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'aws-rds',
            role: 'primary',
            impactType: 'backup_configuration_change',
          },
        ],
        affectedServices: ['database-backups'],
        estimatedUserImpact: 'No user-facing impact. Enabling backups may cause a brief I/O suspension during the first backup window.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Backup retention can be reverted to previous value. Manually created snapshots can be deleted without impact.',
      },
    };
  }

  /**
   * Control-plane issues (storage, connection saturation, security groups)
   * stay at the 'suggest' escalation level: crisismode can see the problem
   * but modifying instance class/storage/security groups is an operator
   * decision, so the plan only captures state and notifies — every step is
   * diagnosis_action or human_notification, never system_action.
   */
  private buildControlPlaneSuggestionPlan(context: AgentContext, diagnosis: DiagnosisResult): RecoveryPlan {
    const instanceStatusFinding = diagnosis.findings.find((f) => f.source === 'rds_instance_status');
    const instance = String(
      (context.trigger.payload as Record<string, unknown>).instance_id ||
        instanceStatusFinding?.data?.instanceId ||
        'unknown-instance',
    );

    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current RDS control-plane state',
        executionContext: 'rds_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'get_instance_health',
          parameters: { instanceId: instance },
        },
        outputCapture: {
          name: 'current_rds_control_plane_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
    ];

    let stepSeq = 2;
    const pushSuggestion = (summary: string, detail: string): void => {
      steps.push({
        stepId: `step-${String(stepSeq).padStart(3, '0')}`,
        type: 'human_notification',
        name: summary,
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary,
          detail,
          contextReferences: ['current_rds_control_plane_state'],
          actionRequired: true,
        },
        channel: 'auto',
      });
      stepSeq += 1;
    };

    const storageFinding = diagnosis.findings.find((f) => f.source === 'rds_storage');
    if (storageFinding && storageFinding.severity === 'critical') {
      const currentGb =
        typeof storageFinding.data?.allocatedStorageGb === 'number'
          ? (storageFinding.data.allocatedStorageGb as number)
          : 20;
      const targetGb = currentGb + 20;
      pushSuggestion(
        `Increase allocated storage on RDS instance ${instance}`,
        `RDS storage is full on instance ${instance}. Increase allocated storage: RDS console → Databases → ${instance} → Modify → Allocated storage. ` +
          `CLI equivalent: aws rds modify-db-instance --db-instance-identifier ${instance} --allocated-storage ${targetGb} --apply-immediately.`,
      );
    }

    const saturationFinding = diagnosis.findings.find((f) => f.source === 'rds_connection_saturation');
    if (saturationFinding && (saturationFinding.severity === 'critical' || saturationFinding.severity === 'warning')) {
      pushSuggestion(
        `Reduce connection saturation on RDS instance ${instance}`,
        `Database connections on instance ${instance} are approaching the limit. Consider connection pooling (RDS Proxy) or a larger instance class: ` +
          `RDS console → Databases → ${instance} → Modify → DB instance class. ` +
          `CLI equivalent: aws rds modify-db-instance --db-instance-identifier ${instance} --db-instance-class <larger-class> --apply-immediately.`,
      );
    }

    const sgFinding = diagnosis.findings.find((f) => f.source === 'rds_security_group');
    if (sgFinding && sgFinding.severity === 'critical') {
      const sgIds = sgFinding.data?.vpcSecurityGroupIds;
      const sgId = Array.isArray(sgIds) && sgIds.length > 0 ? String(sgIds[0]) : 'sg-unknown';
      const port = typeof sgFinding.data?.port === 'number' ? (sgFinding.data.port as number) : 5432;
      pushSuggestion(
        `Open RDS security group ingress on instance ${instance}`,
        `The security group blocks all inbound connections to instance ${instance}. Open the DB port to your app's security group: ` +
          `EC2 console → Security Groups → ${sgId} → Inbound rules. ` +
          `CLI equivalent: aws ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port ${port} --source-group <app-security-group-id>.`,
      );
    }

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'aws-rds-control-plane',
        agentName: 'aws-rds-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'control_plane_issue',
        estimatedDuration: 'PT5M',
        summary: `Suggested remediation for RDS instance ${instance}: ${diagnosis.scenario ?? 'control-plane issue'}. No mutations performed — operator action required.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'aws-rds',
            role: 'primary',
            impactType: 'control_plane_configuration_change',
          },
        ],
        affectedServices: ['database-availability'],
        estimatedUserImpact: 'No user-facing impact. This plan only diagnoses and notifies — no mutations are performed.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'none',
        description: 'No mutations were performed by this plan — suggestions require manual operator action via the AWS console or CLI.',
      },
    };
  }

  replan = defaultReplan;
}
