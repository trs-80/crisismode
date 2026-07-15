// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import type {
  BackupProvider,
  BackupProviderConfig,
  BackupInventoryItem,
  BackupVerification,
  RtoEstimate,
} from '../agent/backup/backend.js';
import { BackupCompositeClient } from '../agent/backup/composite-client.js';

/** Creates a mock BackupProvider that returns controlled data. */
function mockProvider(
  kind: string,
  options?: {
    detected?: boolean;
    items?: BackupInventoryItem[];
    verification?: Partial<BackupVerification>;
    rto?: RtoEstimate;
  },
): BackupProvider {
  const detected = options?.detected ?? true;
  const items = options?.items ?? [];

  return {
    kind,
    detect: vi.fn().mockResolvedValue(detected),
    inventory: vi.fn().mockResolvedValue(items),
    verify: vi.fn().mockImplementation((item: BackupInventoryItem) => ({
      item,
      passed: true,
      checks: [{ name: 'exists', passed: true, detail: 'OK', severity: 'info' }],
      ...options?.verification,
    })),
    estimateRecoveryTime: options?.rto
      ? vi.fn().mockResolvedValue(options.rto)
      : vi.fn().mockResolvedValue({
          source: items[0]?.source ?? 'unknown',
          providerKind: kind,
          estimatedSeconds: 300,
          basis: 'test estimate',
        }),
  };
}

function makeItem(source: string, kind: string, ageHours: number): BackupInventoryItem {
  return {
    providerKind: kind,
    label: `${kind} backup of ${source}`,
    location: `/backups/${source}.tar.gz`,
    source,
    createdAt: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
    sizeBytes: 2.5e9,
    previousSizeBytes: 2.4e9,
  };
}

