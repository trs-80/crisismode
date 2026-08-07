// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

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
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState =
  | 'degraded'
  | 'recovering'
  | 'recovered'
  | 'healthy'
  | 'storage_full'
  | 'connection_saturation'
  | 'sg_blocked'
  | 'maintenance_pending'
  | 'iam_denied'
  | 'instance_stopped';

export class RdsRecoverySimulator implements RdsRecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    const validStates = [
      'degraded',
      'recovering',
      'recovered',
      'healthy',
      'storage_full',
      'connection_saturation',
      'sg_blocked',
      'maintenance_pending',
      'iam_denied',
      'instance_stopped',
    ];
    if (!validStates.includes(to)) {
      throw new Error(`Invalid RDS simulator state: ${to}`);
    }
    this.state = to as SimulatorState;
  }

  /** The simulator never gates on AWS credentials — it always reports valid. */
  async validateCredentials(): Promise<AwsCredentialValidation> {
    return { valid: true };
  }

  async getInstanceBackupConfig(): Promise<InstanceBackupConfig> {
    // Backup behavior is independent of control-plane scenarios
    switch (this.state) {
      case 'degraded':
        return {
          instanceId: 'prod-db-01',
          region: 'us-east-1',
          engine: 'postgresql',
          status: 'available',
          backupRetentionPeriod: 0,
          latestSnapshotTime: null,
          snapshotCount: 0,
          latestSnapshotAge: 0,
          automatedBackupsEnabled: false,
        };
      case 'recovering':
        return {
          instanceId: 'prod-db-01',
          region: 'us-east-1',
          engine: 'postgresql',
          status: 'available',
          backupRetentionPeriod: 7,
          latestSnapshotTime: null,
          snapshotCount: 0,
          latestSnapshotAge: 0,
          automatedBackupsEnabled: true,
        };
      case 'recovered':
        return {
          instanceId: 'prod-db-01',
          region: 'us-east-1',
          engine: 'postgresql',
          status: 'available',
          backupRetentionPeriod: 7,
          latestSnapshotTime: new Date().toISOString(),
          snapshotCount: 1,
          latestSnapshotAge: 0,
          automatedBackupsEnabled: true,
        };
      // All control-plane scenarios use the same backup config
      default:
        return {
          instanceId: 'prod-db-01',
          region: 'us-east-1',
          engine: 'postgresql',
          status: 'available',
          backupRetentionPeriod: 7,
          latestSnapshotTime: new Date().toISOString(),
          snapshotCount: 5,
          latestSnapshotAge: 3600,
          automatedBackupsEnabled: true,
        };
    }
  }

  async getInstanceHealth(): Promise<RdsInstanceHealth | PermissionMissing> {
    if (this.state === 'iam_denied') {
      return { permissionMissing: 'rds:DescribeDBInstances' };
    }

    switch (this.state) {
      case 'storage_full':
        return {
          instanceId: 'prod-db-01',
          status: 'storage-full',
          engine: 'postgresql',
          engineVersion: '14.7',
          instanceClass: 'db.t3.micro',
          allocatedStorageGb: 20,
          multiAz: false,
          pendingModifications: [],
          endpointPort: 5432,
          vpcSecurityGroupIds: ['sg-123456'],
        };
      case 'instance_stopped':
        return {
          instanceId: 'prod-db-01',
          status: 'stopped',
          engine: 'postgresql',
          engineVersion: '14.7',
          instanceClass: 'db.t3.micro',
          allocatedStorageGb: 20,
          multiAz: false,
          pendingModifications: [],
          endpointPort: 5432,
          vpcSecurityGroupIds: ['sg-123456'],
        };
      case 'maintenance_pending':
        return {
          instanceId: 'prod-db-01',
          status: 'available',
          engine: 'postgresql',
          engineVersion: '14.7',
          instanceClass: 'db.t3.micro',
          allocatedStorageGb: 20,
          multiAz: false,
          pendingModifications: ['storage'],
          endpointPort: 5432,
          vpcSecurityGroupIds: ['sg-123456'],
        };
      case 'healthy':
      case 'degraded':
      case 'recovering':
      case 'recovered':
      case 'connection_saturation':
      case 'sg_blocked':
      default:
        return {
          instanceId: 'prod-db-01',
          status: 'available',
          engine: 'postgresql',
          engineVersion: '14.7',
          instanceClass: 'db.t3.micro',
          allocatedStorageGb: 20,
          multiAz: false,
          pendingModifications: [],
          endpointPort: 5432,
          vpcSecurityGroupIds: ['sg-123456'],
        };
    }
  }

  async getRecentEvents(_hours: number): Promise<RdsEvent[] | PermissionMissing> {
    if (this.state === 'iam_denied') {
      return { permissionMissing: 'rds:DescribeEvents' };
    }

    switch (this.state) {
      case 'maintenance_pending':
        return [
          {
            at: new Date(Date.now() - 3600000).toISOString(),
            message: 'DB instance scheduled for maintenance',
            category: 'maintenance',
          },
        ];
      default:
        return [];
    }
  }

  async getLiveMetrics(): Promise<RdsLiveMetrics | PermissionMissing> {
    if (this.state === 'iam_denied') {
      return { permissionMissing: 'cloudwatch:GetMetricData' };
    }

    const maxConnectionsForMicro = 85;

    switch (this.state) {
      case 'storage_full':
        return {
          databaseConnections: 12,
          approxMaxConnections: maxConnectionsForMicro,
          cpuUtilizationPct: 35,
          freeStorageBytes: 512 * 1024 * 1024, // 512 MiB, less than 1 GiB
          freeableMemoryBytes: 256 * 1024 * 1024,
        };
      case 'connection_saturation':
        return {
          databaseConnections: 78, // ~92% of max
          approxMaxConnections: maxConnectionsForMicro,
          cpuUtilizationPct: 65,
          freeStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
          freeableMemoryBytes: 256 * 1024 * 1024,
        };
      case 'healthy':
      case 'degraded':
      case 'recovering':
      case 'recovered':
      case 'sg_blocked':
      case 'maintenance_pending':
      default:
        return {
          databaseConnections: 12,
          approxMaxConnections: maxConnectionsForMicro,
          cpuUtilizationPct: 35,
          freeStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
          freeableMemoryBytes: 256 * 1024 * 1024,
        };
    }
  }

  async getPortReachability(): Promise<RdsPortReachability | PermissionMissing> {
    if (this.state === 'iam_denied') {
      return { permissionMissing: 'ec2:DescribeSecurityGroups' };
    }

    switch (this.state) {
      case 'sg_blocked':
        return {
          port: 5432,
          openTo: [],
        };
      case 'healthy':
      case 'degraded':
      case 'recovering':
      case 'recovered':
      case 'storage_full':
      case 'connection_saturation':
      case 'maintenance_pending':
      default:
        return {
          port: 5432,
          openTo: ['10.0.0.0/8', 'sg-app-servers'],
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported RDS simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_instance_backup_config':
        return { config: await this.getInstanceBackupConfig() };
      case 'get_instance_health':
        return { health: await this.getInstanceHealth() };
      case 'modify_db_instance':
        this.transition('recovering');
        return { modified: true, backupRetentionPeriod: 7 };
      case 'create_db_snapshot':
        this.transition('recovered');
        return { snapshotCreated: true, snapshotId: `manual-${Date.now()}` };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
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

    // Fail closed, matching the live client (and the vector-store
    // precedent): a precondition/success-criteria check on an unrecognized
    // statement is a plan-authoring bug, and this backend must not let it
    // pass silently. Throwing was considered instead, but the graph engine's
    // node functions (src/framework/graph-nodes.ts) call evaluateCheck
    // without a surrounding try/catch — an exception here would propagate
    // out of LangGraph's stream() uncaught rather than surface as a failed
    // step, so `false` is the only semantic both execution engines handle
    // safely.
    return false;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'rds-simulator-admin',
        kind: 'capability_provider',
        name: 'RDS Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: ['rds.instance.read', 'rds.instance.modify', 'rds.snapshot.create', 'rds.snapshot.read'],
        executionContexts: ['rds_read', 'rds_write'],
        targetKinds: ['aws-rds'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

}
