// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AWS S3 Backup Provider — verifies backups stored in S3 buckets.
 *
 * Implements the BackupProvider strategy for S3 objects. Checks recency,
 * size trends, storage class implications (Glacier adds hours to RTO),
 * and bucket versioning. Requires @aws-sdk/client-s3 (optional dependency).
 */

import type * as S3Module from '@aws-sdk/client-s3';
import type {
  BackupProvider,
  BackupProviderConfig,
  BackupInventoryItem,
  BackupVerification,
  BackupCheck,
  RtoEstimate,
} from './backend.js';
import { DEFAULT_RPO_SECONDS, CHECK_NAMES } from './backend.js';
import { tryImportAws, resolveAwsCredentials } from './aws-common.js';
import { formatBytes, formatDuration } from '../../framework/format-helpers.js';

/** S3 download throughput estimate: ~50 MB/s. */
const S3_DOWNLOAD_THROUGHPUT_BPS = 50 * 1024 * 1024;

/** Glacier expedited restore adds ~5 hours. */
const GLACIER_RESTORE_SECONDS = 5 * 3600;

/** Deep Archive restore adds ~12 hours. */
const DEEP_ARCHIVE_RESTORE_SECONDS = 12 * 3600;

/** Maximum items to inventory per bucket/prefix. */
const MAX_ITEMS_PER_LOCATION = 10;

/** Size drop ratio that triggers a warning. */
const SIZE_DROP_THRESHOLD = 0.5;

/** Known backup file extensions — same set as live-client.ts. */
const BACKUP_EXTENSIONS = new Set([
  '.sql', '.sql.gz', '.sql.bz2', '.sql.xz', '.sql.zst',
  '.dump', '.dump.gz',
  '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz', '.tar.zst',
  '.gz', '.bz2', '.xz', '.zst',
  '.bak', '.backup',
]);

export class S3BackupProvider implements BackupProvider {
  kind = 'aws_s3' as const;

  private s3Module: typeof S3Module | null = null;

  async detect(config: BackupProviderConfig): Promise<boolean> {
    const s3 = await tryImportAws<typeof S3Module>('@aws-sdk/client-s3');
    if (!s3) return false;

    const creds = await resolveAwsCredentials({
      region: config.aws?.region,
      profile: config.aws?.profile,
    });
    if (!creds.valid) return false;

    const bucket = this.resolveBucket(config);
    if (!bucket) return false;

    try {
      const client = new s3.S3Client({
        region: creds.region,
        ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
      });
      await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
      this.s3Module = s3;
      return true;
    } catch {
      return false;
    }
  }