describe('BackupCompositeClient', () => {
  describe('verifyAll()', () => {
    it('routes configs to the correct provider by kind', async () => {
      const fsProvider = mockProvider('file_directory', {
        detected: true,
        items: [makeItem('app_db', 'file_directory', 6)],
      });
      const rdsProvider = mockProvider('aws_rds', {
        detected: true,
        items: [makeItem('rds-instance', 'aws_rds', 4)],
      });

      const client = new BackupCompositeClient([fsProvider, rdsProvider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'file_directory', locations: ['/var/backups'], source: 'app_db' },
        { kind: 'aws_rds', locations: [], source: 'rds-instance', aws: { region: 'us-east-1' } },
      ];

      const report = await client.verifyAll(configs);

      expect(report.providers).toHaveLength(2);
      const provider0 = report.providers[0]!;
      const provider1 = report.providers[1]!;
      expect(provider0.kind).toBe('file_directory');
      expect(provider0.detected).toBe(true);
      expect(provider1.kind).toBe('aws_rds');
      expect(provider1.detected).toBe(true);
      expect(fsProvider.detect).toHaveBeenCalled();
      expect(rdsProvider.detect).toHaveBeenCalled();
    });

    it('reports uncovered when no provider matches config kind', async () => {
      const fsProvider = mockProvider('file_directory', {
        detected: true,
        items: [makeItem('app_db', 'file_directory', 6)],
      });

      const client = new BackupCompositeClient([fsProvider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'file_directory', locations: ['/var/backups'], source: 'app_db' },
        { kind: 'aws_rds', locations: [], source: 'rds-instance' }, // No RDS provider registered
      ];

      const report = await client.verifyAll(configs);

      expect(report.providers[1]!.detected).toBe(false);
      expect(report.uncoveredSources).toContain('rds-instance');
    });

    it('reports uncovered when provider detect returns false', async () => {
      const rdsProvider = mockProvider('aws_rds', { detected: false });

      const client = new BackupCompositeClient([rdsProvider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'aws_rds', locations: [], source: 'rds-instance' },
      ];

      const report = await client.verifyAll(configs);

      expect(report.providers[0]!.detected).toBe(false);
      expect(report.uncoveredSources).toContain('rds-instance');
      const rpo0 = report.rpoEvaluations[0]!;
      expect(rpo0.withinTarget).toBe(false);
      expect(rpo0.actualAgeSeconds).toBe(Infinity);
    });

    it('computes RPO evaluations from newest backup', async () => {
      const provider = mockProvider('aws_s3', {
        detected: true,
        items: [makeItem('app_db', 'aws_s3', 4)], // 4 hours old
      });

      const client = new BackupCompositeClient([provider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'aws_s3', locations: ['s3://bucket'], source: 'app_db', rpoSeconds: 86400 },
      ];

      const report = await client.verifyAll(configs);

      expect(report.rpoEvaluations).toHaveLength(1);
      const rpo0 = report.rpoEvaluations[0]!;
      expect(rpo0.withinTarget).toBe(true);
      expect(rpo0.actualAgeSeconds).toBeGreaterThan(3 * 3600);
      expect(rpo0.actualAgeSeconds).toBeLessThan(5 * 3600);
    });

    it('uses provider-specific RTO estimation', async () => {
      const customRto: RtoEstimate = {
        source: 'rds-instance',
        providerKind: 'aws_rds',
        estimatedSeconds: 11140,
        basis: 'RDS restore with provisioning',
      };
      const provider = mockProvider('aws_rds', {
        detected: true,
        items: [makeItem('rds-instance', 'aws_rds', 4)],
        rto: customRto,
      });

      const client = new BackupCompositeClient([provider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'aws_rds', locations: [], source: 'rds-instance' },
      ];

      const report = await client.verifyAll(configs);

      expect(report.rtoEstimates).toHaveLength(1);
      const rto0 = report.rtoEstimates[0]!;
      expect(rto0.estimatedSeconds).toBe(11140);
      expect(rto0.basis).toContain('RDS');
    });

    it('runs multiple providers in parallel', async () => {
      const fsProvider = mockProvider('file_directory', {
        detected: true,
        items: [makeItem('app_db', 'file_directory', 6)],
      });
      const rdsProvider = mockProvider('aws_rds', {
        detected: true,
        items: [makeItem('rds-db', 'aws_rds', 4)],
      });
      const s3Provider = mockProvider('aws_s3', {
        detected: true,
        items: [makeItem('s3-backup', 'aws_s3', 8)],
      });

      const client = new BackupCompositeClient([fsProvider, rdsProvider, s3Provider]);

      const configs: BackupProviderConfig[] = [
        { kind: 'file_directory', locations: ['/var/backups'], source: 'app_db' },
        { kind: 'aws_rds', locations: [], source: 'rds-db' },
        { kind: 'aws_s3', locations: ['s3://bucket'], source: 's3-backup' },
      ];

      const report = await client.verifyAll(configs);

      expect(report.providers).toHaveLength(3);
      expect(report.providers.every((p) => p.detected)).toBe(true);
      expect(report.rpoEvaluations).toHaveLength(3);
      expect(report.rtoEstimates).toHaveLength(3);
    });
  });

  describe('listProviderKinds()', () => {
    it('returns kinds from all registered providers', () => {
      const client = new BackupCompositeClient([
        mockProvider('file_directory'),
        mockProvider('aws_rds'),
        mockProvider('aws_s3'),
      ]);

      const kinds = client.listProviderKinds();
      expect(kinds).toContain('file_directory');
      expect(kinds).toContain('aws_rds');
      expect(kinds).toContain('aws_s3');
    });
  });

  describe('executeCommand()', () => {
    it('handles list_providers command', async () => {
      const client = new BackupCompositeClient([
        mockProvider('file_directory'),
        mockProvider('aws_rds'),
      ]);

      const result = await client.executeCommand({
        type: 'api_call',
        operation: 'list_providers',
        parameters: {},
      }) as { providers: string[] };

      expect(result.providers).toContain('file_directory');
      expect(result.providers).toContain('aws_rds');
    });
  });
});
