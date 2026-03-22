// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { defaultReplan } from '../interface.js';
import { backupManifest } from './manifest.js';
import type {
  BackupBackend,
  BackupProviderConfig,
  BackupVerificationReport,
  ProviderReport,
  RpoEvaluation,
} from './backend.js';
import { BackupSimulator } from './simulator.js';

/** Default RPO if not configured: 24 hours. */
const DEFAULT_RPO_SECONDS = 86400;

/** Size drop threshold that triggers a size anomaly alert. */
const SIZE_DROP_THRESHOLD = 0.5; // 50% drop from previous

function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)}m`;
  return `${seconds}s`;
}

export class BackupVerificationAgent implements RecoveryAgent {
  manifest = backupManifest;
  backend: BackupBackend;

  constructor(backend?: BackupBackend) {
    this.backend = backend ?? new BackupSimulator();
  }

  async assessHealth(context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const configs = this.extractConfigs(context);
    const report = await this.backend.verifyAll(configs);

    const { hasFailedVerifications, hasStaleBackups, hasMissingBackups, hasUncoveredSources } =
      this.classifyReport(report);

    const isCritical = hasMissingBackups || hasFailedVerifications;
    const isWarning = hasStaleBackups || hasUncoveredSources;

    const status = isCritical ? 'unhealthy' : isWarning ? 'recovering' : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'backup_existence',
        status: signalStatus(hasMissingBackups, false),
        detail: hasMissingBackups
          ? `No backups found for: ${report.providers.filter((p) => !p.detected).map((p) => p.source).join(', ')}`
          : `Backups detected for all ${report.providers.length} configured source(s)`,
        observedAt,
      },
      {
        source: 'backup_recency',
        status: signalStatus(false, hasStaleBackups),
        detail: this.buildRecencyDetail(report.rpoEvaluations),
        observedAt,
      },
      {
        source: 'backup_integrity',
        status: signalStatus(hasFailedVerifications, false),
        detail: this.buildIntegrityDetail(report.providers),
        observedAt,
      },
      {
        source: 'backup_coverage',
        status: signalStatus(false, hasUncoveredSources),
        detail: report.uncoveredSources.length > 0
          ? `Uncovered sources: ${report.uncoveredSources.join(', ')}`
          : 'All configured sources have backup coverage',
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: 'All backups are verified, recent, and within RPO targets.',
        recovering: 'Backup warnings detected. Some backups are stale or sources are uncovered.',
        unhealthy: 'Backup failures detected. Missing or corrupted backups require immediate attention.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring backup health.'],
        recovering: [
          'Review stale backups and verify backup job schedules.',
          'Configure backup providers for uncovered sources.',
        ],
        unhealthy: [
          'Immediately investigate missing or failed backups.',
          'Run manual backup for affected sources.',
          'Verify backup job configuration and credentials.',
        ],
      },
    });
  }

  async diagnose(context: AgentContext): Promise<DiagnosisResult> {
    const configs = this.extractConfigs(context);
    const report = await this.backend.verifyAll(configs);

    const { hasFailedVerifications, hasStaleBackups, hasMissingBackups, hasUncoveredSources, hasSizeAnomalies, hasRtoRisk } =
      this.classifyReport(report);

    // Scenario classification — first match wins (most severe first)
    let scenario: string | null;
    let confidence: number;

    if (hasMissingBackups && report.providers.every((p) => !p.detected)) {
      scenario = 'no_backups_found';
      confidence = 0.98;
    } else if (hasFailedVerifications) {
      // Distinguish between integrity failure and size anomaly
      const hasIntegrityCheck = report.providers.some((p) =>
        p.verifications.some((v) => v.checks.some((c) => c.name === 'integrity' && !c.passed)),
      );
      if (hasIntegrityCheck) {
        scenario = 'integrity_failure';
        confidence = 0.95;
      } else if (hasSizeAnomalies) {
        scenario = 'size_anomaly';
        confidence = 0.92;
      } else {
        scenario = 'integrity_failure';
        confidence = 0.90;
      }
    } else if (hasStaleBackups) {
      scenario = 'stale_backup';
      confidence = 0.95;
    } else if (hasUncoveredSources) {
      scenario = 'incomplete_coverage';
      confidence = 0.90;
    } else if (hasRtoRisk) {
      scenario = 'rto_at_risk';
      confidence = 0.85;
    } else {
      scenario = null;
      confidence = 1.0;
    }

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'backup_inventory',
          observation: this.buildInventoryObservation(report),
          severity: hasMissingBackups ? 'critical' : 'info',
          data: { providers: report.providers.map((p) => ({ kind: p.kind, source: p.source, detected: p.detected, itemCount: p.items.length })) },
        },
        {
          source: 'backup_verification',
          observation: this.buildVerificationObservation(report),
          severity: hasFailedVerifications ? 'critical' : 'info',
          data: { verifications: report.providers.flatMap((p) => p.verifications.map((v) => ({ source: v.item.source, passed: v.passed, checks: v.checks }))) },
        },
        {
          source: 'rpo_compliance',
          observation: this.buildRpoObservation(report.rpoEvaluations),
          severity: hasStaleBackups ? 'warning' : 'info',
          data: { rpoEvaluations: report.rpoEvaluations },
        },
        {
          source: 'backup_coverage',
          observation: report.uncoveredSources.length > 0
            ? `${report.uncoveredSources.length} source(s) have no backup coverage: ${report.uncoveredSources.join(', ')}.`
            : 'All configured sources have backup coverage.',
          severity: hasUncoveredSources ? 'warning' : 'info',
          data: { uncoveredSources: report.uncoveredSources },
        },
        ...(report.rtoEstimates.length > 0
          ? [{
              source: 'rto_assessment' as const,
              observation: report.rtoEstimates.map((r) => `${r.source}: estimated ${formatDuration(r.estimatedSeconds)} restore time (${r.basis})`).join('; '),
              severity: hasRtoRisk ? ('warning' as const) : ('info' as const),
              data: { rtoEstimates: report.rtoEstimates },
            }]
          : []),
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'backup-targets');
    const scenario = diagnosis.scenario ?? 'stale_backup';

    const steps: RecoveryStep[] = [
      // Step 1: Enumerate all configured backup providers
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Enumerate backup providers and inventory',
        executionContext: 'backup_read',
        target,
        command: {
          type: 'api_call',
          operation: 'list_providers',
          parameters: {},
        },
        outputCapture: {
          name: 'backup_providers',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Run full verification
      {
        stepId: 'step-002',
        type: 'diagnosis_action',
        name: 'Verify all backups',
        executionContext: 'backup_read',
        target,
        command: {
          type: 'api_call',
          operation: 'verify_backups',
          parameters: {},
        },
        outputCapture: {
          name: 'verification_report',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT2M',
      },
      // Step 3: Notify with findings
      {
        stepId: 'step-003',
        type: 'human_notification',
        name: 'Notify on-call with backup verification results',
        recipients: [
          { role: 'on_call_engineer', urgency: this.scenarioUrgency(scenario) },
          { role: 'database_administrator', urgency: this.scenarioUrgency(scenario) },
        ],
        message: {
          summary: `Backup ${scenario.replace(/_/g, ' ')} detected for ${target}`,
          detail: this.buildRecoveryGuidance(scenario),
          contextReferences: ['backup_providers', 'verification_report'],
          actionRequired: scenario !== 'rto_at_risk',
        },
        channel: 'auto',
      },
      // Step 4: Checkpoint for audit trail
      {
        stepId: 'step-004',
        type: 'checkpoint',
        name: 'Record backup verification state',
        description: 'Capture backup verification results for incident report and audit trail.',
        stateCaptures: [
          {
            name: 'backup_verification_snapshot',
            captureType: 'command_output',
            statement: 'verify_backups',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 5: Conditional — route based on scenario severity
      {
        stepId: 'step-005',
        type: 'conditional',
        name: 'Route based on backup verification severity',
        condition: {
          description: 'At least one backup exists and passes verification',
          check: {
            type: 'api_call',
            statement: 'all_verifications_passed',
            expect: { operator: 'eq', value: true },
          },
        },
        thenStep: {
          stepId: 'step-005a',
          type: 'human_notification',
          name: 'Backup verification advisory',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `Backup verification complete for ${target}`,
            detail: 'All backups pass verification checks. Review RPO/RTO compliance and coverage gaps in the full report.',
            contextReferences: ['verification_report'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-005b',
          type: 'human_notification',
          name: 'URGENT: Backup verification failures',
          recipients: [
            { role: 'on_call_engineer', urgency: 'critical' },
            { role: 'database_administrator', urgency: 'critical' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `CRITICAL: Backup verification failures for ${target}`,
            detail: 'One or more backups failed verification. Your disaster recovery readiness is compromised. Investigate immediately — run manual backups, check backup job logs, and verify storage connectivity.',
            contextReferences: ['verification_report'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 6: Replanning checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Re-check backup state after notification',
        description: 'Verify whether backup state has changed since notifications were sent.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_notification_backup_state',
            captureType: 'command_output',
            statement: 'verify_backups',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Final summary
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'Backup verification assessment summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'low' },
        ],
        message: {
          summary: `Backup verification assessment complete for ${target}`,
          detail: `Scenario: ${scenario.replace(/_/g, ' ')}. All configured backup sources have been inventoried, verified, and RPO/RTO compliance evaluated. Responsible teams have been notified.`,
          contextReferences: ['post_notification_backup_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'backup',
        agentName: 'backup-verification',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT5M',
        summary: `Verify backup health for ${target}: inventory providers, run verification checks, evaluate RPO/RTO compliance, and notify teams with ${scenario.replace(/_/g, ' ')} findings.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'backup',
            role: 'backup-storage',
            impactType: 'backup_assessment_and_notification',
          },
        ],
        affectedServices: [],
        estimatedUserImpact: scenario === 'no_backups_found' || scenario === 'integrity_failure'
          ? 'Disaster recovery capability is compromised. Data loss risk is elevated until backups are restored.'
          : 'No immediate user impact. Proactive verification prevents future data loss.',
        dataLossRisk: scenario === 'no_backups_found' || scenario === 'integrity_failure' ? 'possible' : 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'none',
        description: 'This plan is read-only and notification-based. No system mutations to roll back.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return defaultReplan();
  }

  // ── Private helpers ──

  private extractConfigs(context: AgentContext): BackupProviderConfig[] {
    const payload = context.trigger.payload;

    // If configs are passed directly in trigger payload
    if (payload.backupConfigs && Array.isArray(payload.backupConfigs)) {
      return payload.backupConfigs as BackupProviderConfig[];
    }

    // Build default configs from target info
    const host = String(payload.instance || payload.host || '/var/backups');
    const source = String(payload.database || payload.source || 'default');

    return [
      {
        kind: 'file_directory',
        locations: [host],
        source,
        rpoSeconds: DEFAULT_RPO_SECONDS,
      },
    ];
  }

  private classifyReport(report: BackupVerificationReport) {
    const hasMissingBackups = report.providers.some((p) => !p.detected);
    const hasFailedVerifications = report.providers.some((p) =>
      p.verifications.some((v) => !v.passed),
    );
    const hasStaleBackups = report.rpoEvaluations.some((r) => !r.withinTarget);
    const hasUncoveredSources = report.uncoveredSources.length > 0;
    const hasSizeAnomalies = report.providers.some((p) =>
      p.verifications.some((v) => v.checks.some((c) => c.name === 'size_trend' && !c.passed)),
    );
    const hasRtoRisk = report.rtoEstimates.length > 0 &&
      report.rtoEstimates.some((r) => r.estimatedSeconds > 3600); // >1h is risky

    return { hasFailedVerifications, hasStaleBackups, hasMissingBackups, hasUncoveredSources, hasSizeAnomalies, hasRtoRisk };
  }

  private buildRecencyDetail(evals: RpoEvaluation[]): string {
    if (evals.length === 0) return 'No RPO data available.';
    const parts = evals.map((e) => {
      if (!isFinite(e.actualAgeSeconds)) return `${e.source}: no backup found`;
      const age = formatDuration(e.actualAgeSeconds);
      const target = formatDuration(e.targetRpoSeconds);
      return `${e.source}: ${age} old (RPO target: ${target})${e.withinTarget ? '' : ' — EXCEEDS TARGET'}`;
    });
    return parts.join('; ');
  }

  private buildIntegrityDetail(providers: ProviderReport[]): string {
    const results = providers.flatMap((p) => p.verifications);
    if (results.length === 0) return 'No backups to verify.';
    const passed = results.filter((v) => v.passed).length;
    const failed = results.filter((v) => !v.passed).length;
    if (failed === 0) return `All ${passed} backup(s) pass verification.`;
    const failedDetails = results
      .filter((v) => !v.passed)
      .map((v) => {
        const failedChecks = v.checks.filter((c) => !c.passed).map((c) => c.detail);
        return `${v.item.source}: ${failedChecks.join('; ')}`;
      });
    return `${failed} of ${passed + failed} backup(s) failed verification: ${failedDetails.join('. ')}`;
  }

  private buildInventoryObservation(report: BackupVerificationReport): string {
    const detected = report.providers.filter((p) => p.detected);
    const missing = report.providers.filter((p) => !p.detected);
    const parts: string[] = [];
    if (detected.length > 0) {
      parts.push(`${detected.length} provider(s) detected: ${detected.map((p) => `${p.kind} (${p.source}, ${p.items.length} backup(s))`).join(', ')}.`);
    }
    if (missing.length > 0) {
      parts.push(`${missing.length} provider(s) found no backups: ${missing.map((p) => `${p.kind} (${p.source})`).join(', ')}.`);
    }
    return parts.join(' ') || 'No backup providers configured.';
  }

  private buildVerificationObservation(report: BackupVerificationReport): string {
    const allVerifications = report.providers.flatMap((p) => p.verifications);
    if (allVerifications.length === 0) return 'No backups available for verification.';
    const passed = allVerifications.filter((v) => v.passed).length;
    const failed = allVerifications.filter((v) => !v.passed).length;
    if (failed === 0) return `All ${passed} backup(s) pass verification checks.`;

    const failureDetails = allVerifications
      .filter((v) => !v.passed)
      .map((v) => {
        const failedChecks = v.checks.filter((c) => !c.passed);
        return `${v.item.source} (${v.item.providerKind}): ${failedChecks.map((c) => c.detail).join('; ')}`;
      });
    return `${failed} of ${passed + failed} backup(s) failed: ${failureDetails.join('. ')}.`;
  }

  private buildRpoObservation(evals: RpoEvaluation[]): string {
    if (evals.length === 0) return 'No RPO targets configured.';
    const violations = evals.filter((e) => !e.withinTarget);
    if (violations.length === 0) return `All ${evals.length} source(s) are within RPO targets.`;
    return `${violations.length} source(s) exceed RPO targets: ${violations.map((e) => `${e.source} (${isFinite(e.actualAgeSeconds) ? formatDuration(e.actualAgeSeconds) : 'no backup'} vs ${formatDuration(e.targetRpoSeconds)} target)`).join(', ')}.`;
  }

  private scenarioUrgency(scenario: string): 'low' | 'medium' | 'high' | 'critical' {
    switch (scenario) {
      case 'no_backups_found':
      case 'integrity_failure':
        return 'critical';
      case 'stale_backup':
      case 'size_anomaly':
        return 'high';
      case 'incomplete_coverage':
      case 'rto_at_risk':
        return 'medium';
      default:
        return 'medium';
    }
  }

  private buildRecoveryGuidance(scenario: string): string {
    const parts: string[] = [];

    switch (scenario) {
      case 'no_backups_found':
        parts.push('CRITICAL: No backups found at any configured location.');
        parts.push('Your disaster recovery capability is non-existent.');
        parts.push('');
        parts.push('Immediate actions:');
        parts.push('1. Verify backup job configuration and credentials');
        parts.push('2. Check backup storage accessibility (permissions, mount points, network)');
        parts.push('3. Run a manual backup immediately for all critical systems');
        parts.push('4. Review backup job logs for silent failures');
        parts.push('5. Verify cron/scheduler is running backup jobs');
        break;

      case 'stale_backup':
        parts.push('WARNING: Backups exist but exceed RPO targets.');
        parts.push('If a disaster occurred now, you would lose more data than your recovery objectives allow.');
        parts.push('');
        parts.push('Investigation steps:');
        parts.push('1. Check if backup jobs are still scheduled and running');
        parts.push('2. Review backup job logs for recent failures');
        parts.push('3. Verify storage capacity at backup destination');
        parts.push('4. Check for lock files from stuck backup processes');
        parts.push('5. Run a manual backup to restore RPO compliance');
        break;

      case 'size_anomaly':
        parts.push('WARNING: Backup size dropped significantly from previous run.');
        parts.push('This often indicates a truncated dump, failed job that wrote partial output, or a misconfigured backup scope.');
        parts.push('');
        parts.push('Investigation steps:');
        parts.push('1. Compare current backup file with previous successful backup');
        parts.push('2. Check backup job logs for errors or early termination');
        parts.push('3. Verify the backup scope has not changed (databases, tables, paths)');
        parts.push('4. Attempt a test restore to confirm backup viability');
        parts.push('5. Re-run the backup job and compare sizes');
        break;

      case 'integrity_failure':
        parts.push('CRITICAL: Backup integrity check failed — data is corrupted.');
        parts.push('This backup cannot be used for disaster recovery.');
        parts.push('');
        parts.push('Immediate actions:');
        parts.push('1. Do NOT delete the corrupted backup (preserve for forensics)');
        parts.push('2. Run a fresh backup immediately');
        parts.push('3. Verify the new backup passes integrity checks');
        parts.push('4. Check storage media health (disk errors, filesystem corruption)');
        parts.push('5. Review backup pipeline for compression or transfer errors');
        break;

      case 'incomplete_coverage':
        parts.push('WARNING: Some configured sources have no backup provider.');
        parts.push('These systems have no disaster recovery protection.');
        parts.push('');
        parts.push('Actions:');
        parts.push('1. Review which sources are not covered');
        parts.push('2. Configure backup providers for uncovered sources');
        parts.push('3. Prioritize databases and stateful services');
        parts.push('4. Consider adding backup verification to your CI/CD pipeline');
        break;

      case 'rto_at_risk':
        parts.push('ADVISORY: Estimated restore time may exceed recovery objectives.');
        parts.push('Backups are healthy, but their size means restoration could take longer than your RTO allows.');
        parts.push('');
        parts.push('Recommendations:');
        parts.push('1. Consider incremental backup strategies to reduce restore time');
        parts.push('2. Pre-stage restore infrastructure (warm standby)');
        parts.push('3. Test actual restore time with a DR drill');
        parts.push('4. Evaluate parallel restore capabilities');
        parts.push('5. Consider point-in-time recovery (WAL archiving) for databases');
        break;

      default:
        parts.push('Backup verification detected an issue. Review the verification report for details.');
        break;
    }

    return parts.join('\n');
  }
}
