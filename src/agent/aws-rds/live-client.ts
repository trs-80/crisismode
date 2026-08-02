// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RdsRecoveryLiveClient — connects to real AWS RDS and implements RdsRecoveryBackend.
 *
 * Uses @aws-sdk/client-rds via dynamic import to query instance backup configuration,
 * modify retention periods, and create snapshots.
 */

import { tryImportAws } from '../aws-common.js';
import type * as RdsSdkModule from '@aws-sdk/client-rds';
import type {
  RdsRecoveryBackend,
  InstanceBackupConfig,
  RdsInstanceHealth,
  RdsEvent,
  RdsLiveMetrics,
  RdsPortReachability,
  PermissionMissing,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export interface RdsConnectionConfig {
  region: string;
  instanceId: string;
}

export class RdsRecoveryLiveClient implements RdsRecoveryBackend {
  private region: string;
  private instanceId: string;
  private rdsClient: unknown | null = null;
  private rdsSdk: typeof RdsSdkModule | null = null;

  constructor(config: RdsConnectionConfig) {
    this.region = config.region;
    this.instanceId = config.instanceId;
  }

  private async ensureClient(): Promise<{
    sdk: typeof RdsSdkModule;
    client: InstanceType<(typeof RdsSdkModule)['RDSClient']>;
  }> {
    if (this.rdsSdk && this.rdsClient) {
      return {
        sdk: this.rdsSdk,
        client: this.rdsClient as InstanceType<(typeof RdsSdkModule)['RDSClient']>,
      };
    }

    const sdk = await tryImportAws<typeof RdsSdkModule>('@aws-sdk/client-rds');
    if (!sdk) {
      throw new Error('@aws-sdk/client-rds is not installed. Install it to use the RDS live client.');
    }

    this.rdsSdk = sdk;
    this.rdsClient = new sdk.RDSClient({ region: this.region });
    return {
      sdk,
      client: this.rdsClient as InstanceType<(typeof RdsSdkModule)['RDSClient']>,
    };
  }

  async getInstanceBackupConfig(): Promise<InstanceBackupConfig> {
    const { sdk, client } = await this.ensureClient();

    const describeResp = await client.send(
      new sdk.DescribeDBInstancesCommand({
        DBInstanceIdentifier: this.instanceId,
      }),
    );

    const instance = describeResp.DBInstances?.[0];
    if (!instance) {
      throw new Error(`RDS instance not found: ${this.instanceId}`);
    }

    const snapshotResp = await client.send(
      new sdk.DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: this.instanceId,
      }),
    );

    const snapshots = snapshotResp.DBSnapshots ?? [];
    const sortedSnapshots = snapshots
      .filter((s) => s.SnapshotCreateTime)
      .sort((a, b) => {
        const ta = new Date(a.SnapshotCreateTime!).getTime();
        const tb = new Date(b.SnapshotCreateTime!).getTime();
        return tb - ta;
      });

    const latestSnapshot = sortedSnapshots[0];
    const latestSnapshotTime = latestSnapshot?.SnapshotCreateTime
      ? new Date(latestSnapshot.SnapshotCreateTime).toISOString()
      : null;
    const latestSnapshotAge = latestSnapshotTime
      ? Math.floor((Date.now() - new Date(latestSnapshotTime).getTime()) / 1000)
      : 0;

    const retentionPeriod = instance.BackupRetentionPeriod ?? 0;

    return {
      instanceId: this.instanceId,
      region: this.region,
      engine: instance.Engine ?? 'unknown',
      status: instance.DBInstanceStatus ?? 'unknown',
      backupRetentionPeriod: retentionPeriod,
      latestSnapshotTime,
      snapshotCount: snapshots.length,
      latestSnapshotAge,
      automatedBackupsEnabled: retentionPeriod > 0,
    };
  }

  async getInstanceHealth(): Promise<RdsInstanceHealth | PermissionMissing> {
    try {
      const { sdk, client } = await this.ensureClient();
      const describeResp = await client.send(
        new sdk.DescribeDBInstancesCommand({
          DBInstanceIdentifier: this.instanceId,
        }),
      );

      const instance = describeResp.DBInstances?.[0];
      if (!instance) {
        throw new Error(`RDS instance not found: ${this.instanceId}`);
      }

      return {
        instanceId: this.instanceId,
        status: instance.DBInstanceStatus ?? 'unknown',
        engine: instance.Engine ?? 'unknown',
        engineVersion: instance.EngineVersion ?? 'unknown',
        instanceClass: instance.DBInstanceClass ?? 'unknown',
        allocatedStorageGb: instance.AllocatedStorage ?? 0,
        multiAz: instance.MultiAZ ?? false,
        pendingModifications: instance.PendingModifiedValues
          ? Object.keys(instance.PendingModifiedValues).filter((k) => (instance.PendingModifiedValues as Record<string, unknown>)[k])
          : [],
        endpointPort: instance.Endpoint?.Port ?? 5432,
        vpcSecurityGroupIds: (instance.VpcSecurityGroups ?? []).map((sg) => sg.VpcSecurityGroupId ?? ''),
      };
    } catch (error) {
      const err = error as Error & { Code?: string };
      if (err.Code?.includes('UnauthorizedOperation') || err.Code?.includes('AccessDenied')) {
        return { permissionMissing: 'rds:DescribeDBInstances' };
      }
      throw error;
    }
  }

  async getRecentEvents(hours: number): Promise<RdsEvent[] | PermissionMissing> {
    try {
      const { sdk, client } = await this.ensureClient();
      const startTime = new Date(Date.now() - hours * 3600000);
      const resp = await client.send(
        new sdk.DescribeEventsCommand({
          SourceIdentifier: this.instanceId,
          StartTime: startTime,
        }),
      );

      return (resp.Events ?? []).map((event) => ({
        at: event.Date?.toISOString() ?? '',
        message: event.Message ?? '',
        category: event.EventCategories?.[0] ?? 'unknown',
      }));
    } catch (error) {
      const err = error as Error & { Code?: string };
      if (err.Code?.includes('UnauthorizedOperation') || err.Code?.includes('AccessDenied')) {
        return { permissionMissing: 'rds:DescribeEvents' };
      }
      throw error;
    }
  }

  async getLiveMetrics(): Promise<RdsLiveMetrics | PermissionMissing> {
    // CloudWatch metrics require additional AWS SDK and permissions
    // For now, return permission missing to indicate this needs AWS setup
    return { permissionMissing: 'cloudwatch:GetMetricStatistics' };
  }

  async getPortReachability(): Promise<RdsPortReachability | PermissionMissing> {
    try {
      const rdsData = await this.getInstanceHealth();
      if ('permissionMissing' in rdsData) {
        return { permissionMissing: 'ec2:DescribeSecurityGroups' };
      }

      // Port reachability requires EC2 API access for security group rules
      // For now, return permission missing to indicate this needs AWS setup
      return { permissionMissing: 'ec2:DescribeSecurityGroups' };
    } catch (error) {
      const err = error as Error & { Code?: string };
      if (err.Code?.includes('UnauthorizedOperation') || err.Code?.includes('AccessDenied')) {
        return { permissionMissing: 'ec2:DescribeSecurityGroups' };
      }
      throw error;
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }

    const { sdk, client } = await this.ensureClient();

    switch (command.operation) {
      case 'get_instance_backup_config': {
        return { config: await this.getInstanceBackupConfig() };
      }
      case 'modify_db_instance': {
        const retentionPeriod = (command.parameters?.backupRetentionPeriod as number) ?? 7;
        const resp = await client.send(
          new sdk.ModifyDBInstanceCommand({
            DBInstanceIdentifier: this.instanceId,
            BackupRetentionPeriod: retentionPeriod,
            ApplyImmediately: true,
          }),
        );
        return {
          modified: true,
          backupRetentionPeriod: resp.DBInstance?.BackupRetentionPeriod ?? retentionPeriod,
        };
      }
      case 'create_db_snapshot': {
        const snapshotId = (command.parameters?.snapshotId as string) ?? `crisismode-${Date.now()}`;
        const resp = await client.send(
          new sdk.CreateDBSnapshotCommand({
            DBInstanceIdentifier: this.instanceId,
            DBSnapshotIdentifier: snapshotId,
          }),
        );
        return {
          snapshotCreated: true,
          snapshotId: resp.DBSnapshot?.DBSnapshotIdentifier ?? snapshotId,
        };
      }
      default:
        throw new Error(`Unknown RDS operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('backup_retention_period')) {
      const config = await this.getInstanceBackupConfig();
      return compareCheckValue(config.backupRetentionPeriod, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('snapshot_count')) {
      const config = await this.getInstanceBackupConfig();
      return compareCheckValue(config.snapshotCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('automated_backups_enabled')) {
      const config = await this.getInstanceBackupConfig();
      return compareCheckValue(config.automatedBackupsEnabled ? 1 : 0, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('instance_status')) {
      const config = await this.getInstanceBackupConfig();
      return compareCheckValue(config.status, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'rds-live-admin',
        kind: 'capability_provider',
        name: 'RDS Live Admin Provider',
        maturity: 'live_validated',
        capabilities: ['rds.instance.read', 'rds.instance.modify', 'rds.snapshot.create', 'rds.snapshot.read'],
        executionContexts: ['rds_read', 'rds_write'],
        targetKinds: ['aws-rds'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    // RDS client does not require explicit cleanup
    this.rdsClient = null;
    this.rdsSdk = null;
  }

}
