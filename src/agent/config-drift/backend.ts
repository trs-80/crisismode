// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * ConfigDriftBackend — interface for querying config, secret, and
 * environment variable state after deploys.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface EnvVarStatus {
  name: string;
  expected: string | null;
  actual: string | null;
  source: string;
  lastChanged?: string;
  masked: boolean;
}

export interface SecretStatus {
  name: string;
  provider: string;
  mounted: boolean;
  expired: boolean;
  lastRotated?: string;
}

export interface ConfigDiff {
  path: string;
  expected: string;
  actual: string;
  source: 'env' | 'file' | 'secret' | 'remote';
}

export interface ConfigChange {
  path: string;
  previousValue?: string;
  currentValue?: string;
  changedAt: string;
  changedBy?: string;
  source: string;
}

export interface ConfigDriftBackend extends ExecutionBackend {
  /** Get current env vars with expected vs actual values */
  getEnvironmentVars(): Promise<EnvVarStatus[]>;

  /** Get secret mount and rotation status */
  getSecretStatus(): Promise<SecretStatus[]>;

  /** Get diff between expected and actual config */
  getConfigDiff(): Promise<ConfigDiff[]>;

  /** Get recent config/secret changes */
  getRecentConfigChanges(): Promise<ConfigChange[]>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
