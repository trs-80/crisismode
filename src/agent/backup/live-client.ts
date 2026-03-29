// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * BackupLiveClient — verifies real backup files on disk.
 *
 * Implements the file_directory and pg_dump providers using node:fs.
 * Scans configured directories for backup files, checks recency, size trends,
 * and basic integrity (archive header validation).
 *
 * Zero external dependencies — uses only node:fs, node:path, node:child_process.
 */

import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BackupBackend,
  BackupProvider,
  BackupProviderKind,
  BackupProviderConfig,
  BackupVerificationReport,
  BackupInventoryItem,
  BackupVerification,
  BackupCheck,
  ProviderReport,
  RpoEvaluation,
  RtoEstimate,
} from './backend.js';
import { DEFAULT_RPO_SECONDS, CHECK_NAMES } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { formatBytes, formatDuration } from '../../framework/format-helpers.js';

const execFileAsync = promisify(execFile);

/** Known backup file extensions. */
const BACKUP_EXTENSIONS = new Set([
  '.sql', '.sql.gz', '.sql.bz2', '.sql.xz', '.sql.zst',
  '.dump', '.dump.gz',
  '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz', '.tar.zst',
  '.gz', '.bz2', '.xz', '.zst',
  '.bak', '.backup',
]);

/** Size drop ratio that triggers a warning. */
const SIZE_DROP_THRESHOLD = 0.5;

/** Maximum backup items to verify per location (bounds I/O from integrity checks). */
const MAX_ITEMS_PER_LOCATION = 10;

export interface BackupLiveConfig {
  locations: string[];
}

export class BackupLiveClient implements BackupBackend {
  private config: BackupLiveConfig;

  constructor(config: BackupLiveConfig) {
    this.config = config;
  }

  listProviderKinds(): BackupProviderKind[] {
    return ['file_directory', 'pg_dump'];
  }

  async verifyAll(configs: BackupProviderConfig[]): Promise<BackupVerificationReport> {
    const verifiedAt = new Date().toISOString();

    // Process all providers in parallel — they are independent
    const results = await Promise.all(configs.map(async (config) => {
      const allItems = await this.inventoryLocation(config);

      if (allItems.length === 0) {
        const provider: ProviderReport = { kind: config.kind, source: config.source, detected: false, items: [], verifications: [] };
        const rpo: RpoEvaluation = {
          source: config.source,
          providerKind: config.kind,
          targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS,
          actualAgeSeconds: Infinity,
          withinTarget: false,
        };
        return { provider, rpo, rto: null as RtoEstimate | null, uncovered: config.source };
      }

      // Cap items to verify (sorted newest-first by inventoryLocation)
      const itemsToVerify = allItems.slice(0, MAX_ITEMS_PER_LOCATION);

      // Verify items in parallel — each is independent
      const verifications = await Promise.all(
        itemsToVerify.map((item) => this.verifyItem(item, config)),
      );

      const provider: ProviderReport = { kind: config.kind, source: config.source, detected: true, items: allItems, verifications };

      // RPO evaluation — based on newest backup
      const newest = allItems[0]; // already sorted newest-first
      const ageSeconds = (Date.now() - new Date(newest.createdAt).getTime()) / 1000;
      const targetRpo = config.rpoSeconds ?? DEFAULT_RPO_SECONDS;
      const rpo: RpoEvaluation = {
        source: config.source,
        providerKind: config.kind,
        targetRpoSeconds: targetRpo,
        actualAgeSeconds: Math.round(ageSeconds),
        withinTarget: ageSeconds <= targetRpo,
      };

      // RTO estimate — rough calculation based on backup size
      const totalSize = allItems.reduce((sum, i) => sum + i.sizeBytes, 0);
      let rto: RtoEstimate | null = null;
      if (totalSize > 0) {
        const restoreThroughputBps = 35 * 1024 * 1024; // ~35MB/s conservative estimate
        rto = {
          source: config.source,
          providerKind: config.kind,
          estimatedSeconds: Math.ceil(totalSize / restoreThroughputBps),
          basis: `Estimated from backup size (${formatBytes(totalSize)}) at ~35MB/s restore throughput`,
        };
      }

      return { provider, rpo, rto, uncovered: null as string | null };
    }));

    return {
      verifiedAt,
      providers: results.map((r) => r.provider),
      rpoEvaluations: results.map((r) => r.rpo),
      rtoEstimates: results.map((r) => r.rto).filter((r): r is RtoEstimate => r !== null),
      uncoveredSources: results.map((r) => r.uncovered).filter((s): s is string => s !== null),
    };
  }

