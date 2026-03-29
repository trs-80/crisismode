// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RdsRecoveryBackend — interface for querying AWS RDS instance backup state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface InstanceBackupConfig {
  instanceId: string;
  region: string;
  engine: string;
  status: string;
  backupRetentionPeriod: number; // 0 = disabled
  latestSnapshotTime: string | null;
  snapshotCount: number;
  latestSnapshotAge: number; // seconds since last snapshot
  automatedBackupsEnabled: boolean;
}

export interface RdsRecoveryBackend extends ExecutionBackend {
  /** Get the backup configuration and snapshot status for the target RDS instance */
  getInstanceBackupConfig(): Promise<InstanceBackupConfig>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
