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
  ProviderIncident,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';

/** Page cap for a paginated models-list fetch (Google's nextPageToken). */
const MAX_MODEL_LIST_PAGES = 3;

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

function headerNumber(headers: Record<string, string>, name: string): number | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** remaining/limit as a 0-100 percentage, or null when either is unusable. */
function percentage(remaining: number | null, limit: number | null): number | null {
  if (remaining === null || limit === null || limit <= 0) return null;
  return Math.round((remaining / limit) * 100);
}

/**
 * Read request/token headroom from a provider's ratelimit response headers.
 *
 * Providers name these differently on each side of the prefix
 * (`anthropic-ratelimit-requests-remaining` vs `x-ratelimit-remaining-requests`),
 * so both orders are tried. A provider that omits them yields nulls — the
 * caller reports that as unknown, never as zero headroom.
 */
export function parseHeadroomFromHeaders(
  headers: Record<string, string>,
  prefix: string,
): { requestsRemainingPct: number | null; tokensRemainingPct: number | null } {
  const pair = (unit: string): { remaining: number | null; limit: number | null } => ({
    remaining: headerNumber(headers, `${prefix}${unit}-remaining`) ?? headerNumber(headers, `${prefix}remaining-${unit}`),
    limit: headerNumber(headers, `${prefix}${unit}-limit`) ?? headerNumber(headers, `${prefix}limit-${unit}`),
  });

  const requests = pair('requests');
  const tokens = pair('tokens');
  const inputTokens = pair('input-tokens');

  return {
    requestsRemainingPct: percentage(requests.remaining, requests.limit),
    tokensRemainingPct:
      percentage(tokens.remaining, tokens.limit) ?? percentage(inputTokens.remaining, inputTokens.limit),
  };
}

/** Pull model ids out of a models-list body, per the provider's response shape. */
export function extractModelIds(body: unknown, shape: 'data_id' | 'models_name'): string[] {
  if (typeof body !== 'object' || body === null) return [];
  if (shape === 'data_id') {
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  }
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.replace(/^models\//, ''));
}

/** Statuspage v2 summary: unresolved entries in `incidents[]`. */
function parseStatuspageIncidents(body: unknown): ProviderIncident[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const incidents = (body as { incidents?: unknown }).incidents;
  if (!Array.isArray(incidents)) return null;
  return incidents
    .filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null)
    .filter((raw) => raw.status !== 'resolved' && raw.status !== 'postmortem')
    .map((raw) => ({
      title: typeof raw.name === 'string' ? raw.name : 'unnamed incident',
      impact: typeof raw.impact === 'string' ? raw.impact : 'unknown',
      ...(typeof raw.shortlink === 'string' ? { url: raw.shortlink } : {}),
    }));
}

