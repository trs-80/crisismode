// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DynamoDbRecoveryBackend — interface for querying DynamoDB backup state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface TableBackupConfig {
  tableName: string;
  region: string;
  pitrEnabled: boolean;
  pitrEarliestRestoreDate: string | null;
  pitrLatestRestoreDate: string | null;
}

export interface DynamoDbRecoveryBackend extends ExecutionBackend {
  /** Get continuous backup / PITR configuration for the target table */
  getTableBackupConfig(): Promise<TableBackupConfig>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
