// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check identifiers for every finding this agent emits. These are a
 * public contract: guidance is anchored to them, so they are additive-only —
 * renaming one breaks every consumer downstream.
 *
 * Shape matches PR 3's LLM_PROVIDER_CHECK_IDS: a keyed `as const` object, so
 * call sites read as `VECTOR_STORE_CHECK_IDS.authValid` and PR 5's guidance
 * registry can enumerate the strings with Object.values(). This file stays
 * dependency-free so that registry can import it without pulling in the agent.
 */

export const VECTOR_STORE_CHECK_IDS = {
  reachable: 'vector-store.reachable',
  authValid: 'vector-store.auth_valid',
  indexStatus: 'vector-store.index_status',
} as const;

export type VectorStoreCheckId =
  (typeof VECTOR_STORE_CHECK_IDS)[keyof typeof VECTOR_STORE_CHECK_IDS];
