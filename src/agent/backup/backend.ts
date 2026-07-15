// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * BackupBackend — coordinator interface for backup verification.
 *
 * The backend aggregates one or more BackupProviders, each responsible for
 * a specific backup technology (file directories, pg_dump, ZFS, cloud APIs, etc.).
 * Adding a new backup type means implementing BackupProvider — the agent and
 * backend coordinator don't change.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

// ── Provider contract ──

/** Identifies a backup provider type. Extensible as new providers are added. */
export type BackupProviderKind =
  | 'file_directory'
  | 'pg_dump'
  | 'pg_basebackup'
  | 'zfs_snapshot'
  | 'lvm_snapshot'
  | 'etcd_snapshot'
  | 'velero'
  | 'aws_rds'
  | 'aws_s3'
  | string; // allows future cloud providers (gcp_cloudsql, azure_sql, etc.)

/** A single backup artifact discovered by a provider. */
export interface BackupInventoryItem {
  /** Provider that discovered this backup */
  providerKind: BackupProviderKind;
  /** Human-readable label (e.g. "nightly pg_dump of orders_db") */
  label: string;
  /** Where the backup lives (path, URI, snapshot ID) */
  location: string;
  /** What system or dataset this backs up */
  source: string;
  /** Backup creation timestamp (ISO 8601) */
  createdAt: string;
  /** Backup size in bytes (0 if unknown) */
  sizeBytes: number;
  /** Previous backup size for trend comparison (null if unavailable) */
  previousSizeBytes: number | null;
  /** Optional region/account for cloud-based backups */
  region?: string;
  account?: string;
  /** Snapshot status for cloud providers (e.g. 'available', 'creating', 'error') */
  snapshotStatus?: string;
  /** Storage class for object-store backups (e.g. 'STANDARD', 'GLACIER') */
  storageClass?: string;
}

/** Result of verifying a single backup. */
export interface BackupVerification {
  /** The backup that was verified */
  item: BackupInventoryItem;
  /** Did the verification pass? */
  passed: boolean;
  /** What checks were performed */
  checks: BackupCheck[];
}

/** A single verification check result. */
export interface BackupCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}

/** RPO evaluation for a backup source. */
export interface RpoEvaluation {
  source: string;
  providerKind: BackupProviderKind;
  /** Target RPO in seconds (from config or default) */
  targetRpoSeconds: number;
  /** Actual age of the newest backup in seconds */
  actualAgeSeconds: number;
  /** Is the backup within the RPO target? */
  withinTarget: boolean;
}

/** RTO estimate for recovery. */
export interface RtoEstimate {
  source: string;
  providerKind: BackupProviderKind;
  /** Estimated recovery time in seconds */
  estimatedSeconds: number;
  /** How this estimate was derived */
  basis: string;
}

/** Default RPO if not configured: 24 hours. */
export const DEFAULT_RPO_SECONDS = 86400;

/** Standard check names used across agent, simulator, and live client. */
export const CHECK_NAMES = {
  EXISTS: 'exists',
  RECENCY: 'recency',
  SIZE_TREND: 'size_trend',
  INTEGRITY: 'integrity',
  SNAPSHOT_STATUS: 'snapshot_status',
  RETENTION_POLICY: 'retention_policy',
  STORAGE_CLASS: 'storage_class',
  VERSIONING: 'versioning',
} as const;

/** AWS-specific configuration for cloud backup providers. */
export interface AwsBackupConfig {
  region?: string | undefined;
  profile?: string | undefined;
  /** RDS: filter to specific DB instances */
  dbInstanceIdentifiers?: string[] | undefined;
  /** RDS: filter to specific Aurora clusters */
  dbClusterIdentifiers?: string[] | undefined;
  /** RDS: include automated snapshots (default: true) */
  includeAutomated?: boolean;
  /** S3: bucket name */
  bucket?: string;
  /** S3: key prefix to filter objects */
  prefix?: string | undefined;
  /** S3: glob pattern for backup file names */
  filePattern?: string | undefined;
}

/** Configuration for a single backup provider. */
export interface BackupProviderConfig {
  kind: BackupProviderKind;
  /** Paths, URIs, or connection details (provider-specific) */
  locations: string[];
  /** What system/dataset this provider covers */
  source: string;
  /** Target RPO in seconds (default: 86400 = 24h) */
  rpoSeconds?: number;
  /** Target RTO in seconds (optional) */
  rtoSeconds?: number;
  /** AWS-specific configuration for aws_rds and aws_s3 providers */
  aws?: AwsBackupConfig;
}

/**
 * BackupProvider — strategy interface for a specific backup technology.
 *
 * Each provider knows how to discover, inventory, and verify backups
 * for its technology. The agent coordinator iterates over providers.
 */
export interface BackupProvider {
  kind: BackupProviderKind;

  /** Can this provider find backups at its configured locations? */
  detect(config: BackupProviderConfig): Promise<boolean>;

  /** Enumerate all backup artifacts found. */
  inventory(config: BackupProviderConfig): Promise<BackupInventoryItem[]>;

  /** Verify a specific backup's integrity and recency. */
  verify(item: BackupInventoryItem, config: BackupProviderConfig): Promise<BackupVerification>;

  /** Estimate recovery time for a backup (optional). */
  estimateRecoveryTime?(item: BackupInventoryItem): Promise<RtoEstimate>;
}

/** Aggregated report across all providers. */
export interface BackupVerificationReport {
  /** Timestamp of the verification run */
  verifiedAt: string;
  /** Per-provider results */
  providers: ProviderReport[];
  /** RPO evaluations */
  rpoEvaluations: RpoEvaluation[];
  /** RTO estimates (when available) */
  rtoEstimates: RtoEstimate[];
  /** Sources with no backup provider configured */
  uncoveredSources: string[];
}

export interface ProviderReport {
  kind: BackupProviderKind;
  source: string;
  detected: boolean;
  items: BackupInventoryItem[];
  verifications: BackupVerification[];
}

// ── Backend interface ──

export interface BackupBackend extends ExecutionBackend {
  /** Run verification across all configured providers. */
  verifyAll(configs: BackupProviderConfig[]): Promise<BackupVerificationReport>;

  /** List registered provider kinds. */
  listProviderKinds(): BackupProviderKind[];

  /** Simulator-only state transition hook. */
  transition?(to: string): void;
}
