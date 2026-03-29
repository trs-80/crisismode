// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AWS RDS Snapshot Provider — verifies RDS and Aurora snapshots.
 *
 * Implements the BackupProvider strategy for AWS RDS automated and
 * manual snapshots. Requires @aws-sdk/client-rds (optional dependency).
 */

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

/** RDS restore is slower than filesystem: ~10 MB/s effective + provisioning overhead. */
const RDS_RESTORE_THROUGHPUT_BPS = 10 * 1024 * 1024;

/** Base provisioning time for an RDS restore (instance creation, parameter groups). */
const RDS_PROVISIONING_SECONDS = 900; // 15 minutes

/** Maximum snapshots to inventory per DB instance. */
const MAX_SNAPSHOTS_PER_INSTANCE = 10;

/** Size drop ratio that triggers a warning. */
const SIZE_DROP_THRESHOLD = 0.5;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type RDSModule = typeof import('@aws-sdk/client-rds');

interface SnapshotLike {
  SnapshotCreateTime?: Date;
  AllocatedStorage?: number;
  DBSnapshotIdentifier?: string;
  DBSnapshotArn?: string;
  DBInstanceIdentifier?: string;
  DBClusterSnapshotIdentifier?: string;
  DBClusterSnapshotArn?: string;
  DBClusterIdentifier?: string;
  Status?: string;
}

export class RdsSnapshotProvider implements BackupProvider {
  kind = 'aws_rds' as const;

  private rdsModule: RDSModule | null = null;

  async detect(config: BackupProviderConfig): Promise<boolean> {
    const rds = await tryImportAws<RDSModule>('@aws-sdk/client-rds');
    if (!rds) return false;

    const creds = await resolveAwsCredentials({
      region: config.aws?.region,
      profile: config.aws?.profile,
    });
    if (!creds.valid) return false;

    // Verify RDS API access with a minimal call
    try {
      const client = new rds.RDSClient({
        region: creds.region,
        ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
      });
      await client.send(new rds.DescribeDBInstancesCommand({ MaxRecords: 20 }));
      this.rdsModule = rds;
      return true;
    } catch {
      return false;
    }
  }

