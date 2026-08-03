// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * IacDriftBackend — interface for querying Terraform state readability,
 * enumerating state-managed resources, and comparing them against live
 * infrastructure. Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { IacResource } from './state-parser.js';
import type { DriftComparison } from './drift-compare.js';
import type { PermissionMissing } from '../aws-common.js';

export type IacDriftScenario = 'drifted' | 'aligned' | 'state_unreadable';

export interface IacStateStatus {
  source: 'local' | 's3-backend' | 'unsupported-backend' | 'none';
  /** Human-readable: file path, bucket/key, or backend type */
  detail: string;
  readable: boolean;
  reason?: string | undefined;          // populated when readable is false
  serial?: number | undefined;
  lastModifiedAt?: string | undefined;  // ISO timestamp
  staleDays?: number | undefined;
  dirtyTfFiles?: boolean | undefined;   // uncommitted *.tf edits in git
  resourceCounts?: Record<string, number> | undefined;
}

export type ResourceExistence =
  | { existence: 'exists' | 'missing' }
  | { existence: 'unknown'; reason: string };

export interface IacDriftBackend extends ExecutionBackend {
  getStateStatus(): Promise<IacStateStatus>;
  listManagedResources(): Promise<IacResource[]>;
  checkResourceExistence(resource: IacResource): Promise<ResourceExistence | PermissionMissing>;
  /** null = resource type has no deep comparator (existence-only tier) */
  getResourceDrift(resource: IacResource): Promise<DriftComparison | PermissionMissing | null>;
  transition?(to: string): void;
}
