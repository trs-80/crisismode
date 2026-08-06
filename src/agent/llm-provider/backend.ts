// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * LlmProviderBackend — the contract for read-only checks against one LLM
 * provider. Both the simulator and the live client implement it.
 *
 * Every check returns data, never throws: a provider that cannot be reached,
 * or that does not expose a signal, is reported as `unknown` with a reason.
 * A "down" claim is only ever made from an authenticated HTTP response.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { LlmProviderId } from './provider-table.js';

// Stable check ids carried on every signal and finding this agent emits.
// Defined in check-ids.ts so external consumers need not import this module.
export { LLM_PROVIDER_CHECK_IDS } from './check-ids.js';
export type { LlmProviderCheckId } from './check-ids.js';

/** Classification of an authenticated request that did not succeed. */
export type KeyFailureKind =
  | 'invalid_key'
  | 'billing_or_quota'
  | 'rate_limited'
  | 'permission'
  | 'other';

export interface KeyPresence {
  provider: LlmProviderId;
  present: boolean;
  /** Name of the env var the key came from — never its value. */
  envVar: string | null;
  /** Last-4 fingerprint, or null when no key is present. */
  fingerprint: string | null;
  /** Every env var name checked, for an honest "we looked here" message. */
  checkedEnvVars: string[];
}

export interface KeyValidity {
  provider: LlmProviderId;
  outcome: 'valid' | KeyFailureKind | 'unknown';
  /** HTTP status of the authenticated probe, or null when no response arrived. */
  httpStatus: number | null;
  detail: string;
}

export interface RateLimitHeadroom {
  provider: LlmProviderId;
  /** False when the provider exposed no usable headroom signal. */
  known: boolean;
  /** 0-100, or null when unknown. */
  requestsRemainingPct: number | null;
  /** 0-100, or null when unknown. */
  tokensRemainingPct: number | null;
  detail: string;
}

export interface ModelCheck {
  provider: LlmProviderId;
  /** The model id the app is configured to use, or null when none is declared. */
  configuredModel: string | null;
  source: 'config' | 'env' | null;
  /** False when the live model list could not be read. */
  listKnown: boolean;
  /** Whether the configured model appears in the live list; null when unknown. */
  presentInList: boolean | null;
  /** A few live model ids, for a helpful "did you mean" message. */
  sampleModels: string[];
  detail: string;
}

export interface ProviderIncident {
  title: string;
  impact: string;
  url?: string;
}

export interface ProviderStatusReport {
  provider: LlmProviderId;
  /** False when the status API is absent, unreachable, or unparseable. */
  known: boolean;
  ongoingIncidents: ProviderIncident[];
  detail: string;
}

export interface LlmProviderBackend extends ExecutionBackend {
  /** Which provider this backend instance checks. */
  getProviderId(): LlmProviderId;

  /** Is an API key present in the process environment? (Works offline.) */
  checkKeyPresence(): Promise<KeyPresence>;

  /** Does a cheap authenticated call succeed, and if not, why? */
  checkKeyValidity(): Promise<KeyValidity>;

  /** Remaining request/token headroom from the provider's ratelimit signals. */
  checkRateLimitHeadroom(): Promise<RateLimitHeadroom>;

  /** Does the configured model id still appear in the live model list? */
  checkModel(): Promise<ModelCheck>;

  /** Ongoing incidents from the provider's status API. */
  checkProviderStatus(): Promise<ProviderStatusReport>;
}
