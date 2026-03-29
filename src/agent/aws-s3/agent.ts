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
import { awsS3RecoveryManifest } from './manifest.js';
import type { S3RecoveryBackend } from './backend.js';
import { S3RecoverySimulator } from './simulator.js';

export class AwsS3RecoveryAgent implements RecoveryAgent {
  manifest = awsS3RecoveryManifest;
  backend: S3RecoveryBackend;

  constructor(backend?: S3RecoveryBackend) {
    this.backend = backend ?? new S3RecoverySimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const config = await this.backend.getBucketConfig();

    const versioningCritical = config.versioningStatus === 'Disabled' || config.versioningStatus === 'Suspended';
    const versioningWarning = false;
    const lifecycleCritical = false;
    const lifecycleWarning = config.lifecycleRules.length === 0;

    const status: HealthStatus = versioningCritical
      ? 'unhealthy'
      : lifecycleWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 's3_versioning',
        status: signalStatus(versioningCritical, versioningWarning),
        detail: `S3 bucket versioning is ${config.versioningStatus} for bucket ${config.bucket}.`,
        observedAt,
      },
      {
        source: 's3_lifecycle',
        status: signalStatus(lifecycleCritical, lifecycleWarning),
        detail: config.lifecycleRules.length > 0
          ? `${config.lifecycleRules.length} lifecycle rule(s) configured on bucket ${config.bucket}.`
          : `No lifecycle rules configured on S3 bucket ${config.bucket}. Backup retention is unmanaged.`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: `S3 bucket ${config.bucket} is healthy. Versioning is enabled and lifecycle rules are configured.`,
        recovering: `S3 bucket ${config.bucket} is recovering. Versioning or lifecycle configuration needs attention.`,
        unhealthy: `S3 bucket ${config.bucket} is unhealthy. Versioning is ${config.versioningStatus} — backup data is at risk.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring S3 bucket versioning and lifecycle configuration.'],
        recovering: ['Review and configure lifecycle rules to manage backup retention and storage costs.'],
        unhealthy: ['Run the S3 backup recovery workflow to enable versioning and configure lifecycle rules.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const config = await this.backend.getBucketConfig();

    const versioningOff = config.versioningStatus === 'Disabled' || config.versioningStatus === 'Suspended';
    const noLifecycle = config.lifecycleRules.length === 0;

    const scenario = versioningOff && noLifecycle
      ? 'backup_misconfigured'
      : config.versioningStatus === 'Disabled'
        ? 'versioning_disabled'
        : config.versioningStatus === 'Suspended'
          ? 'versioning_suspended'
          : noLifecycle
            ? 'missing_lifecycle'
            : 'backup_misconfigured';

    const confidence = versioningOff ? 0.95 : 0.85;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 's3_versioning',
          observation: `S3 bucket ${config.bucket} versioning is ${config.versioningStatus}. ` +
            (config.versioningStatus === 'Disabled'
              ? 'Versioning has never been enabled — versioning_disabled detected. S3 backup data cannot be recovered from accidental deletions.'
              : config.versioningStatus === 'Suspended'
                ? 'Versioning was previously enabled but is now suspended — versioning_suspended detected. New S3 backup objects are not versioned.'
                : 'Versioning is enabled on the S3 bucket.'),
          severity: versioningOff ? 'critical' : 'info',
          data: { bucket: config.bucket, versioningStatus: config.versioningStatus },
        },
        {
          source: 's3_lifecycle',
          observation: noLifecycle
            ? `No lifecycle rules found on S3 bucket ${config.bucket} — missing_lifecycle detected. Backup objects have no automated retention or transition policy.`
            : `${config.lifecycleRules.length} lifecycle rule(s) configured on S3 bucket ${config.bucket}. Backup retention is managed.`,
          severity: noLifecycle ? 'warning' : 'info',
          data: { bucket: config.bucket, lifecycleRuleCount: config.lifecycleRules.length, lifecycleRules: config.lifecycleRules },
        },
        {
          source: 's3_backup_assessment',
          observation: versioningOff && noLifecycle
            ? `S3 bucket ${config.bucket} has backup_misconfigured: both versioning and lifecycle rules are missing. This S3 backup configuration is critically incomplete.`
            : `S3 backup configuration assessment complete for bucket ${config.bucket}.`,
          severity: versioningOff && noLifecycle ? 'critical' : 'info',
          data: { scenario, bucket: config.bucket },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const bucket = String(context.trigger.payload.bucket || 'unknown-bucket');

    const steps: RecoveryStep[] = [
      // Step 1: Capture current bucket config
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current S3 bucket configuration',
        executionContext: 's3_read',
        target: bucket,
        command: {
          type: 'structured_command',
          operation: 'get_bucket_config',
          parameters: { bucket },
        },
        outputCapture: {
          name: 'current_bucket_config',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of S3 backup misconfiguration',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `S3 backup misconfiguration recovery initiated on bucket ${bucket}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_bucket_config'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture versioning and lifecycle state before mutations.',
        stateCaptures: [
          {
            name: 'versioning_snapshot',
            captureType: 'command_output',
            statement: 'GetBucketVersioning',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'lifecycle_snapshot',
            captureType: 'command_output',
            statement: 'GetBucketLifecycleConfiguration',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Enable versioning
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Enable S3 bucket versioning',
        description: 'Put bucket versioning configuration to Enabled state to protect backup objects.',
        executionContext: 's3_write',
        target: bucket,
        riskLevel: 'elevated',
        requiredCapabilities: ['s3.versioning.write'],
        command: {
          type: 'structured_command',
          operation: 'put_bucket_versioning',
          parameters: { bucket, status: 'Enabled' },
        },
        preConditions: [
          {
            description: 'S3 bucket exists and is accessible',
            check: {
              type: 'structured_command',
              statement: 'bucket_exists',
              expect: { operator: 'eq', value: 'true' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'versioning_before',
              captureType: 'command_output',
              statement: 'GetBucketVersioning',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'versioning_after',
              captureType: 'command_output',
              statement: 'GetBucketVersioning',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Versioning is enabled on the bucket',
          check: {
            type: 'structured_command',
            statement: 'versioning_status',
            expect: { operator: 'eq', value: 'Enabled' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Versioning can be suspended but not disabled once enabled. Review before reverting.',
        },
        blastRadius: {
          directComponents: [bucket],
          indirectComponents: ['backup-pipeline'],
          maxImpact: 'versioning_enabled',
          cascadeRisk: 'none',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Conditionally configure lifecycle rules
      {
        stepId: 'step-005',
        type: 'conditional',
        name: 'Configure lifecycle rules if missing',
        condition: {
          description: 'Lifecycle rules are not configured on the bucket',
          check: {
            type: 'structured_command',
            statement: 'lifecycle_rule_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        thenStep: {
          stepId: 'step-005a',
          type: 'system_action',
          name: 'Configure S3 bucket lifecycle rules',
          description: 'Apply lifecycle rules for backup retention and storage class transitions.',
          executionContext: 's3_write',
          target: bucket,
          riskLevel: 'routine',
          requiredCapabilities: ['s3.lifecycle.write'],
          command: {
            type: 'structured_command',
            operation: 'put_bucket_lifecycle',
            parameters: {
              bucket,
              rules: [
                {
                  id: 'archive-old-backups',
                  prefix: 'backups/',
                  transitions: [
                    { days: 30, storageClass: 'STANDARD_IA' },
                    { days: 90, storageClass: 'GLACIER' },
                  ],
                  expiration: { days: 365 },
                },
              ],
            },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Lifecycle rules are configured',
            check: {
              type: 'structured_command',
              statement: 'lifecycle_rule_count',
              expect: { operator: 'gt', value: 0 },
            },
          },
          rollback: {
            type: 'manual',
            description: 'Remove lifecycle rules via DeleteBucketLifecycle if misconfigured.',
          },
          blastRadius: {
            directComponents: [bucket],
            indirectComponents: [],
            maxImpact: 'lifecycle_rules_applied',
            cascadeRisk: 'none',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
        elseStep: 'skip',
      },
      // Step 6: Replanning checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Re-check bucket configuration after recovery',
        description: 'Verify versioning and lifecycle state after recovery actions.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_config',
            captureType: 'command_output',
            statement: 'GetBucketVersioning + GetBucketLifecycleConfiguration',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Recovery summary
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `S3 backup configuration recovery completed on bucket ${bucket}`,
          detail: 'Versioning enabled and lifecycle rules configured. Monitor backup pipeline and verify next scheduled backup completes successfully.',
          contextReferences: ['post_recovery_config'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'aws-s3',
        agentName: 'aws-s3-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'backup_misconfigured',
        estimatedDuration: 'PT3M',
        summary: `Recover S3 bucket ${bucket} from backup misconfiguration: enable versioning, configure lifecycle rules.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: bucket,
            technology: 'aws-s3',
            role: 'backup-storage',
            impactType: 'configuration_change',
          },
        ],
        affectedServices: ['backup-pipeline'],
        estimatedUserImpact: 'No user-facing impact. Configuration changes affect future backup behavior only.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Versioning can be suspended (not disabled). Lifecycle rules can be deleted. Each step is independently reversible.',
      },
    };
  }

  replan = defaultReplan;
}
