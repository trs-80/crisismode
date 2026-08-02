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

/** A live-client check that failed because an IAM action is not allowed. */
export interface PermissionMissing {
  permissionMissing: string;
}

export function isPermissionMissing(v: unknown): v is PermissionMissing {
  return typeof v === 'object' && v !== null && 'permissionMissing' in v;
}

export interface RdsInstanceHealth {
  instanceId: string;
  status: string;              // 'available' | 'storage-full' | 'rebooting' | ...
  engine: string;
  engineVersion: string;
  instanceClass: string;       // e.g. 'db.t3.micro'
  allocatedStorageGb: number;
  multiAz: boolean;
  pendingModifications: string[];
  endpointPort: number;
  vpcSecurityGroupIds: string[];
}

export interface RdsEvent {
  at: string;
  message: string;
  category: string;
}

export interface RdsLiveMetrics {
  databaseConnections: number | null;
  approxMaxConnections: number | null;  // derived from instance class; null when class unknown
  cpuUtilizationPct: number | null;
  freeStorageBytes: number | null;
  freeableMemoryBytes: number | null;
}

export interface RdsPortReachability {
  port: number;
  /** CIDR ranges and security-group ids allowed to reach the DB port */
  openTo: string[];
}

/** Result of a pre-flight AWS credential check, before any control-plane calls are made. */
export interface AwsCredentialValidation {
  valid: boolean;
  /** Why validation failed — populated only when valid is false. */
  reason?: string;
}

export interface RdsRecoveryBackend extends ExecutionBackend {
  /**
   * Optional pre-flight credential check. Live clients implement this via STS
   * GetCallerIdentity; the simulator implements it as an always-valid no-op.
   * When present and invalid, the agent skips all AWS calls for this cycle.
   */
  validateCredentials?(): Promise<AwsCredentialValidation>;

  /** Get the backup configuration and snapshot status for the target RDS instance */
  getInstanceBackupConfig(): Promise<InstanceBackupConfig>;

  /** Get the instance health including status, instance class, and pending modifications */
  getInstanceHealth(): Promise<RdsInstanceHealth | PermissionMissing>;

  /** Get recent RDS events for this instance */
  getRecentEvents(hours: number): Promise<RdsEvent[] | PermissionMissing>;

  /** Get live CloudWatch metrics for the instance */
  getLiveMetrics(): Promise<RdsLiveMetrics | PermissionMissing>;

  /** Get the port reachability configuration */
  getPortReachability(): Promise<RdsPortReachability | PermissionMissing>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
