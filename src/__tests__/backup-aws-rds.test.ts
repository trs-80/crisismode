// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackupProviderConfig, BackupInventoryItem } from '../agent/backup/backend.js';
import { CHECK_NAMES } from '../agent/backup/backend.js';

// Separate mock send functions for STS and RDS
const mockStsSend = vi.fn();
const mockRdsSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = mockStsSend; },
  GetCallerIdentityCommand: class { constructor(public params?: unknown) {} },
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: class { send = mockRdsSend; },
  DescribeDBInstancesCommand: class { constructor(public params?: unknown) {} },
  DescribeDBSnapshotsCommand: class { constructor(public params?: unknown) {} },
  DescribeDBClusterSnapshotsCommand: class { constructor(public params?: unknown) {} },
}));

import { RdsSnapshotProvider } from '../agent/backup/aws-rds-provider.js';

function makeConfig(overrides?: Partial<BackupProviderConfig>): BackupProviderConfig {
  return {
    kind: 'aws_rds',
    locations: [],
    source: 'my-db-instance',
    aws: { region: 'us-east-1', dbInstanceIdentifiers: ['my-db-instance'] },
    ...overrides,
  };
}

describe('RdsSnapshotProvider', () => {
  let provider: RdsSnapshotProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new RdsSnapshotProvider();

    // Default: STS always succeeds
    mockStsSend.mockResolvedValue({ Account: '123456789' });
  });

  describe('detect()', () => {
    it('returns true when credentials and RDS access are valid', async () => {
      mockRdsSend.mockResolvedValueOnce({ DBInstances: [{ DBInstanceIdentifier: 'test' }] });

      const result = await provider.detect(makeConfig());
      expect(result).toBe(true);
    });

    it('returns false when STS credentials fail', async () => {
      mockStsSend.mockRejectedValue(new Error('InvalidClientTokenId'));

      const result = await provider.detect(makeConfig());
      expect(result).toBe(false);
    });

    it('returns false when RDS access is denied', async () => {
      mockRdsSend.mockRejectedValueOnce(new Error('AccessDenied'));

      const result = await provider.detect(makeConfig());
      expect(result).toBe(false);
    });
  });

  describe('inventory()', () => {
    it('maps RDS snapshots to BackupInventoryItems', async () => {
      // detect: DescribeDBInstances
      mockRdsSend.mockResolvedValueOnce({ DBInstances: [] });

      await provider.detect(makeConfig());

      // inventory: DescribeDBSnapshots then DescribeDBClusterSnapshots
      mockRdsSend
        .mockResolvedValueOnce({
          DBSnapshots: [
            {
              DBSnapshotIdentifier: 'snap-1',
              DBInstanceIdentifier: 'my-db-instance',
              DBSnapshotArn: 'arn:aws:rds:us-east-1:123456789:snapshot:snap-1',
              Status: 'available',
              AllocatedStorage: 100,
              SnapshotCreateTime: new Date(Date.now() - 4 * 3600 * 1000),
            },
            {
              DBSnapshotIdentifier: 'snap-2',
              DBInstanceIdentifier: 'my-db-instance',
              DBSnapshotArn: 'arn:aws:rds:us-east-1:123456789:snapshot:snap-2',
              Status: 'available',
              AllocatedStorage: 95,
              SnapshotCreateTime: new Date(Date.now() - 28 * 3600 * 1000),
            },
          ],
        })
        .mockResolvedValueOnce({ DBClusterSnapshots: [] });

      const items = await provider.inventory(makeConfig());

      expect(items).toHaveLength(2);
      expect(items[0].providerKind).toBe('aws_rds');
      expect(items[0].source).toBe('my-db-instance');
      expect(items[0].snapshotStatus).toBe('available');
      expect(items[0].sizeBytes).toBe(100 * 1024 * 1024 * 1024);
      expect(items[0].region).toBe('us-east-1');
      // Newest first
      expect(items[0].label).toContain('snap-1');
      expect(items[1].label).toContain('snap-2');
      // Previous size bytes filled from second snapshot
      expect(items[0].previousSizeBytes).toBe(95 * 1024 * 1024 * 1024);
      expect(items[1].previousSizeBytes).toBeNull();
    });
  });

  describe('verify()', () => {
    const baseItem: BackupInventoryItem = {
      providerKind: 'aws_rds',
      label: 'RDS snapshot: snap-1 of my-db-instance',
      location: 'arn:aws:rds:us-east-1:123456789:snapshot:snap-1',
      source: 'my-db-instance',
      createdAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      sizeBytes: 100 * 1024 * 1024 * 1024,
      previousSizeBytes: 95 * 1024 * 1024 * 1024,
      region: 'us-east-1',
      account: '123456789',
      snapshotStatus: 'available',
    };

    it('passes all checks for a healthy available snapshot', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceIdentifier: 'my-db-instance', BackupRetentionPeriod: 14 }],
      });

      const result = await provider.verify(baseItem, makeConfig());

      expect(result.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.EXISTS)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.SNAPSHOT_STATUS)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.RECENCY)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.SIZE_TREND)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.RETENTION_POLICY)?.passed).toBe(true);
    });

    it('fails snapshot_status check when status is error', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ BackupRetentionPeriod: 7 }],
      });

      const errorItem = { ...baseItem, snapshotStatus: 'error' };
      const result = await provider.verify(errorItem, makeConfig());

      expect(result.passed).toBe(false);
      const statusCheck = result.checks.find((c) => c.name === CHECK_NAMES.SNAPSHOT_STATUS);
      expect(statusCheck?.passed).toBe(false);
      expect(statusCheck?.severity).toBe('critical');
    });

    it('warns when snapshot is in creating state', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ BackupRetentionPeriod: 7 }],
      });

      const creatingItem = { ...baseItem, snapshotStatus: 'creating' };
      const result = await provider.verify(creatingItem, makeConfig());

      const statusCheck = result.checks.find((c) => c.name === CHECK_NAMES.SNAPSHOT_STATUS);
      expect(statusCheck?.passed).toBe(false);
      expect(statusCheck?.severity).toBe('warning');
    });

    it('fails retention check when backups are disabled', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceIdentifier: 'my-db-instance', BackupRetentionPeriod: 0 }],
      });

      const result = await provider.verify(baseItem, makeConfig());

      const retentionCheck = result.checks.find((c) => c.name === CHECK_NAMES.RETENTION_POLICY);
      expect(retentionCheck?.passed).toBe(false);
      expect(retentionCheck?.severity).toBe('critical');
      expect(retentionCheck?.detail).toContain('disabled');
    });

    it('warns when retention is less than 7 days', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ DBInstanceIdentifier: 'my-db-instance', BackupRetentionPeriod: 3 }],
      });

      const result = await provider.verify(baseItem, makeConfig());

      const retentionCheck = result.checks.find((c) => c.name === CHECK_NAMES.RETENTION_POLICY);
      expect(retentionCheck?.passed).toBe(false);
      expect(retentionCheck?.severity).toBe('warning');
    });

    it('fails recency when snapshot exceeds RPO', async () => {
      mockRdsSend.mockResolvedValueOnce({
        DBInstances: [{ BackupRetentionPeriod: 7 }],
      });

      const staleItem = {
        ...baseItem,
        createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      };
      const result = await provider.verify(staleItem, makeConfig({ rpoSeconds: 86400 }));

      const recencyCheck = result.checks.find((c) => c.name === CHECK_NAMES.RECENCY);
      expect(recencyCheck?.passed).toBe(false);
      expect(recencyCheck?.severity).toBe('critical');
    });
  });

  describe('estimateRecoveryTime()', () => {
    it('includes provisioning overhead and size-based restore time', async () => {
      const item: BackupInventoryItem = {
        providerKind: 'aws_rds',
        label: 'test',
        location: 'arn:test',
        source: 'my-db',
        createdAt: new Date().toISOString(),
        sizeBytes: 100 * 1024 * 1024 * 1024, // 100 GB
        previousSizeBytes: null,
      };

      const rto = await provider.estimateRecoveryTime(item);

      // 15 min provisioning (900s) + 100GB at 10MB/s ≈ 10240s
      expect(rto.estimatedSeconds).toBeGreaterThan(900);
      expect(rto.estimatedSeconds).toBeGreaterThan(10000);
      expect(rto.basis).toContain('15min provisioning');
      expect(rto.basis).toContain('10MB/s');
      expect(rto.providerKind).toBe('aws_rds');
    });

    it('returns only provisioning time for zero-size snapshots', async () => {
      const item: BackupInventoryItem = {
        providerKind: 'aws_rds',
        label: 'test',
        location: 'arn:test',
        source: 'my-db',
        createdAt: new Date().toISOString(),
        sizeBytes: 0,
        previousSizeBytes: null,
      };

      const rto = await provider.estimateRecoveryTime(item);
      expect(rto.estimatedSeconds).toBe(900); // Just provisioning
    });
  });
});
