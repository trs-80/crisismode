// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DynamoDbRecoveryLiveClient — connects to real AWS DynamoDB and implements DynamoDbRecoveryBackend.
 *
 * Queries DescribeContinuousBackups and UpdateContinuousBackups against actual DynamoDB tables.
 * Uses dynamic import via tryImportAws to degrade gracefully when the SDK is not installed.
 */

import { tryImportAws } from '../aws-common.js';
import type { DynamoDbRecoveryBackend, TableBackupConfig } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

/** Subset of the DynamoDB continuous-backups response shape this client reads. */
interface ContinuousBackupsResponse {
  ContinuousBackupsDescription?: {
    PointInTimeRecoveryDescription?: {
      PointInTimeRecoveryStatus?: string;
      EarliestRestorableDateTime?: Date;
      LatestRestorableDateTime?: Date;
    };
  };
}

/** Dynamically-imported AWS SDK module shape. */
interface DynamoDbSdkModule {
  DynamoDBClient: new (config: { region: string }) => {
    send(command: unknown): Promise<ContinuousBackupsResponse>;
    destroy(): void;
  };
  DescribeContinuousBackupsCommand: new (input: { TableName: string }) => unknown;
  UpdateContinuousBackupsCommand: new (input: {
    TableName: string;
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: boolean };
  }) => unknown;
}

export interface DynamoDbLiveConfig {
  region: string;
  table: string;
}

type DynamoDbClientInstance = InstanceType<DynamoDbSdkModule['DynamoDBClient']>;

export class DynamoDbRecoveryLiveClient implements DynamoDbRecoveryBackend {
  private config: DynamoDbLiveConfig;
  private sdkModule: DynamoDbSdkModule | null = null;
  private client: DynamoDbClientInstance | null = null;

  constructor(config: DynamoDbLiveConfig) {
    this.config = config;
  }

  private async getSdk(): Promise<DynamoDbSdkModule> {
    if (!this.sdkModule) {
      const mod = await tryImportAws<DynamoDbSdkModule>('@aws-sdk/client-dynamodb');
      if (!mod) {
        throw new Error('@aws-sdk/client-dynamodb is not installed. Install it to use the DynamoDB live client.');
      }
      this.sdkModule = mod;
    }
    return this.sdkModule;
  }

  /**
   * Lazily construct and reuse a single DynamoDBClient. Each client owns an HTTP
   * connection pool, so creating one per call would leak sockets across repeated
   * operations. Disposed in close().
   */
  private async getClient(): Promise<DynamoDbClientInstance> {
    if (!this.client) {
      const sdk = await this.getSdk();
      this.client = new sdk.DynamoDBClient({ region: this.config.region });
    }
    return this.client;
  }

  async getTableBackupConfig(): Promise<TableBackupConfig> {
    const sdk = await this.getSdk();
    const client = await this.getClient();

    const resp = await client.send(
      new sdk.DescribeContinuousBackupsCommand({ TableName: this.config.table }),
    );

    const desc = resp.ContinuousBackupsDescription;
    const pitrDesc = desc?.PointInTimeRecoveryDescription;
    const pitrEnabled = pitrDesc?.PointInTimeRecoveryStatus === 'ENABLED';

    return {
      tableName: this.config.table,
      region: this.config.region,
      pitrEnabled,
      pitrEarliestRestoreDate: pitrDesc?.EarliestRestorableDateTime?.toISOString() ?? null,
      pitrLatestRestoreDate: pitrDesc?.LatestRestorableDateTime?.toISOString() ?? null,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_table_backup_config': {
        return { config: await this.getTableBackupConfig() };
      }
      case 'update_continuous_backups': {
        const sdk = await this.getSdk();
        const client = await this.getClient();
        const resp = await client.send(
          new sdk.UpdateContinuousBackupsCommand({
            TableName: this.config.table,
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: true,
            },
          }),
        );
        const pitrDesc = resp.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
        return {
          pitrEnabled: pitrDesc?.PointInTimeRecoveryStatus === 'ENABLED',
        };
      }
      default:
        throw new Error(`Unknown DynamoDB operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('pitr_status') || stmt.includes('continuous_backups_status')) {
      const config = await this.getTableBackupConfig();
      const actual = config.pitrEnabled ? 'ENABLED' : 'DISABLED';
      return compareCheckValue(actual, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'dynamodb-live-backup',
        kind: 'capability_provider',
        name: 'DynamoDB Live Backup Provider',
        maturity: 'live_validated',
        capabilities: ['dynamodb.backup.read', 'dynamodb.backup.write'],
        executionContexts: ['dynamodb_read', 'dynamodb_write'],
        targetKinds: ['aws-dynamodb'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }

}
