// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * LlmProviderLiveClient — read-only checks against one real LLM provider.
 *
 * Cost and blast radius are deliberate constraints:
 * - Only free metadata endpoints are called (models list, key info, status
 *   summary). No completion or message request is ever sent, so running
 *   CrisisMode never costs the user money.
 * - The authenticated probe is made once per client instance and cached, so
 *   five of the six checks share a single HTTP request.
 *
 * SECURITY: the API key is held in memory to build the auth header and is
 * never placed in a return value, error message, or log line. Output refers to
 * the key by last-4 fingerprint only.
 */

import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import {
  fingerprintKey,
  getProviderSpec,
  type LlmProviderId,
  type LlmProviderSpec,
} from './provider-table.js';
import { LLM_PROVIDER_MATURITY } from './manifest.js';
import type {
  KeyFailureKind,
  KeyPresence,
  KeyValidity,
  LlmProviderBackend,
  ModelCheck,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';

export interface LlmProviderLiveConfig {
  provider: LlmProviderId;
  /** The API key. Empty string means "no key configured". */
  apiKey: string;
  /** Model id from crisismode.yaml (targets[].llm.model), if declared. */
  configuredModel?: string | undefined;
  /** Environment to read model env vars and key-presence names from. */
  env?: NodeJS.ProcessEnv;
  /**
   * Per-request timeout in ms (default 1500).
   *
   * Scan gives each agent 2000ms (AGENT_TIMEOUT_MS in src/cli/commands/scan.ts)
   * and on timeout substitutes a canned assessment with `signals: []` — which
   * would erase every checkId and, with it, the operator guidance keyed on
   * them. All network checks run concurrently, so the budget is one request
   * plus overhead, not four.
   */
  timeoutMs?: number;
}

/** Default per-request timeout: fits inside scan's 2000ms per-agent budget. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 1500;

interface HttpProbe {
  httpStatus: number | null;
  /** Lowercased response header names. Empty when no response arrived. */
  headers: Record<string, string>;
  body: unknown;
  /** Set when no HTTP response arrived at all. */
  networkError: string | null;
}

/** Aggregate result of fetching a (possibly paginated) models list. */
interface ModelListFetch {
  /** Every page fetched, in order — one entry for an unpaginated provider. */
  pages: HttpProbe[];
  /** True when a `nextPageToken` was still present after the page cap Task 8 defines — the list may be incomplete. */
  truncated: boolean;
}

