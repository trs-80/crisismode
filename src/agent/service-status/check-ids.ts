// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check identifiers for every finding this agent emits. These are a
 * public contract: guidance is anchored to them, so they are additive-only —
 * renaming one breaks every consumer downstream.
 *
 * Shape matches PR 3's LLM_PROVIDER_CHECK_IDS: a keyed `as const` object, so
 * call sites read as `SERVICE_STATUS_CHECK_IDS.statusPage` and PR 5's guidance
 * registry can enumerate the strings with Object.values(). This file stays
 * dependency-free so that registry can import it without pulling in the agent.
 */

export const SERVICE_STATUS_CHECK_IDS = {
  statusPage: 'service-status.status_page',
  reachability: 'service-status.reachability',
} as const;

export type ServiceStatusCheckId =
  (typeof SERVICE_STATUS_CHECK_IDS)[keyof typeof SERVICE_STATUS_CHECK_IDS];
