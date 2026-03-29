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
import { awsDynamoDbRecoveryManifest } from './manifest.js';
import type { DynamoDbRecoveryBackend } from './backend.js';
import { DynamoDbRecoverySimulator } from './simulator.js';

export class AwsDynamoDbRecoveryAgent implements RecoveryAgent {
  manifest = awsDynamoDbRecoveryManifest;
  backend: DynamoDbRecoveryBackend;

  constructor(backend?: DynamoDbRecoveryBackend) {
    this.backend = backend ?? new DynamoDbRecoverySimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const config = await this.backend.getTableBackupConfig();

    const pitrCritical = !config.pitrEnabled;

    const status: HealthStatus = pitrCritical ? 'unhealthy' : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'dynamodb_continuous_backups',
        status: signalStatus(pitrCritical),
        detail: pitrCritical
          ? `Point-in-time recovery is DISABLED on table ${config.tableName} in ${config.region}. Data loss risk is elevated.`
          : `Point-in-time recovery is enabled on table ${config.tableName}. Earliest restore: ${config.pitrEarliestRestoreDate}, latest: ${config.pitrLatestRestoreDate}.`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.96,
      summary: {
        healthy: `DynamoDB table ${config.tableName} is healthy. Point-in-time recovery is enabled and backup coverage is current.`,
        recovering: `DynamoDB table ${config.tableName} backup state is recovering. PITR was recently re-enabled but the restore window is still building.`,
        unhealthy: `DynamoDB table ${config.tableName} is unhealthy. Point-in-time recovery is DISABLED — any data loss since PITR was disabled is UNRECOVERABLE.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring DynamoDB backup status.'],
        recovering: ['Monitor PITR restore window until it reaches the expected retention period.'],
        unhealthy: ['Run the DynamoDB PITR recovery workflow to re-enable continuous backups immediately.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const config = await this.backend.getTableBackupConfig();

    const scenario = !config.pitrEnabled ? 'pitr_disabled' : 'healthy';
    const confidence = !config.pitrEnabled ? 0.95 : 0.90;

    return {
      status: config.pitrEnabled ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'dynamodb_continuous_backups',
          observation: config.pitrEnabled
            ? `PITR is enabled on table ${config.tableName} in ${config.region}. Earliest restore: ${config.pitrEarliestRestoreDate}. Latest restore: ${config.pitrLatestRestoreDate}. Continuous backup and point-in-time recovery are active.`
            : `PITR is DISABLED on table ${config.tableName} in ${config.region}. Point-in-time recovery is not active — continuous backup protection is missing. Any data lost between the time PITR was disabled and now is unrecoverable. Keywords: pitr_disabled, point_in_time_disabled, continuous_backup, backup_disabled, dynamodb, pitr, point-in-time, backup.`,
          severity: config.pitrEnabled ? 'info' : 'critical',
          data: {
            tableName: config.tableName,
            region: config.region,
            pitrEnabled: config.pitrEnabled,
            pitrEarliestRestoreDate: config.pitrEarliestRestoreDate,
            pitrLatestRestoreDate: config.pitrLatestRestoreDate,
          },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const table = String(context.trigger.payload.table || 'unknown-table');

    const steps: RecoveryStep[] = [
      // Step 1: Capture current PITR config
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current DynamoDB PITR configuration',
        executionContext: 'dynamodb_read',
        target: table,
        command: {
          type: 'structured_command',
          operation: 'get_table_backup_config',
          parameters: { tableName: table },
        },
        outputCapture: {
          name: 'current_pitr_config',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Critical warning — data gap is unrecoverable
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'CRITICAL: PITR disabled — unrecoverable data gap',
        recipients: [{ role: 'on_call_engineer', urgency: 'critical' }],
        message: {
          summary: `PITR is disabled on DynamoDB table ${table}`,
          detail: `CRITICAL: Point-in-time recovery is disabled on table ${table}. Any data lost between the time PITR was disabled and now is UNRECOVERABLE. Re-enabling PITR only protects data from this point forward — it cannot recover the gap.`,
          contextReferences: ['current_pitr_config'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint — capture DescribeContinuousBackups state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture DescribeContinuousBackups state before enabling PITR.',
        stateCaptures: [
          {
            name: 'continuous_backups_state',
            captureType: 'command_output',
            statement: 'DescribeContinuousBackups',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Human approval — confirm acceptance of data gap
      {
        stepId: 'step-004',
        type: 'human_approval',
        name: 'Approve PITR re-enablement',
        description: `Confirm that you accept the unrecoverable data gap and approve re-enabling PITR on table ${table}. Re-enabling protects from this point forward only.`,
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `Approve re-enabling PITR on DynamoDB table ${table}`,
          detail: `PITR is disabled on table ${table}. Data lost during the disabled period is unrecoverable. Re-enabling PITR protects data from this point forward only.`,
          contextReferences: ['current_pitr_config'],
          proposedActions: ['Enable point-in-time recovery via UpdateContinuousBackups'],
          riskSummary: 'Enabling PITR is a metadata operation with no service disruption. The data gap from the disabled period is permanent.',
          alternatives: [
            { action: 'skip', description: 'Leave PITR disabled — increases data loss risk.' },
          ],
        },
        timeout: 'PT30M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'engineering_lead',
          message: `PITR approval timed out for DynamoDB table ${table}. Escalating.`,
        },
      },
      // Step 5: Enable PITR via UpdateContinuousBackups
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Enable point-in-time recovery on DynamoDB table',
        description: `Call UpdateContinuousBackups to enable PITR on table ${table}. This protects data from this point forward.`,
        executionContext: 'dynamodb_write',
        target: table,
        riskLevel: 'elevated',
        requiredCapabilities: ['dynamodb.backup.write'],
        command: {
          type: 'structured_command',
          operation: 'update_continuous_backups',
          parameters: { tableName: table, pointInTimeRecoveryEnabled: true },
        },
        preConditions: [
          {
            description: 'Table continuous backups are currently queryable',
            check: {
              type: 'structured_command',
              statement: 'continuous_backups_status',
              expect: { operator: 'neq', value: 'ERROR' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'pitr_state_before',
              captureType: 'command_output',
              statement: 'DescribeContinuousBackups',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'pitr_state_after',
              captureType: 'command_output',
              statement: 'DescribeContinuousBackups',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'PITR is enabled on the table',
          check: {
            type: 'structured_command',
            statement: 'pitr_status',
            expect: { operator: 'eq', value: 'ENABLED' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'PITR can be disabled again via UpdateContinuousBackups if needed, but disabling removes backup coverage.',
        },
        blastRadius: {
          directComponents: [table],
          indirectComponents: [],
          maxImpact: 'pitr_enabled',
          cascadeRisk: 'none',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Replanning checkpoint — verify PITR enabled
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Verify PITR is enabled after update',
        description: 'Confirm point-in-time recovery is now active on the table.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_enable_pitr_state',
            captureType: 'command_output',
            statement: 'DescribeContinuousBackups',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Recovery summary noting unrecoverable data gap window
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'PITR recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `PITR re-enabled on DynamoDB table ${table}`,
          detail: `Point-in-time recovery has been re-enabled on table ${table}. IMPORTANT: Data from the period when PITR was disabled remains unrecoverable. The restore window will build from the time of re-enablement. Monitor the earliest/latest restorable timestamps to confirm coverage is growing.`,
          contextReferences: ['post_enable_pitr_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'aws-dynamo',
        agentName: 'aws-dynamodb-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'pitr_disabled',
        estimatedDuration: 'PT5M',
        summary: `Re-enable point-in-time recovery on DynamoDB table ${table}: capture state, notify on data gap, enable PITR, verify.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: table,
            technology: 'aws-dynamodb',
            role: 'table',
            impactType: 'backup_configuration_change',
          },
        ],
        affectedServices: ['dynamodb-backup'],
        estimatedUserImpact: 'No service disruption. PITR enablement is a metadata operation. However, data from the disabled period remains unrecoverable.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'PITR can be disabled again if needed, but doing so removes backup coverage. The data gap from the disabled period is permanent.',
      },
    };
  }

  replan = defaultReplan;
}
