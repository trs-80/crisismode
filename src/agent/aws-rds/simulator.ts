// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RdsRecoveryBackend, InstanceBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class RdsRecoverySimulator implements RdsRecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
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
