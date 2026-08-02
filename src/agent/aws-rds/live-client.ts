// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RdsRecoveryLiveClient — connects to real AWS RDS and implements RdsRecoveryBackend.
 *
 * Uses @aws-sdk/client-rds via dynamic import to query instance backup configuration,
 * modify retention periods, and create snapshots.
 */

import { tryImportAws, resolveAwsCredentials } from '../aws-common.js';
import type * as RdsSdkModule from '@aws-sdk/client-rds';
import type * as CloudWatchSdkModule from '@aws-sdk/client-cloudwatch';
import type * as Ec2SdkModule from '@aws-sdk/client-ec2';
import type {
  RdsRecoveryBackend,
  InstanceBackupConfig,
  RdsInstanceHealth,
  RdsEvent,
  RdsLiveMetrics,
  RdsPortReachability,
  PermissionMissing,
  AwsCredentialValidation,
} from './backend.js';
import { isPermissionMissing } from './backend.js';
import { approxMaxConnections, summarizeSgRules, isAccessDeniedError, isInstanceNotFoundError } from './control-plane-helpers.js';
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
  private cloudWatchClient: unknown | null = null;
  private cloudWatchSdk: typeof CloudWatchSdkModule | null = null;
  private ec2Client: unknown | null = null;
  private ec2Sdk: typeof Ec2SdkModule | null = null;

  /** Cached getInstanceHealth() result — avoids duplicate DescribeDBInstances calls within one scan. */
  private instanceHealthCache: RdsInstanceHealth | PermissionMissing | null = null;

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

  private async ensureCloudWatch(): Promise<{
    sdk: typeof CloudWatchSdkModule;
    client: InstanceType<(typeof CloudWatchSdkModule)['CloudWatchClient']>;
  } | null> {
    if (this.cloudWatchSdk && this.cloudWatchClient) {
      return {
        sdk: this.cloudWatchSdk,
        client: this.cloudWatchClient as InstanceType<(typeof CloudWatchSdkModule)['CloudWatchClient']>,
      };
    }

    const sdk = await tryImportAws<typeof CloudWatchSdkModule>('@aws-sdk/client-cloudwatch');
    if (!sdk) return null;

    this.cloudWatchSdk = sdk;
    this.cloudWatchClient = new sdk.CloudWatchClient({ region: this.region });
    return {
      sdk,
      client: this.cloudWatchClient as InstanceType<(typeof CloudWatchSdkModule)['CloudWatchClient']>,
    };
  }

  private async ensureEc2(): Promise<{
    sdk: typeof Ec2SdkModule;
    client: InstanceType<(typeof Ec2SdkModule)['EC2Client']>;
  } | null> {
    if (this.ec2Sdk && this.ec2Client) {
      return {
        sdk: this.ec2Sdk,
        client: this.ec2Client as InstanceType<(typeof Ec2SdkModule)['EC2Client']>,
      };
    }

    const sdk = await tryImportAws<typeof Ec2SdkModule>('@aws-sdk/client-ec2');
    if (!sdk) return null;

    this.ec2Sdk = sdk;
    this.ec2Client = new sdk.EC2Client({ region: this.region });
    return {
      sdk,
      client: this.ec2Client as InstanceType<(typeof Ec2SdkModule)['EC2Client']>,
    };
  }

  /** Pre-flight credential check via STS GetCallerIdentity — no RDS calls yet. */
  async validateCredentials(): Promise<AwsCredentialValidation> {
    const result = await resolveAwsCredentials({ region: this.region });
    return result.valid ? { valid: true } : { valid: false, reason: result.reason ?? 'unknown error' };
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
    if (this.instanceHealthCache) {
      return this.instanceHealthCache;
    }

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

      const result: RdsInstanceHealth = {
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
        vpcSecurityGroupIds: (instance.VpcSecurityGroups ?? [])
          .map((sg) => sg.VpcSecurityGroupId ?? '')
          .filter((id) => id !== ''),
      };
      this.instanceHealthCache = result;
      return result;
    } catch (error) {
      if (isAccessDeniedError(error)) {
        const result: PermissionMissing = { permissionMissing: 'rds:DescribeDBInstances' };
        this.instanceHealthCache = result;
        return result;
      }
      if (isInstanceNotFoundError(error)) {
        throw new Error(
          `RDS instance '${this.instanceId}' not found in account/region these credentials see (region: ${this.region}). ` +
            `If this is a company database, your personal AWS credentials may point at the wrong account.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getRecentEvents(hours: number): Promise<RdsEvent[] | PermissionMissing> {
    try {
      const { sdk, client } = await this.ensureClient();
      const resp = await client.send(
        new sdk.DescribeEventsCommand({
          SourceIdentifier: this.instanceId,
          SourceType: 'db-instance',
          Duration: hours * 60,
        }),
      );

      return (resp.Events ?? []).map((event) => ({
        at: event.Date?.toISOString() ?? '',
        message: event.Message ?? '',
        category: event.EventCategories?.[0] ?? 'unknown',
      }));
    } catch (error) {
      if (isAccessDeniedError(error)) {
        return { permissionMissing: 'rds:DescribeEvents' };
      }
      throw error;
    }
  }

  async getLiveMetrics(): Promise<RdsLiveMetrics | PermissionMissing> {
    const cloudWatch = await this.ensureCloudWatch();
    if (!cloudWatch) {
      return { permissionMissing: 'sdk:@aws-sdk/client-cloudwatch not installed' };
    }
    const { sdk, client } = cloudWatch;

    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 15 * 60 * 1000);
      const metricIds = {
        databaseConnections: 'DatabaseConnections',
        cpuUtilizationPct: 'CPUUtilization',
        freeStorageBytes: 'FreeStorageSpace',
        freeableMemoryBytes: 'FreeableMemory',
      } as const;

      const resp = await client.send(
        new sdk.GetMetricDataCommand({
          MetricDataQueries: Object.entries(metricIds).map(([id, metricName]) => ({
            Id: id.toLowerCase(),
            MetricStat: {
              Metric: {
                Namespace: 'AWS/RDS',
                MetricName: metricName,
                Dimensions: [{ Name: 'DBInstanceIdentifier', Value: this.instanceId }],
              },
              Period: 300,
              Stat: 'Average',
            },
            ReturnData: true,
          })),
          StartTime: startTime,
          EndTime: endTime,
          ScanBy: 'TimestampDescending',
        }),
      );

      const latest = (id: string): number | null => {
        const values = resp.MetricDataResults?.find((r) => r.Id === id.toLowerCase())?.Values;
        return values && values.length > 0 ? values[0]! : null;
      };

      const health = await this.getInstanceHealth();
      const maxConnections = isPermissionMissing(health) ? null : approxMaxConnections(health.instanceClass, health.engine);

      return {
        databaseConnections: latest('databaseConnections'),
        approxMaxConnections: maxConnections,
        cpuUtilizationPct: latest('cpuUtilizationPct'),
        freeStorageBytes: latest('freeStorageBytes'),
        freeableMemoryBytes: latest('freeableMemoryBytes'),
      };
    } catch (error) {
      if (isAccessDeniedError(error)) {
        return { permissionMissing: 'cloudwatch:GetMetricData' };
      }
      throw error;
    }
  }

  async getPortReachability(): Promise<RdsPortReachability | PermissionMissing> {
    const health = await this.getInstanceHealth();
    if (isPermissionMissing(health)) {
      return health;
    }

    const ec2 = await this.ensureEc2();
    if (!ec2) {
      return { permissionMissing: 'sdk:@aws-sdk/client-ec2 not installed' };
    }
    const { sdk, client } = ec2;

    if (health.vpcSecurityGroupIds.length === 0) {
      return { port: health.endpointPort, openTo: [] };
    }

    try {
      const resp = await client.send(
        new sdk.DescribeSecurityGroupsCommand({
          GroupIds: health.vpcSecurityGroupIds,
        }),
      );

      const permissions = (resp.SecurityGroups ?? []).flatMap((sg) => sg.IpPermissions ?? []);
      return {
        port: health.endpointPort,
        openTo: summarizeSgRules(health.endpointPort, permissions),
      };
    } catch (error) {
      if (isAccessDeniedError(error)) {
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
      case 'get_instance_health': {
        return { health: await this.getInstanceHealth() };
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
    // Clients do not require explicit cleanup; clear references and cache
    this.rdsClient = null;
    this.rdsSdk = null;
    this.cloudWatchClient = null;
    this.cloudWatchSdk = null;
    this.ec2Client = null;
    this.ec2Sdk = null;
    this.instanceHealthCache = null;
  }

}