  async inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]> {
    const rds = this.rdsModule ?? await tryImportAws<RDSModule>('@aws-sdk/client-rds');
    if (!rds) return [];

    const creds = await resolveAwsCredentials({
      region: config.aws?.region,
      profile: config.aws?.profile,
    });
    if (!creds.valid) return [];

    const client = new rds.RDSClient({
      region: creds.region,
      ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
    });

    const items: BackupInventoryItem[] = [];

    // Inventory DB instance snapshots
    const instanceItems = await this.inventoryInstanceSnapshots(
      client, rds, config, creds,
    );
    items.push(...instanceItems);

    // Inventory Aurora cluster snapshots
    const clusterItems = await this.inventoryClusterSnapshots(
      client, rds, config, creds,
    );
    items.push(...clusterItems);

    return items;
  }

  async verify(
    item: BackupInventoryItem,
    config: BackupProviderConfig,
  ): Promise<BackupVerification> {
    const checks: BackupCheck[] = [];

    // Check 1: Existence (came from inventory)
    checks.push({
      name: CHECK_NAMES.EXISTS,
      passed: true,
      detail: `Snapshot found: ${item.location}`,
      severity: 'info',
    });

    // Check 2: Snapshot status
    const status = item.snapshotStatus ?? 'unknown';
    const statusOk = status === 'available';
    checks.push({
      name: CHECK_NAMES.SNAPSHOT_STATUS,
      passed: statusOk,
      detail: statusOk
        ? 'Snapshot status: available'
        : `Snapshot status: ${status} — snapshot may not be usable for restore`,
      severity: status === 'creating' ? 'warning' : statusOk ? 'info' : 'critical',
    });

    // Check 3: Recency (RPO)
    const ageSeconds = (Date.now() - new Date(item.createdAt).getTime()) / 1000;
    const targetRpo = config.rpoSeconds ?? DEFAULT_RPO_SECONDS;
    const withinRpo = ageSeconds <= targetRpo;
    checks.push({
      name: CHECK_NAMES.RECENCY,
      passed: withinRpo,
      detail: withinRpo
        ? `Snapshot is ${formatDuration(ageSeconds)} old (within ${formatDuration(targetRpo)} RPO target)`
        : `Snapshot is ${formatDuration(ageSeconds)} old — exceeds ${formatDuration(targetRpo)} RPO target`,
      severity: withinRpo ? 'info' : 'critical',
    });

    // Check 4: Size trend
    if (item.previousSizeBytes !== null && item.previousSizeBytes > 0) {
      const ratio = item.sizeBytes / item.previousSizeBytes;
      const dropped = ratio < SIZE_DROP_THRESHOLD;
      checks.push({
        name: CHECK_NAMES.SIZE_TREND,
        passed: !dropped,
        detail: dropped
          ? `Snapshot is ${formatBytes(item.sizeBytes)} — previous was ${formatBytes(item.previousSizeBytes)}. Size dropped ${Math.round((1 - ratio) * 100)}%`
          : 'Size is consistent with previous snapshot',
        severity: dropped ? 'critical' : 'info',
      });
    } else {
      checks.push({
        name: CHECK_NAMES.SIZE_TREND,
        passed: true,
        detail: 'No previous snapshot for size comparison',
        severity: 'info',
      });
    }

    // Check 5: Retention policy
    const retentionCheck = await this.checkRetentionPolicy(item, config);
    if (retentionCheck) {
      checks.push(retentionCheck);
    }

    const passed = checks.every((c) => c.passed);
    return { item, passed, checks };
  }

  async estimateRecoveryTime(item: BackupInventoryItem): Promise<RtoEstimate> {
    const dataRestoreSeconds = item.sizeBytes > 0
      ? Math.ceil(item.sizeBytes / RDS_RESTORE_THROUGHPUT_BPS)
      : 0;
    const totalSeconds = RDS_PROVISIONING_SECONDS + dataRestoreSeconds;

    return {
      source: item.source,
      providerKind: 'aws_rds',
      estimatedSeconds: totalSeconds,
      basis: `RDS snapshot restore: ~15min provisioning + data restore at ~10MB/s for ${formatBytes(item.sizeBytes)}`,
    };
  }

  // ── Private: inventory helpers ──

  private async inventoryInstanceSnapshots(
    client: InstanceType<RDSModule['RDSClient']>,
    rds: RDSModule,
    config: BackupProviderConfig,
    creds: { accountId: string; region: string },
  ): Promise<BackupInventoryItem[]> {
    const items: BackupInventoryItem[] = [];
    const includeAutomated = config.aws?.includeAutomated !== false;
    const filterIds = config.aws?.dbInstanceIdentifiers;

    try {
      const params: Record<string, unknown> = { MaxRecords: 100 };
      if (filterIds && filterIds.length === 1) {
        params.DBInstanceIdentifier = filterIds[0];
      }
      if (!includeAutomated) {
        params.SnapshotType = 'manual';
      }

      const resp = await client.send(new rds.DescribeDBSnapshotsCommand(params));
      const snapshots = resp.DBSnapshots ?? [];

      // Group by DB instance, sort newest-first
      const byInstance = new Map<string, SnapshotLike[]>();
      for (const snap of snapshots) {
        const dbId = snap.DBInstanceIdentifier ?? 'unknown';
        if (filterIds && filterIds.length > 1 && !filterIds.includes(dbId)) continue;
        const group = byInstance.get(dbId) ?? [];
        group.push(snap as SnapshotLike);
        byInstance.set(dbId, group);
      }

      for (const [dbId, snaps] of byInstance) {
        snaps.sort((a: SnapshotLike, b: SnapshotLike) =>
          (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0),
        );

        const capped = snaps.slice(0, MAX_SNAPSHOTS_PER_INSTANCE);
        for (let i = 0; i < capped.length; i++) {
          const snap = capped[i];
          const sizeBytes = (snap.AllocatedStorage ?? 0) * 1024 * 1024 * 1024;
          const prevSnap = i + 1 < capped.length ? capped[i + 1] : null;
          const previousSizeBytes = prevSnap
            ? (prevSnap.AllocatedStorage ?? 0) * 1024 * 1024 * 1024
            : null;

          items.push({
            providerKind: 'aws_rds',
            label: `RDS snapshot: ${snap.DBSnapshotIdentifier} of ${dbId}`,
            location: snap.DBSnapshotArn ?? snap.DBSnapshotIdentifier ?? '',
            source: dbId,
            createdAt: snap.SnapshotCreateTime?.toISOString() ?? new Date(0).toISOString(),
            sizeBytes,
            previousSizeBytes,
            region: creds.region,
            account: creds.accountId,
            snapshotStatus: snap.Status ?? 'unknown',
          });
        }
      }
    } catch {
      // API call failed — return empty (will show as not detected)
    }

    return items;
  }

  private async inventoryClusterSnapshots(
    client: InstanceType<RDSModule['RDSClient']>,
    rds: RDSModule,
    config: BackupProviderConfig,
    creds: { accountId: string; region: string },
  ): Promise<BackupInventoryItem[]> {
    const items: BackupInventoryItem[] = [];
    const includeAutomated = config.aws?.includeAutomated !== false;
    const filterIds = config.aws?.dbClusterIdentifiers;

    try {
      const params: Record<string, unknown> = { MaxRecords: 100 };
      if (filterIds && filterIds.length === 1) {
        params.DBClusterIdentifier = filterIds[0];
      }
      if (!includeAutomated) {
        params.SnapshotType = 'manual';
      }

      const resp = await client.send(new rds.DescribeDBClusterSnapshotsCommand(params));
      const snapshots = resp.DBClusterSnapshots ?? [];

      // Group by cluster, sort newest-first
      const byCluster = new Map<string, SnapshotLike[]>();
      for (const snap of snapshots) {
        const clusterId = snap.DBClusterIdentifier ?? 'unknown';
        if (filterIds && filterIds.length > 1 && !filterIds.includes(clusterId)) continue;
        const group = byCluster.get(clusterId) ?? [];
        group.push(snap as SnapshotLike);
        byCluster.set(clusterId, group);
      }

      for (const [clusterId, snaps] of byCluster) {
        snaps.sort((a: SnapshotLike, b: SnapshotLike) =>
          (b.SnapshotCreateTime?.getTime() ?? 0) - (a.SnapshotCreateTime?.getTime() ?? 0),
        );

        const capped = snaps.slice(0, MAX_SNAPSHOTS_PER_INSTANCE);
        for (let i = 0; i < capped.length; i++) {
          const snap = capped[i];
          const sizeBytes = (snap.AllocatedStorage ?? 0) * 1024 * 1024 * 1024;
          const prevSnap = i + 1 < capped.length ? capped[i + 1] : null;
          const previousSizeBytes = prevSnap
            ? (prevSnap.AllocatedStorage ?? 0) * 1024 * 1024 * 1024
            : null;

          items.push({
            providerKind: 'aws_rds',
            label: `Aurora snapshot: ${snap.DBClusterSnapshotIdentifier} of ${clusterId}`,
            location: snap.DBClusterSnapshotArn ?? snap.DBClusterSnapshotIdentifier ?? '',
            source: clusterId,
            createdAt: snap.SnapshotCreateTime?.toISOString() ?? new Date(0).toISOString(),
            sizeBytes,
            previousSizeBytes,
            region: creds.region,
            account: creds.accountId,
            snapshotStatus: snap.Status ?? 'unknown',
          });
        }
      }
    } catch {
      // Aurora not available or no clusters — return empty
    }

    return items;
  }

  private async checkRetentionPolicy(
    item: BackupInventoryItem,
    config: BackupProviderConfig,
  ): Promise<BackupCheck | null> {
    const rds = this.rdsModule ?? await tryImportAws<RDSModule>('@aws-sdk/client-rds');
    if (!rds) return null;

    const creds = await resolveAwsCredentials({
      region: config.aws?.region,
      profile: config.aws?.profile,
    });
    if (!creds.valid) return null;

    try {
      const client = new rds.RDSClient({
        region: creds.region,
        ...(config.aws?.profile ? { profile: config.aws.profile } : {}),
      });

      const resp = await client.send(new rds.DescribeDBInstancesCommand({
        DBInstanceIdentifier: item.source,
      }));

      const instance = resp.DBInstances?.[0];
      if (!instance) return null;

      const retention = instance.BackupRetentionPeriod ?? 0;
      if (retention === 0) {
        return {
          name: CHECK_NAMES.RETENTION_POLICY,
          passed: false,
          detail: 'Automated backups are disabled (retention period: 0 days). No point-in-time recovery is possible.',
          severity: 'critical',
        };
      }
      if (retention < 7) {
        return {
          name: CHECK_NAMES.RETENTION_POLICY,
          passed: false,
          detail: `Backup retention is ${retention} day(s) — consider increasing to at least 7 days for adequate recovery window`,
          severity: 'warning',
        };
      }
      return {
        name: CHECK_NAMES.RETENTION_POLICY,
        passed: true,
        detail: `Backup retention: ${retention} day(s)`,
        severity: 'info',
      };
    } catch {
      // Could be an Aurora cluster or instance not found — skip retention check
      return null;
    }
  }
}
