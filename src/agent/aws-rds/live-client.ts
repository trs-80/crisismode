// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RdsRecoveryLiveClient — connects to real AWS RDS and implements RdsRecoveryBackend.
 *
 * Uses @aws-sdk/client-rds via dynamic import to query instance backup configuration,
 * modify retention periods, and create snapshots.
 */

import { tryImportAws } from '../aws-common.js';
import type { RdsRecoveryBackend, InstanceBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export interface RdsConnectionConfig {
  region: string;
  instanceId: string;
}

export class RdsRecoveryLiveClient implements RdsRecoveryBackend {
  private region: string;
  private instanceId: string;
  private rdsClient: unknown | null = null;
  private rdsSdk: typeof import('@aws-sdk/client-rds') | null = null;

  constructor(config: RdsConnectionConfig) {
    this.region = config.region;
    this.instanceId = config.instanceId;
  }

  private async ensureClient(): Promise<{
    sdk: typeof import('@aws-sdk/client-rds');
    client: InstanceType<typeof import('@aws-sdk/client-rds').RDSClient>;
  }> {
    if (this.rdsSdk && this.rdsClient) {
      return {
        sdk: this.rdsSdk,
        client: this.rdsClient as InstanceType<typeof import('@aws-sdk/client-rds').RDSClient>,
      };
    }

    const sdk = await tryImportAws<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
    if (!sdk) {
      throw new Error('@aws-sdk/client-rds is not installed. Install it to use the RDS live client.');
    }

    this.rdsSdk = sdk;
    this.rdsClient = new sdk.RDSClient({ region: this.region });
    return {
      sdk,
      client: this.rdsClient as InstanceType<typeof import('@aws-sdk/client-rds').RDSClient>,
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
      return this.compare(config.backupRetentionPeriod, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('snapshot_count')) {
      const config = await this.getInstanceBackupConfig();
      return this.compare(config.snapshotCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('automated_backups_enabled')) {
      const config = await this.getInstanceBackupConfig();
      return this.compare(config.automatedBackupsEnabled ? 1 : 0, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('instance_status')) {
      const config = await this.getInstanceBackupConfig();
      return this.compare(config.status, check.expect.operator, check.expect.value);
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

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