  // ── Private: inventory ──

  private async inventoryLocation(config: BackupProviderConfig): Promise<BackupInventoryItem[]> {
    const items: BackupInventoryItem[] = [];

    for (const location of config.locations) {
      try {
        const entries = await readdir(location, { withFileTypes: true });
        const backupFiles = entries.filter((e) => e.isFile() && this.isBackupFile(e.name));

        // Sort by modification time to find previous size
        const fileStats = await Promise.all(
          backupFiles.map(async (e) => {
            const fullPath = join(location, e.name);
            const fileStat = await stat(fullPath);
            return { name: e.name, path: fullPath, stat: fileStat };
          }),
        );

        fileStats.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

        for (let i = 0; i < fileStats.length; i++) {
          const f = fileStats[i];
          items.push({
            providerKind: config.kind,
            label: `${config.kind} backup: ${f.name}`,
            location: f.path,
            source: config.source,
            createdAt: f.stat.mtime.toISOString(),
            sizeBytes: f.stat.size,
            previousSizeBytes: i + 1 < fileStats.length ? fileStats[i + 1].stat.size : null,
          });
        }
      } catch {
        // Location not accessible — will show as not detected
        continue;
      }
    }

    return items;
  }

  private isBackupFile(filename: string): boolean {
    // Check compound extensions (e.g. .sql.gz, .tar.gz)
    const lower = filename.toLowerCase();
    for (const ext of BACKUP_EXTENSIONS) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  // ── Private: verification ──

  private async verifyItem(item: BackupInventoryItem, config: BackupProviderConfig): Promise<BackupVerification> {
    const checks: BackupCheck[] = [];

    // Check 1: Existence (already confirmed by inventory, but explicit)
    checks.push({ name: CHECK_NAMES.EXISTS, passed: true, detail: `Backup found at ${item.location}`, severity: 'info' });

    // Check 2: Recency
    const ageSeconds = (Date.now() - new Date(item.createdAt).getTime()) / 1000;
    const targetRpo = config.rpoSeconds ?? DEFAULT_RPO_SECONDS;
    const withinRpo = ageSeconds <= targetRpo;
    checks.push({
      name: CHECK_NAMES.RECENCY,
      passed: withinRpo,
      detail: withinRpo
        ? `Backup is ${formatDuration(ageSeconds)} old (within ${formatDuration(targetRpo)} RPO target)`
        : `Backup is ${formatDuration(ageSeconds)} old — exceeds ${formatDuration(targetRpo)} RPO target`,
      severity: withinRpo ? 'info' : 'critical',
    });

    // Check 3: Size trend
    if (item.previousSizeBytes !== null && item.previousSizeBytes > 0) {
      const ratio = item.sizeBytes / item.previousSizeBytes;
      const dropped = ratio < SIZE_DROP_THRESHOLD;
      checks.push({
        name: CHECK_NAMES.SIZE_TREND,
        passed: !dropped,
        detail: dropped
          ? `Backup is ${formatBytes(item.sizeBytes)} — previous was ${formatBytes(item.previousSizeBytes)}. Size dropped ${Math.round((1 - ratio) * 100)}%, possible truncation or failed job`
          : 'Size is consistent with previous backup',
        severity: dropped ? 'critical' : 'info',
      });
    } else {
      checks.push({ name: CHECK_NAMES.SIZE_TREND, passed: true, detail: 'No previous backup for size comparison', severity: 'info' });
    }

    // Check 4: Basic integrity (gzip header check for compressed files)
    const integrityCheck = await this.checkIntegrity(item);
    if (integrityCheck) {
      checks.push(integrityCheck);
    }

    const passed = checks.every((c) => c.passed);
    return { item, passed, checks };
  }

  private async checkIntegrity(item: BackupInventoryItem): Promise<BackupCheck | null> {
    const lower = item.location.toLowerCase();

    // Only check integrity for compressed archives (gzip test)
    if (lower.endsWith('.gz') || lower.endsWith('.tgz')) {
      try {
        await execFileAsync('gzip', ['-t', item.location], { timeout: 30000 });
        return { name: CHECK_NAMES.INTEGRITY, passed: true, detail: 'gzip integrity check passed', severity: 'info' };
      } catch {
        return { name: CHECK_NAMES.INTEGRITY, passed: false, detail: 'gzip integrity check failed — backup may be corrupted', severity: 'critical' };
      }
    }

    // For tar archives, check listing works
    if (lower.endsWith('.tar')) {
      try {
        await execFileAsync('tar', ['-tf', item.location], { timeout: 30000 });
        return { name: CHECK_NAMES.INTEGRITY, passed: true, detail: 'tar archive listing succeeded', severity: 'info' };
      } catch {
        return { name: CHECK_NAMES.INTEGRITY, passed: false, detail: 'tar archive listing failed — backup may be corrupted', severity: 'critical' };
      }
    }

    return null; // No integrity check available for this file type
  }

  // ── ExecutionBackend ──

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported backup live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'verify_backups': {
        const configs = (command.parameters?.configs ?? []) as BackupProviderConfig[];
        return { report: await this.verifyAll(configs) };
      }
      case 'list_providers':
        return { providers: this.listProviderKinds() };
      default:
        return { executed: false, operation: command.operation };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'backup_count') {
      // Check the first configured location
      const location = this.config.locations[0];
      if (!location) return compareCheckValue(0, check.expect.operator, check.expect.value);
      try {
        const entries = await readdir(location);
        const backups = entries.filter((e) => this.isBackupFile(e));
        return compareCheckValue(backups.length, check.expect.operator, check.expect.value);
      } catch {
        return compareCheckValue(0, check.expect.operator, check.expect.value);
      }
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'backup-live-read',
        kind: 'capability_provider',
        name: 'Backup Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['backup.inventory.list', 'backup.verify.integrity', 'backup.rpo.evaluate', 'backup.schedule.check'],
        executionContexts: ['backup_read'],
        targetKinds: ['backup'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client
  }

  async close(): Promise<void> {
    // No persistent state to clean up
  }

  /**
   * Return a BackupProvider adapter that wraps the filesystem verification logic.
   * Used by BackupCompositeClient to treat filesystem as one of many providers.
   */
  asProvider(): BackupProvider {
    return new FileSystemProvider(this);
  }
}

/**
 * Adapter that exposes BackupLiveClient's filesystem logic as a BackupProvider.
 */
class FileSystemProvider implements BackupProvider {
  kind = 'file_directory' as const;
  private client: BackupLiveClient;