/** Google Cloud incidents.json: entries without an `end` timestamp are ongoing. */
function parseGoogleCloudIncidents(body: unknown): ProviderIncident[] | null {
  if (!Array.isArray(body)) return null;
  return body
    .filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null)
    .filter((raw) => raw.end === undefined || raw.end === null)
    .filter((raw) => typeof raw.service_name === 'string' && /gemini|generative|vertex ai/i.test(raw.service_name))
    .map((raw) => ({
      title: typeof raw.external_desc === 'string' ? raw.external_desc : 'unnamed incident',
      impact: typeof raw.severity === 'string' ? raw.severity : 'unknown',
      ...(typeof raw.uri === 'string' ? { url: `https://status.cloud.google.com/${raw.uri}` } : {}),
    }));
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

  /** OpenRouter reports credit, not request headroom — read it from the key-info body. */
  private openRouterCredit(body: unknown): { limit: number | null; remaining: number | null } {
    if (typeof body !== 'object' || body === null) return { limit: null, remaining: null };
    const data = (body as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) return { limit: null, remaining: null };
    const d = data as { limit?: unknown; limit_remaining?: unknown };
    return {
      limit: typeof d.limit === 'number' ? d.limit : null,
      remaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
    };
  }

  async checkRateLimitHeadroom(): Promise<RateLimitHeadroom> {
    const unknown = (detail: string): RateLimitHeadroom => ({
      provider: this.spec.id,
      known: false,
      requestsRemainingPct: null,
      tokensRemainingPct: null,
      detail,
    });

    if (this.config.apiKey === '') {
      return unknown(`No ${this.spec.label} API key, so no authenticated response to read rate-limit signals from.`);
    }

    const probe = await this.probeAuth();
    if (probe.networkError !== null || probe.httpStatus === null) {
      return unknown(`${this.spec.apiHost} could not be reached, so rate-limit headroom is unknown.`);
    }

    if (this.spec.id === 'openrouter') {
      const { limit, remaining } = this.openRouterCredit(probe.body);
      const pct = percentage(remaining, limit);
      if (pct === null) {
        return unknown(`This ${this.spec.label} key has no credit limit set, so there is no headroom percentage to report.`);
      }
      return {
        provider: this.spec.id,
        known: true,
        requestsRemainingPct: pct,
        tokensRemainingPct: null,
        detail: `${this.spec.label} credit headroom: ${pct}% of the key's credit limit remains.`,
      };
    }

    if (!this.spec.rateLimitHeaderPrefix) {
      return unknown(`${this.spec.label} does not publish rate-limit response headers — headroom is unknown, not zero.`);
    }

    const { requestsRemainingPct, tokensRemainingPct } = parseHeadroomFromHeaders(
      probe.headers,
      this.spec.rateLimitHeaderPrefix,
    );
    if (requestsRemainingPct === null && tokensRemainingPct === null) {
      return unknown(
        `${this.spec.label} returned no rate-limit headers on this endpoint — headroom is unknown. CrisisMode will not send a billable request just to read them.`,
      );
    }

    const parts: string[] = [];
    if (requestsRemainingPct !== null) parts.push(`${requestsRemainingPct}% of requests`);
    if (tokensRemainingPct !== null) parts.push(`${tokensRemainingPct}% of tokens`);
    const low = (requestsRemainingPct ?? 100) < 20 || (tokensRemainingPct ?? 100) < 20;

    return {
      provider: this.spec.id,
      known: true,
      requestsRemainingPct,
      tokensRemainingPct,
      detail: low
        ? `${this.spec.label} rate-limit headroom is low: ${parts.join(' and ')} remain — requests may start failing.`
        : `${this.spec.label} rate-limit headroom: ${parts.join(' and ')} remain.`,
    };
  }

  /**
   * The models list, following pagination when the provider's spec declares
   * it (`paginated: true` — Google today). Unpaginated providers keep the
   * original behavior: reuse the auth probe's own body when the provider
   * authenticates via the models endpoint itself (no separate `keyInfoUrl`),
   * so `checkKeyValidity()` and `checkModel()` share one request; providers
   * with a `keyInfoUrl` (OpenRouter) fetch the models list separately.
   * Paginated providers always fetch their own page sequence — the
   * `pageSize=1000` query string has nothing in common with the auth probe's
   * URL, so there is no request to share regardless.
   */
  private async fetchModelList(): Promise<ModelListFetch> {
    if (!this.spec.paginated) {
      if (!this.spec.keyInfoUrl) {
        const probe = await this.probeAuth();
        return { pages: [probe], truncated: false };
      }
      this.modelListFetch ??= (async () => ({
        pages: [await this.get(this.spec.modelsUrl, this.authHeaders())],
        truncated: false,
      }))();
      return this.modelListFetch;
    }

    this.modelListFetch ??= (async () => {
      const pages: HttpProbe[] = [];
      let url = `${this.spec.modelsUrl}?pageSize=1000`;
      let truncated = false;
      for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
        const probe = await this.get(url, this.authHeaders());
        pages.push(probe);
        if (probe.networkError !== null || probe.httpStatus === null || probe.httpStatus >= 300) break;
        const nextPageToken = (probe.body as { nextPageToken?: unknown } | null)?.nextPageToken;
        if (typeof nextPageToken !== 'string' || nextPageToken === '') break;
        if (page === MAX_MODEL_LIST_PAGES - 1) {
          truncated = true;
          break;
        }
        url = `${this.spec.modelsUrl}?pageSize=1000&pageToken=${encodeURIComponent(nextPageToken)}`;
      }
      return { pages, truncated };
    })();
    return this.modelListFetch;
  }

  async checkModel(): Promise<ModelCheck> {
    const configured = this.config.configuredModel
      ? { model: this.config.configuredModel, source: 'config' as const }
      : (() => {
          const envVar = this.spec.modelEnvVars.find((name) => (this.env[name] ?? '') !== '');
          return envVar ? { model: this.env[envVar]!, source: 'env' as const } : null;
        })();

    const base = {
      provider: this.spec.id,
      configuredModel: configured?.model ?? null,
      source: configured?.source ?? null,
    };

    if (this.config.apiKey === '') {
      return { ...base, listKnown: false, presentInList: null, sampleModels: [], detail: `No ${this.spec.label} API key, so the live model list could not be read.` };
    }

    const { pages, truncated } = await this.fetchModelList();

    // "Could not read the list" and "the list is empty" are different facts.
    // Only the first is an unknown; the second definitively answers whether a
    // configured model is present (it is not). A failed page anywhere in a
    // paginated fetch means the list is incomplete, so it gets the same
    // unknown treatment as a single unreadable page — the configured model
    // might live on a page that was never successfully fetched.
    const failedPage = pages.find((p) => p.networkError !== null || p.httpStatus === null || p.httpStatus >= 300);
    if (failedPage) {
      return {
        ...base,
        listKnown: false,
        presentInList: null,
        sampleModels: [],
        detail: `${this.spec.label}'s model list could not be read (${failedPage.networkError ?? `HTTP ${failedPage.httpStatus}`}), so the configured model could not be verified.`,
      };
    }

    const models = pages.flatMap((p) => extractModelIds(p.body, this.spec.modelsJsonShape));

    // Every fetched page read fine, but the provider says there are more
    // pages than MAX_MODEL_LIST_PAGES follows. A hit within what was already
    // fetched is still a definitive presence regardless of truncation — only
    // the "not present" conclusion is unsafe to draw from a partial list, and
    // only when a model is actually configured to check against.
    if (configured && truncated && !models.includes(configured.model)) {
      return {
        ...base,
        listKnown: false,
        presentInList: null,
        sampleModels: models.slice(0, 5),
        detail: `${this.spec.label}'s model list has more pages than this check follows (checked ${pages.length}), so the configured model could not be conclusively verified.`,
      };
    }

    if (models.length === 0) {
      return {
        ...base,
        listKnown: true,
        presentInList: configured ? false : null,
        sampleModels: [],
        detail: configured
          ? `${this.spec.label} returned an empty model list, so the configured model '${configured.model}' is not available to this key. This usually means the key has no model access granted.`
          : `${this.spec.label} returned an empty model list and no model id is configured — nothing to verify.`,
      };
    }

    if (!configured) {
      return {
        ...base,
        listKnown: true,
        presentInList: null,
        sampleModels: models.slice(0, 5),
        detail: `${this.spec.label} lists ${models.length} models, but no model id is configured (set ${this.spec.modelEnvVars[0]} or targets[].llm.model) — nothing to verify.`,
      };
    }

    const present = models.includes(configured.model);
    return {
      ...base,
      listKnown: true,
      presentInList: present,
      sampleModels: models.slice(0, 5),
      detail: present
        ? `The configured model '${configured.model}' is available on ${this.spec.label}.`
        : `The configured model '${configured.model}' is not in ${this.spec.label}'s live model list — this is a config mismatch and requests naming it will fail. Currently available: ${models.slice(0, 5).join(', ')}.`,
    };
  }

  async checkProviderStatus(): Promise<ProviderStatusReport> {
    const unknown = (detail: string): ProviderStatusReport => ({
      provider: this.spec.id,
      known: false,
      ongoingIncidents: [],
      detail,
    });

    if (!this.spec.statusUrl || !this.spec.statusFormat) {
      return unknown(`${this.spec.label} publishes no status API CrisisMode can read.`);
    }

    this.statusProbe ??= this.get(this.spec.statusUrl, {});
    const probe = await this.statusProbe;

    if (probe.networkError !== null || probe.httpStatus === null || probe.httpStatus >= 300) {
      return unknown(`${this.spec.label}'s status page could not be read (${probe.networkError ?? `HTTP ${probe.httpStatus}`}) — provider status is unknown.`);
    }

    const incidents =
      this.spec.statusFormat === 'statuspage_v2'
        ? parseStatuspageIncidents(probe.body)
        : parseGoogleCloudIncidents(probe.body);

    if (incidents === null) {
      return unknown(`${this.spec.label}'s status page returned a shape CrisisMode does not recognise — provider status is unknown.`);
    }

    return {
      provider: this.spec.id,
      known: true,
      ongoingIncidents: incidents,
      detail:
        incidents.length === 0
          ? `${this.spec.label} reports no ongoing incidents.`
          : `${this.spec.label} reports ${incidents.length} ongoing incident${incidents.length === 1 ? '' : 's'}: ${incidents.map((i) => `${i.title} (${i.impact})`).join('; ')}.`,
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
