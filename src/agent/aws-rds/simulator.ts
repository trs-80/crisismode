// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RdsRecoveryBackend, InstanceBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class RdsRecoverySimulator implements RdsRecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    if (to !== 'degraded' && to !== 'recovering' && to !== 'recovered') {
      throw new Error(`Invalid RDS simulator state: ${to}`);
    }
    this.state = to;
  }

  async getInstanceBackupConfig(): Promise<InstanceBackupConfig> {
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
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported RDS simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_instance_backup_config':
        return { config: await this.getInstanceBackupConfig() };
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

    return true;
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
