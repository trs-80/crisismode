// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackupProviderConfig, BackupInventoryItem } from '../agent/backup/backend.js';
import { CHECK_NAMES } from '../agent/backup/backend.js';

// Separate mock send functions for STS and S3
const mockStsSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = mockStsSend; },
  GetCallerIdentityCommand: class { constructor(public params?: unknown) {} },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mockS3Send; },
  HeadBucketCommand: class { constructor(public params?: unknown) {} },
  HeadObjectCommand: class { constructor(public params?: unknown) {} },
  ListObjectsV2Command: class { constructor(public params?: unknown) {} },
  GetBucketVersioningCommand: class { constructor(public params?: unknown) {} },
}));

import { S3BackupProvider } from '../agent/backup/aws-s3-provider.js';

function makeConfig(overrides?: Partial<BackupProviderConfig>): BackupProviderConfig {
  return {
    kind: 'aws_s3',
    locations: ['s3://my-backup-bucket/backups/'],
    source: 'app_db',
    aws: { region: 'us-east-1', bucket: 'my-backup-bucket', prefix: 'backups/' },
    ...overrides,
  };
}

describe('S3BackupProvider', () => {
  let provider: S3BackupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BackupProvider();

    // Default: STS always succeeds
    mockStsSend.mockResolvedValue({ Account: '123456789' });
  });

  describe('detect()', () => {
    it('returns true when credentials and bucket access are valid', async () => {
      mockS3Send.mockResolvedValueOnce({}); // HeadBucket

      const result = await provider.detect(makeConfig());
      expect(result).toBe(true);
    });

    it('returns false when bucket access fails', async () => {
      mockS3Send.mockRejectedValueOnce(new Error('NoSuchBucket'));

      const result = await provider.detect(makeConfig());
      expect(result).toBe(false);
    });

    it('returns false when no bucket is configured', async () => {
      const result = await provider.detect(makeConfig({
        locations: [],
        aws: { region: 'us-east-1' },
      }));
      expect(result).toBe(false);
    });
  });

  describe('inventory()', () => {
    it('maps S3 objects to BackupInventoryItems', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadBucket (detect)
        .mockResolvedValueOnce({ // ListObjectsV2 (inventory)
          Contents: [
            { Key: 'backups/app_db_2026-03-28.sql.gz', LastModified: new Date(Date.now() - 4 * 3600 * 1000), Size: 2.5e9, StorageClass: 'STANDARD' },
            { Key: 'backups/app_db_2026-03-27.sql.gz', LastModified: new Date(Date.now() - 28 * 3600 * 1000), Size: 2.4e9, StorageClass: 'STANDARD' },
            { Key: 'backups/readme.txt', LastModified: new Date(), Size: 100 }, // Not a backup file
          ],
          IsTruncated: false,
        });

      await provider.detect(makeConfig());
      const items = await provider.inventory(makeConfig());

      expect(items).toHaveLength(2); // readme.txt filtered out
      const first = items[0]!;
      expect(first.providerKind).toBe('aws_s3');
      expect(first.location).toContain('s3://my-backup-bucket/');
      expect(first.storageClass).toBe('STANDARD');
      // Newest first, previousSizeBytes filled
      expect(first.sizeBytes).toBe(2.5e9);
      expect(first.previousSizeBytes).toBe(2.4e9);
      expect(items[1]!.previousSizeBytes).toBeNull();
    });

    it('respects filePattern filter', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadBucket
        .mockResolvedValueOnce({
          Contents: [
            { Key: 'backups/app_db_2026-03-28.sql.gz', LastModified: new Date(), Size: 2.5e9, StorageClass: 'STANDARD' },
            { Key: 'backups/other_db_2026-03-28.sql.gz', LastModified: new Date(), Size: 1e9, StorageClass: 'STANDARD' },
          ],
          IsTruncated: false,
        });

      await provider.detect(makeConfig());
      const items = await provider.inventory(makeConfig({
        aws: { region: 'us-east-1', bucket: 'my-backup-bucket', prefix: 'backups/', filePattern: 'app_db_*.sql.gz' },
      }));

      expect(items).toHaveLength(1);
      expect(items[0]!.label).toContain('app_db');
    });
  });

  describe('verify()', () => {
    const baseItem: BackupInventoryItem = {
      providerKind: 'aws_s3',
      label: 'S3 backup: backups/app_db.sql.gz',
      location: 's3://my-backup-bucket/backups/app_db.sql.gz',
      source: 'app_db',
      createdAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      sizeBytes: 2.5e9,
      previousSizeBytes: 2.4e9,
      storageClass: 'STANDARD',
    };

    it('passes all checks for a healthy STANDARD object', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject (exists check)
        .mockResolvedValueOnce({ Status: 'Enabled' }); // GetBucketVersioning

      const result = await provider.verify(baseItem, makeConfig());

      expect(result.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.EXISTS)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.RECENCY)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.SIZE_TREND)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.STORAGE_CLASS)?.passed).toBe(true);
      expect(result.checks.find((c) => c.name === CHECK_NAMES.VERSIONING)?.passed).toBe(true);
    });

    it('warns when storage class is GLACIER', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject
        .mockResolvedValueOnce({ Status: 'Enabled' }); // Versioning

      const glacierItem = { ...baseItem, storageClass: 'GLACIER' };
      const result = await provider.verify(glacierItem, makeConfig());

      expect(result.passed).toBe(false);
      const storageCheck = result.checks.find((c) => c.name === CHECK_NAMES.STORAGE_CLASS);
      expect(storageCheck?.passed).toBe(false);
      expect(storageCheck?.severity).toBe('warning');
      expect(storageCheck?.detail).toContain('3-12 hours');
    });

    it('warns when storage class is DEEP_ARCHIVE', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject
        .mockResolvedValueOnce({ Status: 'Enabled' }); // Versioning

      const archiveItem = { ...baseItem, storageClass: 'DEEP_ARCHIVE' };
      const result = await provider.verify(archiveItem, makeConfig());

      const storageCheck = result.checks.find((c) => c.name === CHECK_NAMES.STORAGE_CLASS);
      expect(storageCheck?.passed).toBe(false);
      expect(storageCheck?.detail).toContain('12+');
    });

    it('warns when bucket versioning is disabled', async () => {
      mockS3Send
        .mockResolvedValueOnce({}) // HeadObject
        .mockResolvedValueOnce({ Status: 'Suspended' }); // Versioning not enabled

      const result = await provider.verify(baseItem, makeConfig());

      expect(result.passed).toBe(false);
      const versioningCheck = result.checks.find((c) => c.name === CHECK_NAMES.VERSIONING);
      expect(versioningCheck?.passed).toBe(false);
      expect(versioningCheck?.severity).toBe('warning');
      expect(versioningCheck?.detail).toContain('not enabled');
    });

    it('fails when object is not found', async () => {
      mockS3Send
        .mockRejectedValueOnce(new Error('NotFound')); // HeadObject fails

      const result = await provider.verify(baseItem, makeConfig());

      const existsCheck = result.checks.find((c) => c.name === CHECK_NAMES.EXISTS);
      expect(existsCheck?.passed).toBe(false);
      expect(existsCheck?.severity).toBe('critical');
    });
  });

  describe('estimateRecoveryTime()', () => {
    it('estimates based on size for STANDARD storage', async () => {
      const item: BackupInventoryItem = {
        providerKind: 'aws_s3',
        label: 'test',
        location: 's3://bucket/key',
        source: 'app_db',
        createdAt: new Date().toISOString(),
        sizeBytes: 50 * 1024 * 1024 * 1024, // 50 GB
        previousSizeBytes: null,
        storageClass: 'STANDARD',
      };

      const rto = await provider.estimateRecoveryTime(item);

      // 50GB at 50MB/s ≈ 1024s
      expect(rto.estimatedSeconds).toBeGreaterThan(1000);
      expect(rto.estimatedSeconds).toBeLessThan(1200);
      expect(rto.basis).toContain('50MB/s');
      expect(rto.basis).not.toContain('Glacier');
    });

    it('adds Glacier restore delay', async () => {
      const item: BackupInventoryItem = {
        providerKind: 'aws_s3',
        label: 'test',
        location: 's3://bucket/key',
        source: 'app_db',
        createdAt: new Date().toISOString(),
        sizeBytes: 1 * 1024 * 1024 * 1024, // 1 GB
        previousSizeBytes: null,
        storageClass: 'GLACIER',
      };

      const rto = await provider.estimateRecoveryTime(item);

      expect(rto.estimatedSeconds).toBeGreaterThan(5 * 3600);
      expect(rto.basis).toContain('Glacier');
    });

    it('adds Deep Archive restore delay', async () => {
      const item: BackupInventoryItem = {
        providerKind: 'aws_s3',
        label: 'test',
        location: 's3://bucket/key',
        source: 'app_db',
        createdAt: new Date().toISOString(),
        sizeBytes: 1 * 1024 * 1024 * 1024,
        previousSizeBytes: null,
        storageClass: 'DEEP_ARCHIVE',
      };

      const rto = await provider.estimateRecoveryTime(item);

      expect(rto.estimatedSeconds).toBeGreaterThan(12 * 3600);
      expect(rto.basis).toContain('Deep Archive');
    });
  });
});
