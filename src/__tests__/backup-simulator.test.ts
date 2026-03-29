// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { BackupSimulator } from '../agent/backup/simulator.js';
import type { BackupProviderConfig } from '../agent/backup/backend.js';
import { CHECK_NAMES, DEFAULT_RPO_SECONDS } from '../agent/backup/backend.js';

/** Standard test configs used across most tests. */
function makeConfigs(): BackupProviderConfig[] {
  return [
    { kind: 'file_directory', locations: ['/var/backups/app'], source: 'app_db' },
    { kind: 'pg_dump', locations: ['/var/backups/postgres'], source: 'orders_db' },
  ];
}

describe('BackupSimulator', () => {
  // ---------------------------------------------------------------------------
  // verifyAll() — state-driven behavior
  // ---------------------------------------------------------------------------
  describe('verifyAll()', () => {
    it('no_backups_found: reports all providers as not detected', async () => {
      const sim = new BackupSimulator();
      const report = await sim.verifyAll(makeConfigs());

      expect(report.providers).toHaveLength(2);
      expect(report.providers.every((p) => !p.detected)).toBe(true);
      expect(report.providers.every((p) => p.items.length === 0)).toBe(true);
      expect(report.rpoEvaluations.every((r) => !r.withinTarget)).toBe(true);
      expect(report.uncoveredSources).toEqual(['app_db', 'orders_db']);
    });

    it('stale_backup: detects providers but fails recency check', async () => {
      const sim = new BackupSimulator();
      sim.transition('stale_backup');
      const report = await sim.verifyAll(makeConfigs());

      expect(report.providers.every((p) => p.detected)).toBe(true);
      for (const provider of report.providers) {
        expect(provider.verifications).toHaveLength(1);
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const recencyCheck = v.checks.find((c) => c.name === CHECK_NAMES.RECENCY);
        expect(recencyCheck?.passed).toBe(false);
        expect(recencyCheck?.severity).toBe('critical');

        const existsCheck = v.checks.find((c) => c.name === CHECK_NAMES.EXISTS);
        expect(existsCheck?.passed).toBe(true);
      }
    });

    it('size_anomaly: flags significant size drop', async () => {
      const sim = new BackupSimulator();
      sim.transition('size_anomaly');
      const report = await sim.verifyAll(makeConfigs());

      for (const provider of report.providers) {
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const sizeCheck = v.checks.find((c) => c.name === CHECK_NAMES.SIZE_TREND);
        expect(sizeCheck?.passed).toBe(false);
        expect(sizeCheck?.detail).toContain('Size dropped');

        // Backup itself should be much smaller than previous
        expect(v.item.sizeBytes).toBeLessThan(v.item.previousSizeBytes!);
      }
    });

    it('integrity_failure: flags corrupted archive', async () => {
      const sim = new BackupSimulator();
      sim.transition('integrity_failure');
      const report = await sim.verifyAll(makeConfigs());

      for (const provider of report.providers) {
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const integrityCheck = v.checks.find((c) => c.name === CHECK_NAMES.INTEGRITY);
        expect(integrityCheck?.passed).toBe(false);
        expect(integrityCheck?.severity).toBe('critical');
        expect(integrityCheck?.detail).toContain('corrupted');
      }
    });

    it('incomplete_coverage: first source healthy, second missing', async () => {
      const sim = new BackupSimulator();
      sim.transition('incomplete_coverage');
      const configs = makeConfigs();
      const report = await sim.verifyAll(configs);

      // First provider is detected and healthy
      expect(report.providers[0].detected).toBe(true);
      expect(report.providers[0].verifications[0].passed).toBe(true);

      // Second provider has no backups
      expect(report.providers[1].detected).toBe(false);
      expect(report.providers[1].items).toHaveLength(0);

      expect(report.uncoveredSources).toContain(configs[1].source);
      expect(report.uncoveredSources).not.toContain(configs[0].source);
    });

    it('rto_at_risk: backups pass verification but have large RTO estimates', async () => {
      const sim = new BackupSimulator();
      sim.transition('rto_at_risk');
      const report = await sim.verifyAll(makeConfigs());

      // All verifications pass
      for (const provider of report.providers) {
        expect(provider.verifications[0].passed).toBe(true);
      }

      // RTO estimates exist and are substantial
      expect(report.rtoEstimates.length).toBeGreaterThan(0);
      expect(report.rtoEstimates.every((r) => r.estimatedSeconds > 3600)).toBe(true);
    });

    it('rds_snapshot_error: snapshot exists but status is error', async () => {
      const sim = new BackupSimulator();
      sim.transition('rds_snapshot_error');
      const report = await sim.verifyAll(makeConfigs());

      for (const provider of report.providers) {
        expect(provider.detected).toBe(true);
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const statusCheck = v.checks.find((c) => c.name === 'snapshot_status');
        expect(statusCheck?.passed).toBe(false);
        expect(statusCheck?.severity).toBe('critical');
      }
    });

    it('glacier_restore_delay: S3 backup in Glacier with high RTO', async () => {
      const sim = new BackupSimulator();
      sim.transition('glacier_restore_delay');
      const report = await sim.verifyAll(makeConfigs());

      for (const provider of report.providers) {
        expect(provider.detected).toBe(true);
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const storageCheck = v.checks.find((c) => c.name === 'storage_class');
        expect(storageCheck?.passed).toBe(false);
        expect(storageCheck?.detail).toContain('GLACIER');
      }

      // RTO should include Glacier restore delay
      expect(report.rtoEstimates.length).toBeGreaterThan(0);
      expect(report.rtoEstimates.every((r) => r.estimatedSeconds > 10000)).toBe(true);
    });

    it('s3_versioning_disabled: backup healthy but versioning off', async () => {
      const sim = new BackupSimulator();
      sim.transition('s3_versioning_disabled');
      const report = await sim.verifyAll(makeConfigs());

      for (const provider of report.providers) {
        expect(provider.detected).toBe(true);
        const v = provider.verifications[0];
        expect(v.passed).toBe(false);

        const versioningCheck = v.checks.find((c) => c.name === 'versioning');
        expect(versioningCheck?.passed).toBe(false);
        expect(versioningCheck?.severity).toBe('warning');
      }
    });

    it('healthy: all verifications pass, RPO met, no gaps', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const report = await sim.verifyAll(makeConfigs());

      expect(report.providers.every((p) => p.detected)).toBe(true);
      for (const provider of report.providers) {
        expect(provider.verifications[0].passed).toBe(true);
        expect(provider.verifications[0].checks.every((c) => c.passed)).toBe(true);
      }
      expect(report.rpoEvaluations.every((r) => r.withinTarget)).toBe(true);
      expect(report.uncoveredSources).toHaveLength(0);
    });

    it('uses configured RPO when provided', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const configs: BackupProviderConfig[] = [
        { kind: 'file_directory', locations: ['/backups'], source: 'mydb', rpoSeconds: 3600 },
      ];
      const report = await sim.verifyAll(configs);

      expect(report.rpoEvaluations[0].targetRpoSeconds).toBe(3600);
    });

    it('uses default RPO when not configured', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const configs: BackupProviderConfig[] = [
        { kind: 'file_directory', locations: ['/backups'], source: 'mydb' },
      ];
      const report = await sim.verifyAll(configs);

      expect(report.rpoEvaluations[0].targetRpoSeconds).toBe(DEFAULT_RPO_SECONDS);
    });
  });

  // ---------------------------------------------------------------------------
  // listProviderKinds()
  // ---------------------------------------------------------------------------
  describe('listProviderKinds()', () => {
    it('returns all provider kinds including AWS', () => {
      const sim = new BackupSimulator();
      const kinds = sim.listProviderKinds();
      expect(kinds).toContain('file_directory');
      expect(kinds).toContain('pg_dump');
      expect(kinds).toContain('aws_rds');
      expect(kinds).toContain('aws_s3');
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('verify_backups returns a report', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const result = await sim.executeCommand({
        type: 'api_call',
        operation: 'verify_backups',
        parameters: { configs: makeConfigs() },
      }) as { report: unknown };
      expect(result).toHaveProperty('report');
    });

    it('list_providers returns provider kinds', async () => {
      const sim = new BackupSimulator();
      const result = await sim.executeCommand({
        type: 'api_call',
        operation: 'list_providers',
      }) as { providers: string[] };
      expect(result.providers).toContain('file_directory');
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new BackupSimulator();
      const result = await sim.executeCommand({
        type: 'api_call',
        operation: 'unknown_op',
      }) as { simulated: boolean };
      expect(result.simulated).toBe(true);
    });

    it('throws on unsupported command type', async () => {
      const sim = new BackupSimulator();
      await expect(sim.executeCommand({ type: 'sql', operation: 'test' }))
        .rejects.toThrow('Unsupported backup simulator command type: sql');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('backup_count is 0 when no backups found', async () => {
      const sim = new BackupSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'backup_count',
        expect: { operator: 'eq', value: 0 },
      });
      expect(result).toBe(true);
    });

    it('backup_count is 1 when backups exist', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'backup_count',
        expect: { operator: 'gt', value: 0 },
      });
      expect(result).toBe(true);
    });

    it('backup_age_seconds reflects stale state', async () => {
      const sim = new BackupSimulator();
      sim.transition('stale_backup');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'backup_age_seconds',
        expect: { operator: 'gt', value: 86400 }, // > 1 day
      });
      expect(result).toBe(true);
    });

    it('all_verifications_passed is true for healthy state', async () => {
      const sim = new BackupSimulator();
      sim.transition('healthy');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'all_verifications_passed',
        expect: { operator: 'eq', value: true },
      });
      expect(result).toBe(true);
    });

    it('all_verifications_passed is false for integrity_failure', async () => {
      const sim = new BackupSimulator();
      sim.transition('integrity_failure');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'all_verifications_passed',
        expect: { operator: 'eq', value: true },
      });
      expect(result).toBe(false);
    });

    it('returns true for unknown statement', async () => {
      const sim = new BackupSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'unknown_check',
        expect: { operator: 'eq', value: 'anything' },
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // listCapabilityProviders() & close()
  // ---------------------------------------------------------------------------
  describe('listCapabilityProviders()', () => {
    it('returns 1 provider with backup capabilities', () => {
      const sim = new BackupSimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('backup-simulator-read');
      expect(providers[0].capabilities).toContain('backup.inventory.list');
      expect(providers[0].capabilities).toContain('backup.verify.integrity');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new BackupSimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // transition()
  // ---------------------------------------------------------------------------
  describe('transition()', () => {
    it('transitions between all states without error', async () => {
      const sim = new BackupSimulator();
      const states = [
        'no_backups_found', 'stale_backup', 'size_anomaly',
        'integrity_failure', 'incomplete_coverage', 'rto_at_risk',
        'rds_snapshot_error', 'glacier_restore_delay', 's3_versioning_disabled',
        'healthy',
      ];

      for (const state of states) {
        sim.transition(state);
        // Should produce a valid report without throwing
        const report = await sim.verifyAll(makeConfigs());
        expect(report.verifiedAt).toBeTruthy();
        expect(report.providers.length).toBeGreaterThan(0);
      }
    });
  });
});
