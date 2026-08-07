// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * VectorStoreBackend — the read-only contract both the simulator and the live
 * client implement. There are no mutating methods: this agent diagnoses a
 * managed vector store, it never changes one.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { VectorStoreProvider } from './provider-table.js';
import type { VectorStoreCheckId } from './check-ids.js';

// Re-exported so consumers (agent, live client, PR 5's guidance registry) can
// take the ids and the contract from one import.
export { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
export type { VectorStoreCheckId } from './check-ids.js';

export type VectorStoreCheckStatus = 'pass' | 'fail' | 'unknown';

export interface VectorStoreCheck {
  checkId: VectorStoreCheckId;
  status: VectorStoreCheckStatus;
  /** Plain-language result. Never contains key material. */
  detail: string;
}

export interface VectorStoreIndexInfo {
  name: string;
  ready: boolean;
  /** null when the provider did not report it — never guessed. */
  dimension: number | null;
  /** null when the provider did not report it — never guessed. */
  recordCount: number | null;
}

export interface VectorStoreReport {
  provider: VectorStoreProvider;
  /** Masked credential reference (last 4 characters) — never the key itself. */
  keyFingerprint: string;
  checks: VectorStoreCheck[];
  indexes: VectorStoreIndexInfo[];
}

export interface VectorStoreBackend extends ExecutionBackend {
  /**
   * One report per configured provider. A provider-level failure is reported
   * as a failing/unknown check inside its report — this never throws for a
   * network or auth problem.
   */
  queryVectorStores(): Promise<VectorStoreReport[]>;

  /** Simulator-only state transitions. */
  transition?(to: string): void;
}
