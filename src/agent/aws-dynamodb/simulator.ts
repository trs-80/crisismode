// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { DynamoDbRecoveryBackend, TableBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovered';

export class DynamoDbRecoverySimulator implements DynamoDbRecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getTableBackupConfig(): Promise<TableBackupConfig> {
    switch (this.state) {
      case 'degraded':
        return {
          tableName: 'orders-production',
          region: 'us-east-1',
          pitrEnabled: false,
          pitrEarliestRestoreDate: null,
          pitrLatestRestoreDate: null,
        };
      case 'recovered':
        return {
          tableName: 'orders-production',
          region: 'us-east-1',
          pitrEnabled: true,
          pitrEarliestRestoreDate: new Date(Date.now() - 5 * 60_000).toISOString(),
          pitrLatestRestoreDate: new Date().toISOString(),
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported DynamoDB simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_table_backup_config':
        return { config: await this.getTableBackupConfig() };
      case 'update_continuous_backups':
        this.transition('recovered');
        return { pitrEnabled: true };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('pitr_status')) {
      const config = await this.getTableBackupConfig();
      const actual = config.pitrEnabled ? 'ENABLED' : 'DISABLED';
      return this.compare(actual, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('continuous_backups_status')) {
      const config = await this.getTableBackupConfig();
      const actual = config.pitrEnabled ? 'ENABLED' : 'DISABLED';
      return this.compare(actual, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'dynamodb-simulator-backup',
        kind: 'capability_provider',
        name: 'DynamoDB Simulator Backup Provider',
        maturity: 'simulator_only',
        capabilities: ['dynamodb.backup.read', 'dynamodb.backup.write'],
        executionContexts: ['dynamodb_read', 'dynamodb_write'],
        targetKinds: ['aws-dynamodb'],
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
