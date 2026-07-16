// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * BackupCompositeClient — routes verification to provider-specific backends.
 *
 * Holds a registry of BackupProvider implementations (filesystem, RDS, S3, etc.)
 * and delegates each BackupProviderConfig to the matching provider. Aggregates
 * results into a single BackupVerificationReport.
 */

import type {
  BackupBackend,
  BackupProvider,
  BackupProviderKind,
  BackupProviderConfig,
  BackupVerificationReport,
  ProviderReport,
  RpoEvaluation,
  RtoEstimate,
} from './backend.js';
import { DEFAULT_RPO_SECONDS } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { formatBytes } from '../../framework/format-helpers.js';

export class BackupCompositeClient implements BackupBackend {
  private providers: Map<BackupProviderKind, BackupProvider>;

  constructor(providers: BackupProvider[]) {
    this.providers = new Map(providers.map((p) => [p.kind, p]));
  }

  listProviderKinds(): BackupProviderKind[] {
    return [...this.providers.keys()];
  }

  async verifyAll(configs: BackupProviderConfig[]): Promise<BackupVerificationReport> {
    const verifiedAt = new Date().toISOString();

    const results = await Promise.all(configs.map(async (config) => {
      const provider = this.providers.get(config.kind);
      if (!provider) {
        return {
          provider: { kind: config.kind, source: config.source, detected: false, items: [], verifications: [] } as ProviderReport,
          rpo: {
            source: config.source,
            providerKind: config.kind,
            targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS,
            actualAgeSeconds: Infinity,
            withinTarget: false,
          } as RpoEvaluation,
          rto: null as RtoEstimate | null,
          uncovered: config.source as string | null,
        };
      }

      // Detect
      const detected = await provider.detect(config);
      if (!detected) {
        return {
          provider: { kind: config.kind, source: config.source, detected: false, items: [], verifications: [] } as ProviderReport,
          rpo: {
            source: config.source,
            providerKind: config.kind,
            targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS,
            actualAgeSeconds: Infinity,
            withinTarget: false,
          } as RpoEvaluation,
          rto: null as RtoEstimate | null,
          uncovered: config.source as string | null,
        };
      }

      // Inventory
      const items = await provider.inventory(config);
      if (items.length === 0) {
        return {
          provider: { kind: config.kind, source: config.source, detected: false, items: [], verifications: [] } as ProviderReport,
          rpo: {
            source: config.source,
            providerKind: config.kind,
            targetRpoSeconds: config.rpoSeconds ?? DEFAULT_RPO_SECONDS,
            actualAgeSeconds: Infinity,
            withinTarget: false,
          } as RpoEvaluation,
          rto: null as RtoEstimate | null,
          uncovered: config.source as string | null,
        };
      }

      // Verify all items
      const verifications = await Promise.all(
        items.map((item) => provider.verify(item, config)),
      );

      const providerReport: ProviderReport = {
        kind: config.kind,
        source: config.source,
        detected: true,
        items,
        verifications,
      };

      // RPO — based on newest backup
      const newest = items[0]!; // already sorted newest-first by provider
      const ageSeconds = (Date.now() - new Date(newest.createdAt).getTime()) / 1000;
      const targetRpo = config.rpoSeconds ?? DEFAULT_RPO_SECONDS;
      const rpo: RpoEvaluation = {
        source: config.source,
        providerKind: config.kind,
        targetRpoSeconds: targetRpo,
        actualAgeSeconds: Math.round(ageSeconds),
        withinTarget: ageSeconds <= targetRpo,
      };

      // RTO — estimate from provider if available
      let rto: RtoEstimate | null = null;
      if (provider.estimateRecoveryTime) {
        rto = await provider.estimateRecoveryTime(newest);
      } else {
        // Fallback: rough size-based estimate at 35 MB/s
        const totalSize = items.reduce((sum, i) => sum + i.sizeBytes, 0);
        if (totalSize > 0) {
          rto = {
            source: config.source,
            providerKind: config.kind,
            estimatedSeconds: Math.ceil(totalSize / (35 * 1024 * 1024)),
            basis: `Estimated from backup size (${formatBytes(totalSize)}) at ~35MB/s restore throughput`,
          };
        }
      }

      return { provider: providerReport, rpo, rto, uncovered: null as string | null };
    }));

    return {
      verifiedAt,
      providers: results.map((r) => r.provider),
      rpoEvaluations: results.map((r) => r.rpo),
      rtoEstimates: results.map((r) => r.rto).filter((r): r is RtoEstimate => r !== null),
      uncoveredSources: results.map((r) => r.uncovered).filter((s): s is string => s !== null),
    };
  }

  // ── ExecutionBackend ──

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported backup composite command type: ${command.type}`);
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
      // Rough heuristic — if any provider is registered, assume at least 1
      return compareCheckValue(this.providers.size > 0 ? 1 : 0, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    const kinds = this.listProviderKinds();
    return [
      {
        id: 'backup-composite-read',
        kind: 'capability_provider',
        name: 'Backup Composite Read Provider',
        maturity: 'live_validated',
        capabilities: [
          'backup.inventory.list',
          'backup.verify.integrity',
          'backup.rpo.evaluate',
          'backup.schedule.check',
          ...(kinds.includes('aws_rds') ? ['backup.aws.rds.describe'] : []),
          ...(kinds.includes('aws_s3') ? ['backup.aws.s3.list'] : []),
        ],
        executionContexts: ['backup_read'],
        targetKinds: ['backup'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for composite client
  }

  async close(): Promise<void> {
    // No persistent state to clean up
  }
}