  async inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]> {
    const s3 = this.s3Module ?? await tryImportAws<typeof S3Module>('@aws-sdk/client-s3');
    if (!s3) return [];

    const creds = await resolveAwsCredentials({
      region: config.aws?.region,
      profile: config.aws?.profile,
    });
    if (!creds.valid) return [];

    const bucket = this.resolveBucket(config);
    if (!bucket) return [];

    const prefix = config.aws?.prefix ?? '';

    const client = new s3.S3Client({
      region: creds.region,
      ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
    });

    const items: BackupInventoryItem[] = [];

    try {
      let continuationToken: string | undefined;
      let pages = 0;
      const maxPages = 5; // Bound pagination

      do {
        const resp = await client.send(new s3.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }));

        for (const obj of resp.Contents ?? []) {
          if (!obj.Key || !obj.LastModified || !obj.Size) continue;
          if (!this.isBackupFile(obj.Key, config.aws?.filePattern)) continue;

          items.push({
            providerKind: 'aws_s3',
            label: `S3 backup: ${obj.Key}`,
            location: `s3://${bucket}/${obj.Key}`,
            source: config.source,
            createdAt: obj.LastModified.toISOString(),
            sizeBytes: obj.Size,
            previousSizeBytes: null, // filled after sorting
            region: creds.region,
            account: creds.accountId,
            storageClass: obj.StorageClass ?? 'STANDARD',
          });
        }

        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        pages++;
      } while (continuationToken && pages < maxPages);
    } catch {
      return [];
    }

    // Sort newest-first, cap, and fill previousSizeBytes
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const capped = items.slice(0, MAX_ITEMS_PER_LOCATION);
    for (let i = 0; i < capped.length; i++) {
      if (i + 1 < capped.length) {
        capped[i]!.previousSizeBytes = capped[i + 1]!.sizeBytes;
      }
    }

    return capped;
  }

  async verify(
    item: BackupInventoryItem,
    config: BackupProviderConfig,
  ): Promise<BackupVerification> {
    const checks: BackupCheck[] = [];

    // Check 1: Existence
    const exists = await this.checkObjectExists(item, config);
    checks.push(exists);

    // Check 2: Recency (RPO)
    const ageSeconds = (Date.now() - new Date(item.createdAt).getTime()) / 1000;
    const targetRpo = config.rpoSeconds ?? DEFAULT_RPO_SECONDS;
    const withinRpo = ageSeconds <= targetRpo;
    checks.push({
      name: CHECK_NAMES.RECENCY,
      passed: withinRpo,
      detail: withinRpo
        ? `Object is ${formatDuration(ageSeconds)} old (within ${formatDuration(targetRpo)} RPO target)`
        : `Object is ${formatDuration(ageSeconds)} old — exceeds ${formatDuration(targetRpo)} RPO target`,
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
          ? `Object is ${formatBytes(item.sizeBytes)} — previous was ${formatBytes(item.previousSizeBytes)}. Size dropped ${Math.round((1 - ratio) * 100)}%`
          : 'Size is consistent with previous backup',
        severity: dropped ? 'critical' : 'info',
      });
    } else {
      checks.push({
        name: CHECK_NAMES.SIZE_TREND,
        passed: true,
        detail: 'No previous backup for size comparison',
        severity: 'info',
      });
    }

    // Check 4: Storage class
    const storageClass = item.storageClass ?? 'STANDARD';
    const isArchived = storageClass === 'GLACIER' || storageClass === 'DEEP_ARCHIVE';
    checks.push({
      name: CHECK_NAMES.STORAGE_CLASS,
      passed: !isArchived,
      detail: isArchived
        ? `Storage class: ${storageClass} — restore requires ${storageClass === 'DEEP_ARCHIVE' ? '12+' : '3-12'} hours before data is accessible`
        : `Storage class: ${storageClass}`,
      severity: isArchived ? 'warning' : 'info',
    });

    // Check 5: Bucket versioning
    const versioningCheck = await this.checkVersioning(config);
    if (versioningCheck) {
      checks.push(versioningCheck);
    }

    const passed = checks.every((c) => c.passed);
    return { item, passed, checks };
  }

  async estimateRecoveryTime(item: BackupInventoryItem): Promise<RtoEstimate> {
    const storageClass = item.storageClass ?? 'STANDARD';
    const downloadSeconds = Math.ceil(item.sizeBytes / S3_DOWNLOAD_THROUGHPUT_BPS);

    let glacierDelay = 0;
    let basisSuffix = '';
    if (storageClass === 'DEEP_ARCHIVE') {
      glacierDelay = DEEP_ARCHIVE_RESTORE_SECONDS;
      basisSuffix = ` + ~12h Deep Archive restore wait`;
    } else if (storageClass === 'GLACIER') {
      glacierDelay = GLACIER_RESTORE_SECONDS;
      basisSuffix = ` + ~5h Glacier restore wait`;
    }

    return {
      source: item.source,
      providerKind: 'aws_s3',
      estimatedSeconds: downloadSeconds + glacierDelay,
      basis: `S3 download at ~50MB/s for ${formatBytes(item.sizeBytes)}${basisSuffix}`,
    };
  }

  // ── Private helpers ──

  private resolveBucket(config: BackupProviderConfig): string | null {
    // From aws config
    if (config.aws?.bucket) return config.aws.bucket;

    // From locations — parse s3://bucket/prefix format
    for (const loc of config.locations) {
      const match = loc.match(/^s3:\/\/([^/]+)/);
      if (match) return match[1]!;
    }

    return null;
  }

  private isBackupFile(key: string, filePattern?: string): boolean {
    if (filePattern) {
      // Simple glob: convert * to regex
      const regex = new RegExp(
        '^' + filePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      );
      return regex.test(key.split('/').pop() ?? '');
    }

    const lower = key.toLowerCase();
    for (const ext of BACKUP_EXTENSIONS) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  private async checkObjectExists(
    item: BackupInventoryItem,
    config: BackupProviderConfig,
  ): Promise<BackupCheck> {
    const s3 = this.s3Module ?? await tryImportAws<typeof S3Module>('@aws-sdk/client-s3');
    if (!s3) {
      return { name: CHECK_NAMES.EXISTS, passed: true, detail: `Object listed in inventory: ${item.location}`, severity: 'info' };
    }

    const bucket = this.resolveBucket(config);
    if (!bucket) {
      return { name: CHECK_NAMES.EXISTS, passed: true, detail: `Object listed in inventory: ${item.location}`, severity: 'info' };
    }

    // Extract key from s3://bucket/key
    const key = item.location.replace(`s3://${bucket}/`, '');

    try {
      const creds = await resolveAwsCredentials({
        region: config.aws?.region,
        profile: config.aws?.profile,
      });
      const client = new s3.S3Client({
        region: creds.region,
        ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
      });
      await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { name: CHECK_NAMES.EXISTS, passed: true, detail: `Object verified: ${item.location}`, severity: 'info' };
    } catch {
      return { name: CHECK_NAMES.EXISTS, passed: false, detail: `Object not found or inaccessible: ${item.location}`, severity: 'critical' };
    }
  }

  private async checkVersioning(config: BackupProviderConfig): Promise<BackupCheck | null> {
    const s3 = this.s3Module ?? await tryImportAws<typeof S3Module>('@aws-sdk/client-s3');
    if (!s3) return null;

    const bucket = this.resolveBucket(config);
    if (!bucket) return null;

    try {
      const creds = await resolveAwsCredentials({
        region: config.aws?.region,
        profile: config.aws?.profile,
      });
      const client = new s3.S3Client({
        region: creds.region,
        ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
      });
      const resp = await client.send(new s3.GetBucketVersioningCommand({ Bucket: bucket }));
      const enabled = resp.Status === 'Enabled';
      return {
        name: CHECK_NAMES.VERSIONING,
        passed: enabled,
        detail: enabled
          ? 'Bucket versioning is enabled — accidental deletions are recoverable'
          : 'Bucket versioning is not enabled — accidental deletions are permanent',
        severity: enabled ? 'info' : 'warning',
      };
    } catch {
      return null;
    }
  }
}
