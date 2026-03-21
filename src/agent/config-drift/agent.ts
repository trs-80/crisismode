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
import { configDriftManifest } from './manifest.js';
import type { ConfigDriftBackend } from './backend.js';
import { ConfigDriftSimulator } from './simulator.js';

export class ConfigDriftAgent implements RecoveryAgent {
  manifest = configDriftManifest;
  backend: ConfigDriftBackend;

  constructor(backend?: ConfigDriftBackend) {
    this.backend = backend ?? new ConfigDriftSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const envVars = await this.backend.getEnvironmentVars();
    const secrets = await this.backend.getSecretStatus();
    const diffs = await this.backend.getConfigDiff();

    const envMismatches = envVars.filter((v) => v.expected !== v.actual);
    const expiredSecrets = secrets.filter((s) => s.expired);
    const unmountedSecrets = secrets.filter((s) => !s.mounted);

    const envCritical = envMismatches.some((v) => v.masked);
    const envWarning = envMismatches.length > 0;
    const secretCritical = expiredSecrets.length > 0 || unmountedSecrets.length > 0;
    const configCritical = diffs.length > 2;
    const configWarning = diffs.length > 0;

    const status = envCritical || secretCritical || configCritical
      ? 'unhealthy'
      : envWarning || configWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'environment_variables',
        status: signalStatus(envCritical, envWarning),
        detail: envMismatches.length > 0
          ? `${envMismatches.length} env var(s) drifted from expected values: ${envMismatches.map((v) => v.name).join(', ')}.`
          : 'All environment variables match expected values.',
        observedAt,
      },
      {
        source: 'secrets',
        status: signalStatus(secretCritical),
        detail: expiredSecrets.length > 0
          ? `${expiredSecrets.length} secret(s) expired: ${expiredSecrets.map((s) => s.name).join(', ')}.`
          : unmountedSecrets.length > 0
            ? `${unmountedSecrets.length} secret(s) not mounted.`
            : 'All secrets are mounted and valid.',
        observedAt,
      },
      {
        source: 'config_files',
        status: signalStatus(configCritical, configWarning),
        detail: diffs.length > 0
          ? `${diffs.length} config drift(s) detected across ${Array.from(new Set(diffs.map((d) => d.source))).join(', ')} sources.`
          : 'All config files match expected state.',
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'Config alignment is healthy. Environment variables, secrets, and config files all match expected state.',
        recovering: 'Config alignment is recovering. Some non-critical drifts remain but critical values are correct.',
        unhealthy: 'Config alignment is unhealthy. Critical environment variables, secrets, or config files have drifted from expected state.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring config alignment after deploys.'],
        recovering: ['Review remaining config drifts and verify they are intentional or schedule correction.'],
        unhealthy: ['Run the config drift recovery workflow to restore expected configuration state.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const envVars = await this.backend.getEnvironmentVars();
    const secrets = await this.backend.getSecretStatus();
    const diffs = await this.backend.getConfigDiff();
    const changes = await this.backend.getRecentConfigChanges();

    const envMismatches = envVars.filter((v) => v.expected !== v.actual);
    const expiredSecrets = secrets.filter((s) => s.expired);

    const scenario = expiredSecrets.length > 0
      ? 'secret_expired'
      : envMismatches.length > 0
        ? 'env_var_mismatch'
        : diffs.length > 0
          ? 'config_file_drift'
          : 'missing_env_vars';

    const confidence = envMismatches.length > 0 && changes.length > 0 ? 0.93 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'environment_variables',
          observation: envMismatches.length > 0
            ? `${envMismatches.length} env var(s) drifted: ${envMismatches.map((v) => v.name).join(', ')}. Values point to wrong targets post-deploy.`
            : 'All environment variables match expected values.',
          severity: envMismatches.some((v) => v.masked) ? 'critical' : envMismatches.length > 0 ? 'warning' : 'info',
          data: { mismatches: envMismatches.map((v) => ({ name: v.name, source: v.source })) },
        },
        {
          source: 'secrets',
          observation: expiredSecrets.length > 0
            ? `${expiredSecrets.length} secret(s) expired: ${expiredSecrets.map((s) => s.name).join(', ')}.`
            : 'All secrets are valid and mounted.',
          severity: expiredSecrets.length > 0 ? 'critical' : 'info',
          data: { expired: expiredSecrets.map((s) => ({ name: s.name, provider: s.provider, lastRotated: s.lastRotated })) },
        },
        {
          source: 'config_files',
          observation: diffs.length > 0
            ? `${diffs.length} config drift(s) detected: ${diffs.map((d) => d.path).join(', ')}.`
            : 'No config file drift detected.',
          severity: diffs.length > 2 ? 'critical' : diffs.length > 0 ? 'warning' : 'info',
          data: { diffs: diffs.map((d) => ({ path: d.path, source: d.source })) },
        },
        {
          source: 'deploy_audit',
          observation: changes.length > 0
            ? `${changes.length} recent config change(s) correlated with deploy: changed by ${Array.from(new Set(changes.map((c) => c.changedBy).filter(Boolean))).join(', ')}.`
            : 'No recent config changes found.',
          severity: changes.length > 0 ? 'warning' : 'info',
          data: { changes: changes.map((c) => ({ path: c.path, changedAt: c.changedAt, changedBy: c.changedBy })) },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'app-deployment');

