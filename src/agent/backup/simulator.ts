// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  BackupBackend,
  BackupProviderKind,
  BackupProviderConfig,
  BackupVerificationReport,
  BackupInventoryItem,
  BackupVerification,
  ProviderReport,
  RpoEvaluation,
  RtoEstimate,
} from './backend.js';
import { DEFAULT_RPO_SECONDS, CHECK_NAMES } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { formatBytes } from '../../framework/format-helpers.js';

export type SimulatorState =
  | 'no_backups_found'
  | 'stale_backup'
  | 'size_anomaly'
  | 'integrity_failure'
  | 'incomplete_coverage'
  | 'rto_at_risk'
  | 'rds_snapshot_error'
  | 'glacier_restore_delay'
  | 's3_versioning_disabled'
  | 'healthy';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export class BackupSimulator implements BackupBackend {
  private state: SimulatorState = 'no_backups_found';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  listProviderKinds(): BackupProviderKind[] {
    return ['file_directory', 'pg_dump', 'aws_rds', 'aws_s3'];
  }

  async verifyAll(configs: BackupProviderConfig[]): Promise<BackupVerificationReport> {
    const now = new Date();
    const verifiedAt = now.toISOString();

    switch (this.state) {
      case 'no_backups_found':
        return this.buildNoBackupsReport(configs, verifiedAt);
      case 'stale_backup':
        return this.buildStaleBackupReport(configs, now, verifiedAt);
      case 'size_anomaly':
        return this.buildSizeAnomalyReport(configs, now, verifiedAt);
      case 'integrity_failure':
        return this.buildIntegrityFailureReport(configs, now, verifiedAt);
      case 'incomplete_coverage':
        return this.buildIncompleteCoverageReport(configs, now, verifiedAt);
      case 'rto_at_risk':
        return this.buildRtoAtRiskReport(configs, now, verifiedAt);
      case 'rds_snapshot_error':
        return this.buildRdsSnapshotErrorReport(configs, now, verifiedAt);
      case 'glacier_restore_delay':
        return this.buildGlacierRestoreDelayReport(configs, now, verifiedAt);
      case 's3_versioning_disabled':
        return this.buildS3VersioningDisabledReport(configs, now, verifiedAt);
      case 'healthy':
        return this.buildHealthyReport(configs, now, verifiedAt);
    }
  }

  // ── Scenario builders ──

  private buildNoBackupsReport(
    configs: BackupProviderConfig[],
    verifiedAt: string,
  ): BackupVerificationReport {
    return {
      verifiedAt,
      providers: configs.map((c) => ({
        kind: c.kind,
        source: c.source,
        detected: false,
        items: [],
        verifications: [],
      })),
      rpoEvaluations: configs.map((c) => ({
        source: c.source,
        providerKind: c.kind,
        targetRpoSeconds: c.rpoSeconds ?? DEFAULT_RPO_SECONDS,
        actualAgeSeconds: Infinity,
        withinTarget: false,
      })),
      rtoEstimates: [],
      uncoveredSources: configs.map((c) => c.source),
    };
  }

  private buildStaleBackupReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    const staleAge = 5 * DAY; // 5 days old — well past 24h RPO
    const items = this.makeItems(configs, now, staleAge, 2.5 * GB, 2.4 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item, config) => {
      const ageHours = Math.round(staleAge / HOUR);
      const targetHours = Math.round((config.rpoSeconds ?? DEFAULT_RPO_SECONDS) / 3600);
      return {
        item,
        passed: false,
        checks: [
          { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
          { name: CHECK_NAMES.RECENCY, passed: false, detail: `Backup is ${ageHours}h old — exceeds ${targetHours}h RPO target`, severity: 'critical' },
          { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
        ],
      };
    });
  }

  private buildSizeAnomalyReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // Current backup is suspiciously small — likely a truncated or failed dump
    const items = this.makeItems(configs, now, 6 * HOUR, 12 * MB, 2.5 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item,
      passed: false,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Backup is recent (6h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: false, detail: `Backup is ${formatBytes(item.sizeBytes)} — previous was ${formatBytes(item.previousSizeBytes ?? 0)}. Size dropped ${item.previousSizeBytes ? Math.round((1 - item.sizeBytes / item.previousSizeBytes) * 100) : 100}%, possible truncation or failed job`, severity: 'critical' },
      ],
    }));
  }

  private buildIntegrityFailureReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    const items = this.makeItems(configs, now, 8 * HOUR, 2.5 * GB, 2.4 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item,
      passed: false,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Backup is recent (8h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
        { name: CHECK_NAMES.INTEGRITY, passed: false, detail: 'Archive integrity check failed: unexpected end of file in archive header — backup is corrupted', severity: 'critical' },
      ],
    }));
  }

  private buildIncompleteCoverageReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // First provider is healthy, second has no backups at all
    const providers: ProviderReport[] = [];
    const rpoEvals: RpoEvaluation[] = [];
    const rtoEstimates: RtoEstimate[] = [];
    const uncovered: string[] = [];

    configs.forEach((config, i) => {
      if (i === 0) {
        const item = this.makeItem(config, now, 6 * HOUR, 2.5 * GB, 2.4 * GB);
        const verification: BackupVerification = {
          item,
          passed: true,
          checks: [
            { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
            { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Backup is recent (6h old)', severity: 'info' },
            { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
          ],
        };
        providers.push({ kind: config.kind, source: config.source, detected: true, items: [item], verifications: [verification] });
        rpoEvals.push({ source: config.source, providerKind: config.kind, targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS, actualAgeSeconds: 6 * 3600, withinTarget: true });
      } else {
        providers.push({ kind: config.kind, source: config.source, detected: false, items: [], verifications: [] });
        rpoEvals.push({ source: config.source, providerKind: config.kind, targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS, actualAgeSeconds: Infinity, withinTarget: false });
        uncovered.push(config.source);
      }
    });

    return { verifiedAt, providers, rpoEvaluations: rpoEvals, rtoEstimates, uncoveredSources: uncovered };
  }

  private buildRtoAtRiskReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // Backups are healthy, but they're so large that estimated restore time exceeds RTO
    const items = this.makeItems(configs, now, 4 * HOUR, 500 * GB, 490 * GB);
    const report = this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item,
      passed: true,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Backup is recent (4h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
      ],
    }));

    // Add RTO estimates that exceed target
    report.rtoEstimates = configs.map((c) => ({
      source: c.source,
      providerKind: c.kind,
      estimatedSeconds: 14400, // 4 hours estimated restore
      basis: `Estimated from backup size (${formatBytes(500 * GB)}) at ~35MB/s restore throughput`,
    }));

    return report;
  }

  private buildRdsSnapshotErrorReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // RDS snapshot exists but is in error state
    const items = this.makeItems(configs, now, 2 * HOUR, 50 * GB, 48 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item: { ...item, providerKind: 'aws_rds', snapshotStatus: 'error' },
      passed: false,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Snapshot found: ${item.location}`, severity: 'info' },
        { name: 'snapshot_status', passed: false, detail: 'Snapshot status: error — snapshot may not be usable for restore', severity: 'critical' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Snapshot is recent (2h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous snapshot', severity: 'info' },
      ],
    }));
  }

  private buildGlacierRestoreDelayReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // S3 backup exists but is in Glacier — RTO blows up
    const items = this.makeItems(configs, now, 6 * HOUR, 100 * GB, 98 * GB);
    const report = this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item: { ...item, providerKind: 'aws_s3', storageClass: 'GLACIER' },
      passed: false,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Object found: ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Object is recent (6h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
        { name: 'storage_class', passed: false, detail: 'Storage class: GLACIER — restore requires 3-12 hours before data is accessible', severity: 'warning' },
      ],
    }));

    // Glacier adds ~5h to RTO
    report.rtoEstimates = configs.map((c) => ({
      source: c.source,
      providerKind: 'aws_s3' as BackupProviderKind,
      estimatedSeconds: 20000, // ~5.5 hours
      basis: `S3 download at ~50MB/s for ${formatBytes(100 * GB)} + ~5h Glacier restore wait`,
    }));

    return report;
  }

  private buildS3VersioningDisabledReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    // S3 backup is healthy but bucket versioning is off
    const items = this.makeItems(configs, now, 6 * HOUR, 2.5 * GB, 2.4 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item: { ...item, providerKind: 'aws_s3', storageClass: 'STANDARD' },
      passed: false,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Object found: ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Object is recent (6h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
        { name: 'storage_class', passed: true, detail: 'Storage class: STANDARD', severity: 'info' },
        { name: 'versioning', passed: false, detail: 'Bucket versioning is not enabled — accidental deletions are permanent', severity: 'warning' },
      ],
    }));
  }

  private buildHealthyReport(
    configs: BackupProviderConfig[],
    now: Date,
    verifiedAt: string,
  ): BackupVerificationReport {
    const items = this.makeItems(configs, now, 6 * HOUR, 2.5 * GB, 2.4 * GB);
    return this.buildReport(configs, items, now, verifiedAt, (item) => ({
      item,
      passed: true,
      checks: [
        { name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' },
        { name: CHECK_NAMES.RECENCY, passed: true, detail: 'Backup is recent (6h old)', severity: 'info' },
        { name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'Size is consistent with previous backup', severity: 'info' },
      ],
    }));
  }

  // ── Helpers ──

  private makeItem(
    config: BackupProviderConfig,
    now: Date,
    ageMs: number,
    sizeBytes: number,
    previousSizeBytes: number,
  ): BackupInventoryItem {
    const location = config.locations[0] ?? '/var/backups';
    return {
      providerKind: config.kind,
      label: `${config.kind} backup of ${config.source}`,
      location: config.kind === 'pg_dump'
        ? `${location}/${config.source}_latest.sql.gz`
        : `${location}/${config.source}_latest.tar.gz`,
      source: config.source,
      createdAt: new Date(now.getTime() - ageMs).toISOString(),
      sizeBytes,
      previousSizeBytes,
    };
  }

  private makeItems(
    configs: BackupProviderConfig[],
    now: Date,
    ageMs: number,
    sizeBytes: number,
    previousSizeBytes: number,
  ): Map<string, BackupInventoryItem> {
    const map = new Map<string, BackupInventoryItem>();
    for (const config of configs) {
      map.set(config.source, this.makeItem(config, now, ageMs, sizeBytes, previousSizeBytes));
    }
    return map;
  }

  private buildReport(
    configs: BackupProviderConfig[],
    items: Map<string, BackupInventoryItem>,
    _now: Date,
    verifiedAt: string,
    verifyFn: (item: BackupInventoryItem, config: BackupProviderConfig) => BackupVerification,
  ): BackupVerificationReport {
    const providers: ProviderReport[] = [];
    const rpoEvals: RpoEvaluation[] = [];

    for (const config of configs) {
      const item = items.get(config.source);
      if (item) {
        const verification = verifyFn(item, config);
        providers.push({ kind: config.kind, source: config.source, detected: true, items: [item], verifications: [verification] });

        const ageSeconds = (Date.now() - new Date(item.createdAt).getTime()) / 1000;
        rpoEvals.push({
          source: config.source,
          providerKind: config.kind,
          targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS,
          actualAgeSeconds: Math.round(ageSeconds),
          withinTarget: ageSeconds <= (config.rpoSeconds ?? DEFAULT_RPO_SECONDS),
        });
      }
    }

    return { verifiedAt, providers, rpoEvaluations: rpoEvals, rtoEstimates: [], uncoveredSources: [] };
  }

  // ── ExecutionBackend ──

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported backup simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'verify_backups': {
        const configs = (command.parameters?.configs ?? []) as BackupProviderConfig[];
        return { report: await this.verifyAll(configs) };
      }
      case 'list_providers':
        return { providers: this.listProviderKinds() };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'backup_count') {
      const count = this.state === 'no_backups_found' ? 0 : 1;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt === 'backup_age_seconds') {
      const ageMap: Record<SimulatorState, number> = {
        no_backups_found: Infinity,
        stale_backup: 5 * 24 * 3600,
        size_anomaly: 6 * 3600,
        integrity_failure: 8 * 3600,
        incomplete_coverage: 6 * 3600,
        rto_at_risk: 4 * 3600,
        rds_snapshot_error: 2 * 3600,
        glacier_restore_delay: 6 * 3600,
        s3_versioning_disabled: 6 * 3600,
        healthy: 6 * 3600,
      };
      return compareCheckValue(ageMap[this.state], check.expect.operator, check.expect.value);
    }

    if (stmt === 'all_verifications_passed') {
      const passed = this.state === 'healthy' || this.state === 'rto_at_risk';
      return compareCheckValue(passed, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'backup-simulator-read',
        kind: 'capability_provider',
        name: 'Backup Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['backup.inventory.list', 'backup.verify.integrity', 'backup.rpo.evaluate', 'backup.schedule.check'],
        executionContexts: ['backup_read'],
        targetKinds: ['backup'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}
}
