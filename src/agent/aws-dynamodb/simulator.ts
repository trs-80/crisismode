// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { DynamoDbRecoveryBackend, TableBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState = 'degraded' | 'recovered';

export class DynamoDbRecoverySimulator implements DynamoDbRecoveryBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    if (to !== 'degraded' && to !== 'recovered') {
      throw new Error(`Invalid DynamoDB simulator state: ${to}`);
    }
    this.state = to;
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
      return compareCheckValue(actual, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('continuous_backups_status')) {
      const config = await this.getTableBackupConfig();
      const actual = config.pitrEnabled ? 'ENABLED' : 'DISABLED';
      return compareCheckValue(actual, check.expect.operator, check.expect.value);
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

}