    const steps: RecoveryStep[] = [
      // Step 1: Scan all config sources for drift
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Scan environment variables, secrets, and config files for drift',
        executionContext: 'config_read',
        target,
        command: {
          type: 'api_call',
          operation: 'scan_config',
          parameters: { scope: ['env', 'secrets', 'config-files'] },
        },
        outputCapture: {
          name: 'config_drift_scan',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Alert about config drift
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of config drift detected post-deploy',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Config drift detected post-deploy on ${target}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['config_drift_scan'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Capture current config state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery config state checkpoint',
        description: 'Capture current environment variables, secrets, and config files before corrections.',
        stateCaptures: [
          {
            name: 'env_vars_snapshot',
            captureType: 'command_output',
            statement: 'scan_config --scope=env',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'secrets_snapshot',
            captureType: 'api_snapshot',
            statement: 'scan_config --scope=secrets',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'config_files_snapshot',
            captureType: 'file_snapshot',
            statement: 'scan_config --scope=config-files',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Restore critical environment variables
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Restore critical environment variables to expected values',
        description: 'Update drifted environment variables (DATABASE_URL, endpoints) to their expected production values.',
        executionContext: 'config_write',
        target,
        riskLevel: 'elevated',
        requiredCapabilities: ['config.env.restore'],
        command: {
          type: 'configuration_change',
          operation: 'restore_env_vars',
          parameters: { variables: ['DATABASE_URL', 'FEATURE_FLAGS_ENDPOINT'] },
        },
        preConditions: [
          {
            description: 'Config scan completed successfully',
            check: {
              type: 'api_call',
              statement: 'env_var_mismatches',
              expect: { operator: 'gt', value: 0 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'env_vars_before_restore',
              captureType: 'command_output',
              statement: 'scan_config --scope=env',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'env_vars_after_restore',
              captureType: 'command_output',
              statement: 'scan_config --scope=env',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'No environment variable mismatches remain',
          check: {
            type: 'api_call',
            statement: 'env_var_mismatches',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'command',
          description: 'Revert environment variables to pre-restore values from captured snapshot.',
          command: {
            type: 'configuration_change',
            operation: 'restore_env_vars',
            parameters: { source: 'env_vars_before_restore' },
          },
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['downstream-services'],
          maxImpact: 'env_vars_updated',
          cascadeRisk: 'low',
        },
        timeout: 'PT1M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Trigger secret rotation for expired secrets
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Trigger secret rotation for expired secrets',
        description: 'Rotate expired secrets via the secrets provider to restore valid credentials.',
        executionContext: 'config_write',
        target,
        riskLevel: 'routine',
        requiredCapabilities: ['config.secrets.rotate'],
        command: {
          type: 'configuration_change',
          operation: 'rotate_secrets',
          parameters: { secrets: ['api-gateway-key'] },
        },
        statePreservation: {
          before: [
            {
              name: 'secrets_before_rotate',
              captureType: 'api_snapshot',
              statement: 'scan_config --scope=secrets',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [],
        },
        successCriteria: {
          description: 'No expired secrets remain',
          check: {
            type: 'api_call',
            statement: 'expired_secrets_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Manual rollback required. Contact the secrets provider admin to restore previous secret version.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['api-gateway'],
          maxImpact: 'secret_rotated',
          cascadeRisk: 'low',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Verify config alignment after corrections
      {
        stepId: 'step-006',
        type: 'diagnosis_action',
        name: 'Verify config alignment after corrections',
        executionContext: 'config_read',
        target,
        command: {
          type: 'api_call',
          operation: 'verify_alignment',
          parameters: { scope: ['env', 'secrets', 'config-files'] },
        },
        outputCapture: {
          name: 'post_correction_status',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 7: Conditional — branch based on alignment result
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Check if all configs are aligned',
        condition: {
          check: {
            type: 'api_call',
            statement: 'all_configs_aligned',
            expect: { operator: 'eq', value: 'true' },
          },
          description: 'All config drifts have been corrected',
        },
        thenStep: {
          stepId: 'step-007a',
          type: 'human_notification',
          name: 'Notify all configs aligned',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `All config drifts corrected on ${target}`,
            detail: 'Environment variables, secrets, and config files now match expected production state.',
            contextReferences: ['post_correction_status'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-007b',
          type: 'human_notification',
          name: 'Notify remaining drifts require manual fix',
          recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
          message: {
            summary: `Remaining config drifts on ${target} require manual intervention`,
            detail: 'Automated corrections resolved some drifts but others remain. Review the post-correction scan and apply manual fixes.',
            contextReferences: ['post_correction_status'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 8: Recovery summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send config drift recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Config drift recovery completed on ${target}`,
          detail: 'Environment variables restored, expired secrets rotated, config file alignment verified. Monitor application health post-recovery.',
          contextReferences: ['post_correction_status'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'config-drift',
        agentName: 'config-drift-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'config_file_drift',
        estimatedDuration: 'PT5M',
        summary: `Recover from config drift on ${target}: restore env vars, rotate expired secrets, verify config file alignment.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'application-config',
            role: 'deployment',
            impactType: 'config_values_restored',
          },
        ],
        affectedServices: ['application', 'api-gateway'],
        estimatedUserImpact: 'Brief service restart may occur when environment variables are updated. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each config correction is independently reversible. Environment variable snapshots captured before each change enable full rollback.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult> {
    const failedSteps = executionState.completedSteps.filter((s) => s.status === 'failed');

    if (failedSteps.length === 0) {
      return { action: 'continue' };
    }

    const failedNames = failedSteps.map((s) => s.stepId).join(', ');

    return {
      action: 'abort',
      reason: `Corrections failed for steps: ${failedNames}. Manual intervention required for remaining drifts.`,
    };
  }
}