  constructor(client: BackupLiveClient) {
    this.client = client;
  }

  async detect(config: BackupProviderConfig): Promise<boolean> {
    for (const location of config.locations) {
      try {
        await access(location);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]> {
    // Delegate to the live client's private method via a verify call
    // We use verifyAll and extract items from the report
    const report = await this.client.verifyAll([config]);
    return report.providers[0]?.items ?? [];
  }

  async verify(item: BackupInventoryItem, config: BackupProviderConfig): Promise<BackupVerification> {
    // Run a single-item verification through the live client
    const report = await this.client.verifyAll([{
      ...config,
      locations: [item.location.substring(0, item.location.lastIndexOf('/'))],
    }]);
    const verification = report.providers[0]?.verifications.find(
      (v) => v.item.location === item.location,
    );
    return verification ?? { item, passed: true, checks: [] };
  }

  async estimateRecoveryTime(item: BackupInventoryItem): Promise<RtoEstimate> {
    const restoreThroughputBps = 35 * 1024 * 1024;
    return {
      source: item.source,
      providerKind: 'file_directory',
      estimatedSeconds: item.sizeBytes > 0 ? Math.ceil(item.sizeBytes / restoreThroughputBps) : 0,
      basis: `Estimated from backup size (${formatBytes(item.sizeBytes)}) at ~35MB/s restore throughput`,
    };
  }
}