/** Read `{ error: { type | code | status, message } }` across all four providers. */
export function extractErrorInfo(body: unknown): { type?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return {};
  const e = error as { type?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const candidates = [e.code, e.type, e.status];
  const type = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
  const message = typeof e.message === 'string' ? e.message : undefined;
  return {
    ...(type !== undefined ? { type } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

const BILLING_MARKERS = /credit|billing|payment|insufficient[ _]?quota|exceeded your current quota|out of quota/i;
const KEY_MARKERS = /api[ _-]?key|api_key_invalid|invalid[ _]x-api-key|unauthorized/i;

/**
 * Map an unsuccessful authenticated response to a cause. Deliberately
 * conservative: anything that does not clearly match a known taxonomy is
 * 'other', which the agent renders as an honest unknown.
 */
export function classifyAuthFailure(
  httpStatus: number,
  errorType: string | undefined,
  message: string | undefined,
): KeyFailureKind {
  const type = errorType ?? '';
  const text = `${type} ${message ?? ''}`;

  if (httpStatus === 401) return 'invalid_key';

  if (httpStatus === 403) {
    if (/billing/i.test(type) || BILLING_MARKERS.test(text)) return 'billing_or_quota';
    return 'permission';
  }

  if (httpStatus === 429) {
    if (BILLING_MARKERS.test(text)) return 'billing_or_quota';
    return 'rate_limited';
  }

  if (httpStatus === 400) {
    if (BILLING_MARKERS.test(text)) return 'billing_or_quota';
    if (KEY_MARKERS.test(text)) return 'invalid_key';
  }

  return 'other';
}

export class LlmProviderLiveClient implements LlmProviderBackend {
  private readonly spec: LlmProviderSpec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  /** One authenticated request per instance, shared by every check. */
  private authProbe: Promise<HttpProbe> | null = null;
  private modelListFetch: Promise<ModelListFetch> | null = null;
  private statusProbe: Promise<HttpProbe> | null = null;

  constructor(private readonly config: LlmProviderLiveConfig) {
    const spec = getProviderSpec(config.provider);
    if (!spec) throw new Error(`Unknown LLM provider "${config.provider}"`);
    this.spec = spec;
    this.env = config.env ?? process.env;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }

  getProviderId(): LlmProviderId {
    return this.spec.id;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.spec.extraHeaders };
    headers[this.spec.authHeader] = this.spec.authPrefix
      ? `${this.spec.authPrefix} ${this.config.apiKey}`
      : this.config.apiKey;
    return headers;
  }

  /**
   * GET a URL and normalise everything — including failures — into data.
   * SECURITY: the caught error message is provider/network text; the key is
   * never interpolated into a URL, so it cannot appear here.
   */
  private async get(url: string, headers: Record<string, string>): Promise<HttpProbe> {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      const raw = await response.text();
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
      });
      return { httpStatus: response.status, headers: responseHeaders, body, networkError: null };
    } catch (err) {
      return {
        httpStatus: null,
        headers: {},
        body: null,
        networkError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** The single authenticated probe: key-info endpoint when the provider has one, models list otherwise. */
  private probeAuth(): Promise<HttpProbe> {
    this.authProbe ??= this.get(this.spec.keyInfoUrl ?? this.spec.modelsUrl, this.authHeaders());
    return this.authProbe;
  }

  async checkKeyPresence(): Promise<KeyPresence> {
    const checkedEnvVars = this.spec.envVars;
    if (this.config.apiKey === '') {
      return { provider: this.spec.id, present: false, envVar: null, fingerprint: null, checkedEnvVars };
    }
    const envVar = checkedEnvVars.find((name) => this.env[name] === this.config.apiKey) ?? checkedEnvVars[0]!;
    return {
      provider: this.spec.id,
      present: true,
      envVar,
      fingerprint: fingerprintKey(this.config.apiKey),
      checkedEnvVars,
    };
  }

  async checkKeyValidity(): Promise<KeyValidity> {
    if (this.config.apiKey === '') {
      return {
        provider: this.spec.id,
        outcome: 'unknown',
        httpStatus: null,
        detail: `No ${this.spec.label} API key to test.`,
      };
    }

    const probe = await this.probeAuth();

    if (probe.networkError !== null || probe.httpStatus === null) {
      return {
        provider: this.spec.id,
        outcome: 'unknown',
        httpStatus: null,
        detail: `${this.spec.apiHost} could not be reached (${probe.networkError ?? 'no response'}) — this says nothing about ${this.spec.label}'s health, only that this machine could not complete the request.`,
      };
    }

    if (probe.httpStatus >= 200 && probe.httpStatus < 300) {
      return {
        provider: this.spec.id,
        outcome: 'valid',
        httpStatus: probe.httpStatus,
        detail: `${this.spec.label} accepted the API key (HTTP ${probe.httpStatus}).`,
      };
    }

    const { type, message } = extractErrorInfo(probe.body);
    const kind = classifyAuthFailure(probe.httpStatus, type, message);
    const suffix = type ? ` ${type}` : '';

    const detail: Record<KeyFailureKind, string> = {
      invalid_key: `${this.spec.label} rejected the API key (HTTP ${probe.httpStatus}${suffix}) — every AI request is failing.`,
      billing_or_quota: `${this.spec.label} refused the request for quota or billing reasons (HTTP ${probe.httpStatus}${suffix}) — requests are failing until the account is topped up.`,
      rate_limited: `${this.spec.label} is rate limiting this key right now (HTTP ${probe.httpStatus}${suffix}) — the key itself is fine.`,
      permission: `The ${this.spec.label} key authenticated but is not permitted to use this endpoint (HTTP ${probe.httpStatus}${suffix}) — requests are failing.`,
      other: `${this.spec.label} returned HTTP ${probe.httpStatus}${suffix}, which CrisisMode cannot classify — treat this as unknown, not as a diagnosis.`,
    };

    return {
      provider: this.spec.id,
      outcome: kind === 'other' ? 'unknown' : kind,
      httpStatus: probe.httpStatus,
      detail: detail[kind],
    };
  }

  // ── Task 8 implements these three ──

  async checkRateLimitHeadroom(): Promise<RateLimitHeadroom> {
    return {
      provider: this.spec.id,
      known: false,
      requestsRemainingPct: null,
      tokensRemainingPct: null,
      detail: 'Rate-limit headroom reading is not implemented yet.',
    };
  }

  async checkModel(): Promise<ModelCheck> {
    return {
      provider: this.spec.id,
      configuredModel: null,
      source: null,
      listKnown: false,
      presentInList: null,
      sampleModels: [],
      detail: 'Model verification is not implemented yet.',
    };
  }

  async checkProviderStatus(): Promise<ProviderStatusReport> {
    return {
      provider: this.spec.id,
      known: false,
      ongoingIncidents: [],
      detail: 'Provider status reading is not implemented yet.',
    };
  }

  // ── ExecutionBackend ──

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported llm-provider live client command type: ${command.type}`);
    }
    if (command.operation !== 'llm_provider_check') {
      throw new Error(`Unknown llm-provider operation: ${command.operation}`);
    }
    return {
      keyPresence: await this.checkKeyPresence(),
      keyValidity: await this.checkKeyValidity(),
      rateLimitHeadroom: await this.checkRateLimitHeadroom(),
      model: await this.checkModel(),
      providerStatus: await this.checkProviderStatus(),
    };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'llm_key_valid') {
      const validity = await this.checkKeyValidity();
      return compareCheckValue(validity.outcome === 'valid' ? 'ok' : 'fail', check.expect.operator, check.expect.value);
    }
    if (stmt === 'llm_rate_limit_remaining_pct') {
      const headroom = await this.checkRateLimitHeadroom();
      return compareCheckValue(headroom.requestsRemainingPct ?? 0, check.expect.operator, check.expect.value);
    }
    if (stmt === 'llm_provider_incidents') {
      const status = await this.checkProviderStatus();
      return compareCheckValue(status.ongoingIncidents.length, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    // This instance is bound to one provider (this.spec.id), so its descriptor
    // names that provider's own kind and maturity — never the generic
    // 'llm-provider' family, and never another provider's maturity.
    return [
      {
        id: `llm-provider-${this.spec.id}-live-read`,
        kind: 'capability_provider',
        name: `${this.spec.label} Live Read Provider`,
        maturity: LLM_PROVIDER_MATURITY[this.spec.id],
        capabilities: ['llm.provider.key.verify', 'llm.provider.status.read'],
        executionContexts: ['llm_read'],
        targetKinds: [`llm-provider.${this.spec.id}`],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    // No persistent connections to clean up.
  }
}
