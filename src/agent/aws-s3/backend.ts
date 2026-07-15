// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * S3RecoveryBackend — interface for querying and recovering AWS S3 bucket configuration.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface BucketVersioningStatus {
  status: 'Enabled' | 'Suspended' | 'Disabled';
}

export interface LifecycleRule {
  id: string;
  status: 'Enabled' | 'Disabled';
  prefix: string;
  transitions: { days: number; storageClass: string }[];
  expiration?: { days: number } | undefined;
}

export interface BucketConfig {
  bucket: string;
  region: string;
  versioningStatus: 'Enabled' | 'Suspended' | 'Disabled';
  lifecycleRules: LifecycleRule[];
}

export interface S3RecoveryBackend extends ExecutionBackend {
  /** Get current bucket configuration including versioning and lifecycle rules */
  getBucketConfig(): Promise<BucketConfig>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
