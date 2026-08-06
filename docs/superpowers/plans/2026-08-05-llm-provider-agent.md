# LLM Provider Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a diagnosis-only `llm-provider` recovery agent that live-checks the AI provider layer (key present, key valid, quota/billing, rate-limit headroom, model deprecation, provider status) for Anthropic, OpenAI, Google Gemini, and OpenRouter — and hand it the env-key-derived autodiscovery role currently held by `ai-provider`.

**Architecture:** Standard CrisisMode agent layout under `src/agent/llm-provider/` (backend contract → provider table → simulator → live client → manifest → agent → registration). A single static provider table drives every provider-specific detail and becomes the one source of truth for AI env vars across the repo. The live client uses raw `fetch` against free metadata endpoints only (models list / key-info / status page) — never a billable inference call — and caches one authenticated probe per instance so five of the six checks cost at most one HTTP request. Every check degrades to an honest `unknown` with a reason rather than guessing, and when PR 2's triage says the observer is offline the network checks are skipped with that explanation instead of reporting providers down.

**Tech Stack:** TypeScript 7 (strict, ESM/NodeNext), Node ≥22 global `fetch`, vitest, pnpm workspaces. Zero new runtime dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

- **Kind:** four provider-scoped kinds — `llm-provider.anthropic`, `llm-provider.openai`, `llm-provider.google`, `llm-provider.openrouter` — one registration per kind, all sharing one `agent.ts` / `backend.ts` / `live-client.ts` implementation parameterized by provider id. There is no blanket `llm-provider` kind. This is load-bearing, not cosmetic: maturity in this codebase is a property of a whole registration (`buildMaturityByKind` keys by the registration's `kind`, taking the *weakest* value when several registrations share a kind), so a single shared kind would either misreport Google/OpenRouter as `live_validated` or drag Anthropic/OpenAI down to `simulator_only`. Per-provider kinds give each provider its own maturity bucket using the existing kind-keyed machinery — see the design doc's "Maturity claim" section. **Agent name (all four):** `llm-provider-diagnosis`. **Manifest maturity (per kind):** `live_validated` for `llm-provider.anthropic` and `llm-provider.openai`; `simulator_only` for `llm-provider.google` and `llm-provider.openrouter`. **maxRiskLevel:** `routine` for all four.
- **Six check ids, exact strings:** `llm-provider.key_present`, `llm-provider.key_valid`, `llm-provider.quota_billing`, `llm-provider.rate_limit_headroom`, `llm-provider.model_deprecated`, `llm-provider.provider_status`. **Canonical series ruling:** they live in a keyed `as const` object named `LLM_PROVIDER_CHECK_IDS` in its own dependency-free file, `src/agent/llm-provider/check-ids.ts`, and are re-exported from `backend.ts` for in-agent use. PR 5 imports from `check-ids.js` and enumerates with `Object.values(LLM_PROVIDER_CHECK_IDS)` — keep the keyed object shape, do not convert it to an array.
- **`checkId` is a NEW optional field** on `HealthSignal` and `DiagnosisFinding` (agent-sdk) and on `ScanFinding` (`src/cli/output.ts`). Optional so no existing agent is affected. PR 5 keys its scan-path guidance on the `HealthSignal`/`ScanFinding` id and its diagnose-path guidance purely on the `DiagnosisFinding` id, so **every signal and every diagnosis finding this agent emits must carry one**.
- **Stay inside scan's per-agent budget.** `AGENT_TIMEOUT_MS` in `src/cli/commands/scan.ts:51` is 2000ms, and a timeout substitutes a canned assessment with `signals: []` — which silently destroys every `checkId` and with it PR 5's guidance. The live client's per-request timeout therefore defaults to **1500ms** and registration sets it explicitly. All network checks run concurrently, so wall time is one request, not four.
- **Providers (v1):** anthropic, openai, google, openrouter. Google's key env vars are `GOOGLE_AI_API_KEY` (existing convention), `GEMINI_API_KEY`, `GOOGLE_API_KEY`, in that priority order.
- **`src/agent/llm-provider/provider-table.ts` is the single source of truth for AI env vars.** `src/agent/ai-provider/provider-table.ts` re-exports `AI_ENV_VARS` from it; `src/cli/autodiscovery.ts` imports it from there too.
- **Autodiscovery derives one target per detected provider, of kind `llm-provider.<provider>`.** No blanket `llm-provider` kind and no `derived-ai-provider` target. The `derived-ai-provider` derivation is REMOVED. `ai-provider` stays registered in `builtin-agents.ts` for explicitly configured targets and demo mode only.
- **`process.env` only.** Never read, parse, or stat `.env`, `.env.local`, or any secrets file. If a key is absent from the process environment, say so and name the no-`.env`-parsing rule in the user-facing text.
- **Key secrecy:** key material never appears in output, logs, plans, findings, forensics, target names, or notes. Keys are referenced by provider name plus a last-4 fingerprint (`fingerprintKey`). Task 7 contains the enforcing no-leak test.
- **No provider SDKs, no new dependencies.** Raw `fetch` only. Do not add anything to `package.json`.
- **No billable calls.** Only free metadata endpoints (models list, key-info, status summary). Never POST a completion/message.
- **Honest degradation:** a network error, an unparseable body, or a provider that does not expose a signal produces `unknown` with the reason — never a guess and never a "provider is down" claim. Only an authenticated HTTP response with an auth/billing/quota status makes a finding critical.
- **TypeScript:** strict mode, ESM with NodeNext resolution — **every relative import ends in `.js`**. Named exports only, no default exports. `import type { ... }` for type-only imports. Every new file starts with the two-line SPDX header used across the repo:
  ```ts
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **TDD:** write the failing test, run it and see it fail, write the minimal implementation, run it and see it pass, then commit. Do not write implementation before its test.
- **Commands:** single file — `pnpm vitest run src/__tests__/<file>.test.ts`; full suite — `pnpm test`; types — `pnpm run typecheck` (this also rebuilds the agent-sdk `dist/`); lint — `pnpm run lint`.
- **Commits:** Conventional Commits, scope `llm-provider` for agent work (`feat(llm-provider): ...`), the touched area's scope for wiring (`feat(cli): ...`, `feat(sdk): ...`). Never pass `--no-verify`. **Do not create a branch** — work on the current branch.
- **PR 1 and PR 2 are merged before this work starts.** From PR 1 you inherit the maturity/visibility machinery (`metadata.plugin.maturity` surfaced in `buildVisibilityReport`) — declaring `live_validated` in the manifest is all this agent needs to land in the validated bucket. From PR 2 you inherit `src/framework/triage.ts`.
- **Triage integration:** exactly one file — `src/agent/llm-provider/offline-gate.ts` — imports from `src/framework/triage.js`. PR 2 pins the contract this agent consumes: `export function getTriageReport(): TriageReport | null` (the process-lifetime report cache, populated by `runTriage()` which scan runs as step 0), where `TriageReport` carries `verdict: TriageVerdict` (`'local' | 'network' | 'remote' | 'mixed' | 'healthy'`), `explanation: string`, and `nextStep: string`. Also available: `resetTriageReport(): void` for test cleanup. **Task 5, Step 1 verifies those names against the merged module before anything depends on them.** Nothing else in the agent depends on triage's shape — the rest of the code consumes the local `OfflineGate` type defined in that file.
- **Three triage rules that are easy to get wrong, and are each pinned by a test in Task 5:**
  1. **Never call `runTriage()` from `assessHealth`.** It runs live probes (~5s) and scan calls `assessHealth` once per target, so that would multiply triage's cost by the number of targets. Only the cached `getTriageReport()` accessor is allowed.
  2. **`null` means "no information", not "offline".** `crisismode diagnose` never populates the cache. On `null` the provider checks run normally.
  3. **`mixed` is not a skip signal.** It means triage could not localise the failure; deferring to it would be a guess, which is the opposite of what this series is for. Only `local` and `network` defer.

## File Structure

**New — the agent (`src/agent/llm-provider/`):**

| File | Responsibility |
|---|---|
| `provider-table.ts` | Static per-provider config (env vars, endpoints, auth, header prefixes, status API). Source of truth for `AI_ENV_VARS` and for what counts as a configured key. Key fingerprinting. |
| `check-ids.ts` | `LLM_PROVIDER_CHECK_IDS` and `LlmProviderCheckId`, alone in a dependency-free file so PR 5's guidance registry can import them without pulling in the agent. |
| `backend.ts` | `LlmProviderBackend` contract and per-check result types; re-exports the check ids. |
| `simulator.ts` | In-memory scenarios: healthy, no_key, bad_key, quota_exhausted, rate_limited, deprecated_model, provider_incident. |
| `live-client.ts` | `fetch`-based implementation: one cached auth probe + one status fetch, error classification, ratelimit header parsing, model list comparison. |
| `offline-gate.ts` | The single seam onto PR 2's triage verdict. |
| `manifest.ts` | `buildLlmProviderManifest(providerId)` factory + one exported `AgentManifest` per provider (`anthropicManifest`, `openaiManifest`, `googleManifest`, `openrouterManifest`, plus a `llmProviderManifests` map), each `routine`, read-only, with its own per-provider maturity. |
| `agent.ts` | `LlmProviderDiagnosisAgent` — `assessHealth`, `diagnose`, `plan`, `replan`; parameterized by provider id (derived from its backend's `getProviderId()`). |
| `registration.ts` | `buildLlmProviderRegistration(providerId)` factory via `createLiveRegistration`, one call per provider — four registrations, one per `llm-provider.<provider>` kind. |

**Modified:**

| File | Change |
|---|---|
| `packages/agent-sdk/src/types/health.ts` | `HealthSignal.checkId?: string` |
| `packages/agent-sdk/src/types/diagnosis-result.ts` | `DiagnosisFinding.checkId?: string` |
| `src/cli/visibility.ts` | No source change — per-provider kinds already produce one watching row per kind; a regression test confirms it |
| `src/framework/capability-registry.ts` | Two read capabilities, each declaring `targetKinds` for all four `llm-provider.<provider>` kinds |
| `src/framework/signal-explanations.ts` | Two `EXPLANATIONS` entries for `llm_*` sources |
| `src/config/builtin-agents.ts` | Register all four `llmProviderRegistrations` (one per provider kind) |
| `src/config/schema.ts` | `LlmTargetOptions` + `TargetConfig.llm` + `ResolvedTarget.llm` |
| `src/config/resolve.ts` | Pass `llm` through |
| `src/cli/errors.ts` | Add the four `llm-provider.<provider>` kinds to `SUPPORTED_KINDS` |
| `src/cli/commands/scan.ts` | `KIND_PREFIX` (four entries, all `'LLM'`), `checkId` on findings, `aiKeyBlockedEntries` |
| `src/cli/output.ts` | `ScanFinding.checkId?`, signal `checkId?` |
| `src/cli/autodiscovery.ts` | Per-provider `llm-provider.<provider>` derivation; remove `derived-ai-provider`; dedupe `detectAiProviders`; new AI SDK deps |
| `src/agent/ai-provider/provider-table.ts` | Re-export `AI_ENV_VARS` from the llm-provider table |
| `README.md`, `CLAUDE.md` | Agent tables |

**Tests (all under `src/__tests__/`):** `llm-provider-table.test.ts`, `llm-provider-backend.test.ts`, `llm-provider-simulator.test.ts`, `llm-provider-offline-gate.test.ts`, `llm-provider-agent.test.ts`, `llm-provider-plan.test.ts`, `llm-provider-live-client.test.ts`, `llm-provider-live-client-checks.test.ts`, `llm-provider-registration.test.ts`, `llm-provider-secrecy.test.ts`, `scan-check-id.test.ts`, `scan-ai-key-visibility.test.ts`. Modified: `ai-provider-table.test.ts`, `autodiscovery-gated-targets.test.ts`, `autodiscovery.test.ts`, `explanation-coverage.test.ts`, `cli-output.test.ts`.

---

### Task 1: Provider table — the single source of truth

**Files:**
- Create: `src/agent/llm-provider/provider-table.ts`
- Test: `src/__tests__/llm-provider-table.test.ts`

**Interfaces:**
- Consumes: nothing (new leaf module, no imports outside the file).
- Produces:
  - `interface LlmProviderSpec` with fields `id`, `label`, `envVars: string[]`, `modelEnvVars: string[]`, `apiHost`, `modelsUrl`, `keyInfoUrl?`, `modelsJsonShape: 'data_id' | 'models_name'`, `paginated?: boolean`, `authHeader`, `authPrefix`, `extraHeaders`, `rateLimitHeaderPrefix?`, `statusUrl?`, `statusFormat?: 'statuspage_v2' | 'google_cloud_incidents'`, `docsUrl`
  - `const LLM_PROVIDERS: LlmProviderSpec[]`
  - `type LlmProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter'`
  - `function getProviderSpec(id: string): LlmProviderSpec | undefined`
  - `const LEGACY_AI_ENV_VARS: Array<{ envVar: string; provider: string }>`
  - `const AI_ENV_VARS: Array<{ envVar: string; provider: string }>`
  - `function hasConfiguredKey(env: NodeJS.ProcessEnv, envVar: string): boolean` — the one definition of "this key is configured", used by `detectConfiguredProviders` here and by `detectAiProviders` in autodiscovery (Task 10)
  - `function detectConfiguredProviders(env: NodeJS.ProcessEnv): Array<{ provider: LlmProviderId; envVar: string; spec: LlmProviderSpec }>`
  - `function fingerprintKey(key: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-table.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  LLM_PROVIDERS,
  AI_ENV_VARS,
  LEGACY_AI_ENV_VARS,
  detectConfiguredProviders,
  fingerprintKey,
  getProviderSpec,
  hasConfiguredKey,
} from '../agent/llm-provider/provider-table.js';

describe('llm-provider table', () => {
  it('covers exactly the four v1 providers', () => {
    expect(LLM_PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'google', 'openrouter']);
  });

  it('lists google key env vars in priority order', () => {
    expect(getProviderSpec('google')!.envVars).toEqual([
      'GOOGLE_AI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
    ]);
  });

  it('keeps apiHost consistent with modelsUrl for every provider', () => {
    for (const spec of LLM_PROVIDERS) {
      expect(new URL(spec.modelsUrl).hostname, `apiHost mismatch for ${spec.id}`).toBe(spec.apiHost);
    }
  });

  it('uses https for every endpoint it will call', () => {
    for (const spec of LLM_PROVIDERS) {
      for (const url of [spec.modelsUrl, spec.keyInfoUrl, spec.statusUrl]) {
        if (url) expect(url.startsWith('https://'), `${spec.id}: ${url}`).toBe(true);
      }
    }
  });

  it('AI_ENV_VARS is the llm-provider keys followed by the preserved legacy keys', () => {
    const names = AI_ENV_VARS.map((v) => v.envVar);
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('GEMINI_API_KEY');
    expect(names).toContain('OPENROUTER_API_KEY');
    // Existing key set preserved so ai-provider's probe table keeps detecting them.
    for (const legacy of ['COHERE_API_KEY', 'MISTRAL_API_KEY', 'REPLICATE_API_TOKEN', 'HUGGINGFACE_API_KEY']) {
      expect(names).toContain(legacy);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(AI_ENV_VARS).toHaveLength(
      LLM_PROVIDERS.reduce((n, p) => n + p.envVars.length, 0) + LEGACY_AI_ENV_VARS.length,
    );
  });

  it('detects one entry per provider, honouring env var priority', () => {
    const detected = detectConfiguredProviders({
      GEMINI_API_KEY: 'g-key',
      GOOGLE_API_KEY: 'other-key',
      ANTHROPIC_API_KEY: 'sk-ant-key',
    } as NodeJS.ProcessEnv);
    expect(detected.map((d) => d.provider)).toEqual(['anthropic', 'google']);
    expect(detected.find((d) => d.provider === 'google')!.envVar).toBe('GEMINI_API_KEY');
  });

  it('ignores empty-string keys and returns nothing for an empty environment', () => {
    expect(detectConfiguredProviders({ OPENAI_API_KEY: '' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(detectConfiguredProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('treats set-but-empty and unset identically, everywhere', () => {
    // One predicate, so autodiscovery's provider detection cannot disagree
    // with target derivation about what "configured" means.
    expect(hasConfiguredKey({ OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(true);
    expect(hasConfiguredKey({ OPENAI_API_KEY: '' } as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(false);
    expect(hasConfiguredKey({} as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(false);
  });

  it('fingerprints a key to its last four characters only', () => {
    expect(fingerprintKey('sk-ant-api03-SUPERSECRET-9f3a')).toBe('…9f3a');
  });

  it('refuses to fingerprint a key too short to redact', () => {
    expect(fingerprintKey('abc')).toBe('(key too short to fingerprint)');
    expect(fingerprintKey('abc')).not.toContain('abc');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-table.test.ts`
Expected: FAIL — `Failed to resolve import "../agent/llm-provider/provider-table.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/agent/llm-provider/provider-table.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static provider table for the llm-provider agent, and the single source of
 * truth for AI provider environment variables across CrisisMode
 * (src/agent/ai-provider/provider-table.ts and src/cli/autodiscovery.ts both
 * import AI_ENV_VARS from here).
 *
 * SECURITY: this module reads key *names* from an environment object. It never
 * logs, stores, or returns key material. Output that needs to identify a key
 * uses `fingerprintKey`, which exposes the last four characters only.
 *
 * POLICY: process.env only. Nothing here reads .env files — parsing a secrets
 * file is deliberately out of scope (see the design doc's non-goals).
 */

export type LlmProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter';

export interface LlmProviderSpec {
  /** Stable id used in target names, findings, and check output. */
  id: LlmProviderId;
  /** Human label for operator-facing text. */
  label: string;
  /** Env vars carrying the API key, highest priority first. */
  envVars: string[];
  /** Env vars that may name the model the app uses, highest priority first. */
  modelEnvVars: string[];
  /** Hostname of the API — used as the derived target's primary host. */
  apiHost: string;
  /** Free, read-only models-list endpoint. */
  modelsUrl: string;
  /** Authenticated key-info endpoint, when the provider has one. */
  keyInfoUrl?: string;
  /** Shape of the models-list response body. */
  modelsJsonShape: 'data_id' | 'models_name';
  /**
   * True when the provider's models-list endpoint pages results (a
   * `nextPageToken` field means more remain). Only Google does today —
   * OpenAI, Anthropic, and OpenRouter's `/models` all return a flat list in
   * one call, so `checkModel()` fetches exactly one page for them regardless
   * of this flag. See the design doc's "Model-list extraction, normalization,
   * and pagination" section.
   */
  paginated?: boolean;
  /** Header carrying the API key. */
  authHeader: string;
  /** Prefix for the auth header value ('' means the raw key). */
  authPrefix: string;
  /** Static headers the provider requires. */
  extraHeaders: Record<string, string>;
  /** Lowercase prefix of the provider's ratelimit response headers, if any. */
  rateLimitHeaderPrefix?: string;
  /** Status API endpoint, if the provider publishes one. */
  statusUrl?: string;
  /** Response shape of `statusUrl`. */
  statusFormat?: 'statuspage_v2' | 'google_cloud_incidents';
  /** Where an operator can read more when a check fails. */
  docsUrl: string;
}

export const LLM_PROVIDERS: LlmProviderSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    modelEnvVars: ['ANTHROPIC_MODEL', 'CLAUDE_MODEL'],
    apiHost: 'api.anthropic.com',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    modelsJsonShape: 'data_id',
    authHeader: 'x-api-key',
    authPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    rateLimitHeaderPrefix: 'anthropic-ratelimit-',
    statusUrl: 'https://status.anthropic.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
    docsUrl: 'https://docs.claude.com/en/api/errors',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVars: ['OPENAI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    apiHost: 'api.openai.com',
    modelsUrl: 'https://api.openai.com/v1/models',
    modelsJsonShape: 'data_id',
    authHeader: 'Authorization',
    authPrefix: 'Bearer',
    extraHeaders: {},
    rateLimitHeaderPrefix: 'x-ratelimit-',
    statusUrl: 'https://status.openai.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
    docsUrl: 'https://platform.openai.com/docs/guides/error-codes',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVars: ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnvVars: ['GEMINI_MODEL', 'GOOGLE_MODEL'],
    apiHost: 'generativelanguage.googleapis.com',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelsJsonShape: 'models_name',
    // Google's models.list paginates (nextPageToken); see fetchModelList().
    paginated: true,
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    extraHeaders: {},
    // Gemini does not publish ratelimit response headers — the headroom check
    // reports an honest `unknown` rather than guessing.
    statusUrl: 'https://status.cloud.google.com/incidents.json',
    statusFormat: 'google_cloud_incidents',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/troubleshooting',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVars: ['OPENROUTER_API_KEY'],
    modelEnvVars: ['OPENROUTER_MODEL'],
    apiHost: 'openrouter.ai',
    // The models list is public; key validity comes from the key-info
    // endpoint. OpenRouter's current API reference documents GET /api/v1/key
    // (response: { data: { limit, limit_remaining, limit_reset, usage } });
    // /api/v1/auth/key is not a documented endpoint. Step 5's curl re-confirms
    // this against the live provider before implementation — flip this one
    // line if OpenRouter's docs have changed again by then.
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keyInfoUrl: 'https://openrouter.ai/api/v1/key',
    modelsJsonShape: 'data_id',
    authHeader: 'Authorization',
    authPrefix: 'Bearer',
    extraHeaders: {},
    statusUrl: 'https://status.openrouter.ai/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
    docsUrl: 'https://openrouter.ai/docs/api-reference/limits',
  },
];

/**
 * Provider keys CrisisMode detects but has no llm-provider checks for. They
 * stay in AI_ENV_VARS so ai-provider's probe table and autodiscovery's stack
 * profile keep recognising them (the existing key set is preserved, not
 * narrowed).
 */
export const LEGACY_AI_ENV_VARS: Array<{ envVar: string; provider: string }> = [
  { envVar: 'COHERE_API_KEY', provider: 'cohere' },
  { envVar: 'MISTRAL_API_KEY', provider: 'mistral' },
  { envVar: 'REPLICATE_API_TOKEN', provider: 'replicate' },
  { envVar: 'HUGGINGFACE_API_KEY', provider: 'huggingface' },
];

/** Env-var detection list: llm-provider keys first, then preserved legacy keys. */
export const AI_ENV_VARS: Array<{ envVar: string; provider: string }> = [
  ...LLM_PROVIDERS.flatMap((spec) => spec.envVars.map((envVar) => ({ envVar, provider: spec.id as string }))),
  ...LEGACY_AI_ENV_VARS,
];

export function getProviderSpec(id: string): LlmProviderSpec | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/**
 * Is this key configured? The single definition, used here and by
 * autodiscovery's provider detection (src/cli/autodiscovery.ts).
 *
 * A variable that is set but empty counts as NOT configured: exporting
 * `ANTHROPIC_API_KEY=` is how a shell ends up with a blank key, and treating
 * it as present would produce a live check that fails for a reason the user
 * cannot see. Both callers must agree, or a provider could be detected as
 * configured while no target is derived for it (or the reverse).
 */
export function hasConfiguredKey(env: NodeJS.ProcessEnv, envVar: string): boolean {
  return (env[envVar] ?? '') !== '';
}

/**
 * One entry per provider whose API key is present in `env`, in table order.
 * The first configured env var in a provider's list wins.
 *
 * SECURITY: returns env var NAMES, never values.
 */
export function detectConfiguredProviders(
  env: NodeJS.ProcessEnv,
): Array<{ provider: LlmProviderId; envVar: string; spec: LlmProviderSpec }> {
  const detected: Array<{ provider: LlmProviderId; envVar: string; spec: LlmProviderSpec }> = [];
  for (const spec of LLM_PROVIDERS) {
    const envVar = spec.envVars.find((name) => hasConfiguredKey(env, name));
    if (!envVar) continue;
    detected.push({ provider: spec.id, envVar, spec });
  }
  return detected;
}

/**
 * Render a key as a last-4 fingerprint for operator output. Keys shorter than
 * 8 characters are not fingerprinted at all — a 4-character suffix of a short
 * key is too much of the key.
 */
export function fingerprintKey(key: string): string {
  if (key.length < 8) return '(key too short to fingerprint)';
  return `…${key.slice(-4)}`;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run src/__tests__/llm-provider-table.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Verify the endpoints against the live providers**

The table is the only place these values live, so confirm them now rather than discovering a typo during live validation. Run each command and check the status code / body shape. Where a value differs from the table, fix the table and re-run Step 4.

**The two the design doc explicitly marked "verify" are OpenRouter's key endpoint and Gemini's models endpoint — do not skip those two even if you skip the rest.**

```bash
# Anthropic — expect 200 and JSON with a top-level "data" array of {id}.
curl -sS -D - -o /tmp/anthropic-models.json \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' \
  https://api.anthropic.com/v1/models | grep -i '^anthropic-ratelimit\|^HTTP'

# OpenAI — expect 200, "data" array of {id}, and x-ratelimit-* headers.
curl -sS -D - -o /tmp/openai-models.json \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models | grep -i '^x-ratelimit\|^HTTP'

# Gemini models ("verify" #1) — expect 200 and JSON with a "models" array of
# {name: "models/..."}. Confirms both the x-goog-api-key header and the
# models_name response shape.
curl -sS -D - -H "x-goog-api-key: $GEMINI_API_KEY" \
  https://generativelanguage.googleapis.com/v1beta/models | head -30

# OpenRouter key endpoint ("verify" #2) — the table defaults to /api/v1/key
# per OpenRouter's current API reference (/api/v1/auth/key is not a
# documented endpoint). Run both anyway: confirm /key returns 200 with a
# "data" object carrying limit / limit_remaining, and confirm /auth/key does
# NOT resolve (404 or similar) as expected. If reality disagrees with either
# expectation, fix the table (keyInfoUrl) rather than the checks.
curl -sS -w '\n/key -> %{http_code}\n' \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/key
curl -sS -o /dev/null -w '/auth/key -> %{http_code}\n' \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/auth/key

# Status endpoints — expect 200 and a Statuspage v2 summary with .incidents[].
curl -sS -o /dev/null -w '%{http_code}\n' https://status.anthropic.com/api/v2/summary.json
curl -sS -o /dev/null -w '%{http_code}\n' https://status.openai.com/api/v2/summary.json
curl -sS -o /dev/null -w '%{http_code}\n' https://status.openrouter.ai/api/v2/summary.json
curl -sS -o /dev/null -w '%{http_code}\n' https://status.cloud.google.com/incidents.json
```

Without a Google or OpenRouter key, run the two unauthenticated checks instead and record that the authenticated shape is unverified: `curl -sS -o /dev/null -w '%{http_code}\n' https://generativelanguage.googleapis.com/v1beta/models` should return 401/403 (endpoint exists, key required), and the same for both OpenRouter key paths. A 404 means the path is wrong — that is the failure this step exists to catch.

If a `statusUrl` does not return 200 with the expected shape, **delete that provider's `statusUrl`/`statusFormat` fields** rather than guessing a replacement — Task 8 already reports `unknown` with "this provider publishes no status API CrisisMode can read" when they are absent. Record what you found in the commit message.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/provider-table.ts src/__tests__/llm-provider-table.test.ts
git commit -m "feat(llm-provider): add provider table as the source of truth for AI env vars"
```

---

### Task 2: Check ids, backend contract, and `checkId` on the SDK types

**Files:**
- Create: `src/agent/llm-provider/check-ids.ts`
- Create: `src/agent/llm-provider/backend.ts`
- Modify: `packages/agent-sdk/src/types/health.ts`
- Modify: `packages/agent-sdk/src/types/diagnosis-result.ts`
- Test: `src/__tests__/llm-provider-backend.test.ts`

**Interfaces:**
- Consumes: `LlmProviderId` from `src/agent/llm-provider/provider-table.js` (Task 1); `ExecutionBackend` from `src/framework/backend.js`.
- Produces:
  - From `check-ids.ts` (imported directly by PR 5): `const LLM_PROVIDER_CHECK_IDS` — a keyed `as const` object `{ keyPresent, keyValid, quotaBilling, rateLimitHeadroom, modelDeprecated, providerStatus }` mapping to the six `llm-provider.*` strings — and `type LlmProviderCheckId`. Both re-exported from `backend.ts`.
  - `HealthSignal.checkId?: string` and `DiagnosisFinding.checkId?: string` (agent-sdk)
  - `type KeyFailureKind = 'invalid_key' | 'billing_or_quota' | 'rate_limited' | 'permission' | 'other'`
  - `interface KeyPresence { provider; present; envVar; fingerprint; checkedEnvVars }`
  - `interface KeyValidity { provider; outcome: 'valid' | KeyFailureKind | 'unknown'; httpStatus; detail }`
  - `interface RateLimitHeadroom { provider; known; requestsRemainingPct; tokensRemainingPct; detail }`
  - `interface ModelCheck { provider; configuredModel; source; listKnown; presentInList; sampleModels; detail }`
  - `interface ProviderStatusReport { provider; known; ongoingIncidents; detail }`
  - `interface LlmProviderBackend extends ExecutionBackend` with `getProviderId()`, `checkKeyPresence()`, `checkKeyValidity()`, `checkRateLimitHeadroom()`, `checkModel()`, `checkProviderStatus()`, optional `transition()`
  - `HealthSignal.checkId?: string` (agent-sdk)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-backend.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { LLM_PROVIDER_CHECK_IDS as ReExported } from '../agent/llm-provider/backend.js';
import type { HealthSignal } from '../types/health.js';
import type { DiagnosisFinding } from '../types/diagnosis-result.js';

describe('llm-provider check ids', () => {
  it('pins the six stable check ids consumed by the guidance registry', () => {
    expect(LLM_PROVIDER_CHECK_IDS).toEqual({
      keyPresent: 'llm-provider.key_present',
      keyValid: 'llm-provider.key_valid',
      quotaBilling: 'llm-provider.quota_billing',
      rateLimitHeadroom: 'llm-provider.rate_limit_headroom',
      modelDeprecated: 'llm-provider.model_deprecated',
      providerStatus: 'llm-provider.provider_status',
    });
  });

  it('namespaces every id under llm-provider.', () => {
    for (const id of Object.values(LLM_PROVIDER_CHECK_IDS)) {
      expect(id.startsWith('llm-provider.')).toBe(true);
    }
  });

  it('enumerates cleanly for the guidance registry, and backend.ts re-exports the same object', () => {
    // PR 5 imports from check-ids.js and enumerates with Object.values.
    expect(Object.values(LLM_PROVIDER_CHECK_IDS)).toHaveLength(6);
    expect(new Set(Object.values(LLM_PROVIDER_CHECK_IDS)).size).toBe(6);
    expect(ReExported).toBe(LLM_PROVIDER_CHECK_IDS);
  });

  it('lets a HealthSignal carry an optional checkId', () => {
    const signal: HealthSignal = {
      source: 'llm_key_valid',
      status: 'critical',
      detail: 'key rejected',
      observedAt: new Date().toISOString(),
      checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
    };
    expect(signal.checkId).toBe('llm-provider.key_valid');
  });

  it('lets a DiagnosisFinding carry an optional checkId', () => {
    const finding: DiagnosisFinding = {
      source: 'llm_key_valid',
      observation: 'key rejected',
      severity: 'critical',
      checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
    };
    expect(finding.checkId).toBe('llm-provider.key_valid');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-backend.test.ts`
Expected: FAIL — cannot resolve `../agent/llm-provider/check-ids.js`.

- [ ] **Step 3: Add `checkId` to the SDK's HealthSignal and DiagnosisFinding**

In `packages/agent-sdk/src/types/health.ts`, add the field to `HealthSignal` after `entityId`:

```ts
export interface HealthSignal {
  source: string;
  status: HealthSignalStatus;
  detail: string;
  observedAt: string;
  /** Plain-English one-liner: what this signal measures and why it matters. */
  explanation?: string;
  /** Where an unfamiliar operator can learn more about this concept. */
  learnMoreUrl?: string;
  /** Stable identifier of the concrete resource this signal is about (e.g. an RDS instance id) — used for cross-agent correlation. */
  entityId?: string;
  /** Stable id of the check that produced this signal (e.g. 'llm-provider.key_valid') — consumed by the guidance registry. Optional: agents adopt it incrementally. */
  checkId?: string;
}
```

In `packages/agent-sdk/src/types/diagnosis-result.ts`, add the same field to `DiagnosisFinding` after `learnMoreUrl` (PR 5's diagnose-path guidance keys on this and nothing else):

```ts
  /** Stable id of the check that produced this finding (e.g. 'llm-provider.key_valid') — consumed by the guidance registry. Optional: agents adopt it incrementally. */
  checkId?: string;
```

Rebuild the SDK so the main package sees the new types (they are consumed from `dist/`, which is gitignored):

```bash
pnpm --filter @crisismode/agent-sdk run build
```

- [ ] **Step 4: Write the check-id module**

Create `src/agent/llm-provider/check-ids.ts`. It imports nothing on purpose: PR 5's guidance registry needs these constants without pulling in the agent, its backend types, or the provider table.

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check ids for the llm-provider agent.
 *
 * These are a published contract, not an implementation detail: the guidance
 * registry keys operator advice on them, and machine-mode scan output carries
 * them. Renaming one silently drops the guidance attached to it.
 *
 * Kept in a dependency-free module so consumers can import the ids without
 * importing the agent. Re-exported from backend.ts for in-agent use.
 */

export const LLM_PROVIDER_CHECK_IDS = {
  keyPresent: 'llm-provider.key_present',
  keyValid: 'llm-provider.key_valid',
  quotaBilling: 'llm-provider.quota_billing',
  rateLimitHeadroom: 'llm-provider.rate_limit_headroom',
  modelDeprecated: 'llm-provider.model_deprecated',
  providerStatus: 'llm-provider.provider_status',
} as const;

export type LlmProviderCheckId = (typeof LLM_PROVIDER_CHECK_IDS)[keyof typeof LLM_PROVIDER_CHECK_IDS];
```

- [ ] **Step 5: Write the backend contract**

Create `src/agent/llm-provider/backend.ts`:

```ts
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
```

`transition?(to: string): void` is deliberately **not** redeclared here — `ExecutionBackend` already declares it, and repeating it just creates two places to keep in sync.

- [ ] **Step 6: Run the test and verify it passes**

Run: `pnpm vitest run src/__tests__/llm-provider-backend.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add packages/agent-sdk/src/types/health.ts packages/agent-sdk/src/types/diagnosis-result.ts src/agent/llm-provider/check-ids.ts src/agent/llm-provider/backend.ts src/__tests__/llm-provider-backend.test.ts
git commit -m "feat(llm-provider): define backend contract and stable check ids"
```

---

### Task 3: Simulator — seven scenarios

**Files:**
- Create: `src/agent/llm-provider/simulator.ts`
- Test: `src/__tests__/llm-provider-simulator.test.ts`

**Interfaces:**
- Consumes: everything from `backend.js` (Task 2); `LlmProviderId` from `provider-table.js` (Task 1).
- Produces:
  - `type LlmProviderScenario = 'healthy' | 'no_key' | 'bad_key' | 'quota_exhausted' | 'rate_limited' | 'deprecated_model' | 'provider_incident'`
  - `class LlmProviderSimulator implements LlmProviderBackend` — `constructor(scenario: LlmProviderScenario = 'healthy', provider: LlmProviderId = 'anthropic')`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-simulator.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';

describe('LlmProviderSimulator', () => {
  it('reports every check passing in the healthy scenario', async () => {
    const sim = new LlmProviderSimulator('healthy');
    expect((await sim.checkKeyPresence()).present).toBe(true);
    expect((await sim.checkKeyValidity()).outcome).toBe('valid');
    expect((await sim.checkRateLimitHeadroom()).requestsRemainingPct).toBeGreaterThan(20);
    expect((await sim.checkModel()).presentInList).toBe(true);
    expect((await sim.checkProviderStatus()).ongoingIncidents).toEqual([]);
  });

  it('never exposes key material, only a last-4 fingerprint', async () => {
    const presence = await new LlmProviderSimulator('healthy').checkKeyPresence();
    expect(presence.fingerprint).toBe('…lkey');
    expect(presence.envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('reports a missing key without inventing a validity result', async () => {
    const sim = new LlmProviderSimulator('no_key');
    const presence = await sim.checkKeyPresence();
    expect(presence.present).toBe(false);
    expect(presence.fingerprint).toBeNull();
    expect(presence.checkedEnvVars).toContain('ANTHROPIC_API_KEY');
    expect((await sim.checkKeyValidity()).outcome).toBe('unknown');
  });

  it('classifies a rejected key as invalid_key with the HTTP status', async () => {
    const validity = await new LlmProviderSimulator('bad_key').checkKeyValidity();
    expect(validity.outcome).toBe('invalid_key');
    expect(validity.httpStatus).toBe(401);
  });

  it('classifies an exhausted balance as billing_or_quota', async () => {
    const validity = await new LlmProviderSimulator('quota_exhausted').checkKeyValidity();
    expect(validity.outcome).toBe('billing_or_quota');
    expect(validity.detail.toLowerCase()).toContain('quota');
  });

  it('reports low headroom in the rate_limited scenario', async () => {
    const headroom = await new LlmProviderSimulator('rate_limited').checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBeLessThan(20);
  });

  it('reports a configured model missing from the live list', async () => {
    const model = await new LlmProviderSimulator('deprecated_model').checkModel();
    expect(model.listKnown).toBe(true);
    expect(model.presentInList).toBe(false);
    expect(model.configuredModel).toBe('claude-3-sonnet-20240229');
    expect(model.sampleModels.length).toBeGreaterThan(0);
  });

  it('reports an ongoing incident in the provider_incident scenario', async () => {
    const status = await new LlmProviderSimulator('provider_incident').checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toHaveLength(1);
    expect(status.ongoingIncidents[0]!.title).toContain('Elevated error rates');
  });

  it('reports unknown headroom for a provider that exposes no ratelimit headers', async () => {
    const headroom = await new LlmProviderSimulator('healthy', 'google').checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.requestsRemainingPct).toBeNull();
    expect(headroom.detail).toContain('does not publish');
  });

  it('switches scenario via transition()', async () => {
    const sim = new LlmProviderSimulator('healthy');
    sim.transition('bad_key');
    expect((await sim.checkKeyValidity()).outcome).toBe('invalid_key');
  });

  it('answers evaluateCheck statements from scenario state', async () => {
    const sim = new LlmProviderSimulator('bad_key');
    expect(await sim.evaluateCheck({ type: 'api_call', statement: 'llm_key_valid', expect: { operator: 'eq', value: 'ok' } })).toBe(false);
    sim.transition('healthy');
    expect(await sim.evaluateCheck({ type: 'api_call', statement: 'llm_key_valid', expect: { operator: 'eq', value: 'ok' } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-simulator.test.ts`
Expected: FAIL — cannot resolve `../agent/llm-provider/simulator.js`.

- [ ] **Step 3: Write the simulator**

Create `src/agent/llm-provider/simulator.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * In-memory scenario simulator for the llm-provider agent. Never touches the
 * network and never reads the environment — every value below is fixture data,
 * including the fake key whose fingerprint appears in output.
 */

import type {
  KeyPresence,
  KeyValidity,
  LlmProviderBackend,
  ModelCheck,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { fingerprintKey, getProviderSpec, type LlmProviderId } from './provider-table.js';

export type LlmProviderScenario =
  | 'healthy'
  | 'no_key'
  | 'bad_key'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'deprecated_model'
  | 'provider_incident';

/** Fixture key — not a credential; only its last 4 characters are ever shown. */
const FIXTURE_KEY = 'sk-ant-simulator-fixture-notarealkey';

const LIVE_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-haiku-4-5',
];

export class LlmProviderSimulator implements LlmProviderBackend {
  constructor(
    private scenario: LlmProviderScenario = 'healthy',
    private readonly provider: LlmProviderId = 'anthropic',
  ) {}

  getProviderId(): LlmProviderId {
    return this.provider;
  }

  transition(to: string): void {
    this.scenario = to as LlmProviderScenario;
  }

  private get spec() {
    return getProviderSpec(this.provider)!;
  }

  async checkKeyPresence(): Promise<KeyPresence> {
    const checkedEnvVars = this.spec.envVars;
    if (this.scenario === 'no_key') {
      return { provider: this.provider, present: false, envVar: null, fingerprint: null, checkedEnvVars };
    }
    return {
      provider: this.provider,
      present: true,
      envVar: checkedEnvVars[0]!,
      fingerprint: fingerprintKey(FIXTURE_KEY),
      checkedEnvVars,
    };
  }

  async checkKeyValidity(): Promise<KeyValidity> {
    switch (this.scenario) {
      case 'no_key':
        return {
          provider: this.provider,
          outcome: 'unknown',
          httpStatus: null,
          detail: 'No API key to test — key validity cannot be determined.',
        };
      case 'bad_key':
        return {
          provider: this.provider,
          outcome: 'invalid_key',
          httpStatus: 401,
          detail: `${this.spec.label} rejected the API key (HTTP 401 authentication_error) — every AI request is failing.`,
        };
      case 'quota_exhausted':
        return {
          provider: this.provider,
          outcome: 'billing_or_quota',
          httpStatus: 429,
          detail: `${this.spec.label} reports the account is out of quota or credit (HTTP 429) — requests are failing until billing is topped up.`,
        };
      case 'rate_limited':
        return {
          provider: this.provider,
          outcome: 'valid',
          httpStatus: 200,
          detail: `${this.spec.label} accepted the API key.`,
        };
      default:
        return {
          provider: this.provider,
          outcome: 'valid',
          httpStatus: 200,
          detail: `${this.spec.label} accepted the API key.`,
        };
    }
  }

  async checkRateLimitHeadroom(): Promise<RateLimitHeadroom> {
    if (!this.spec.rateLimitHeaderPrefix) {
      return {
        provider: this.provider,
        known: false,
        requestsRemainingPct: null,
        tokensRemainingPct: null,
        detail: `${this.spec.label} does not publish rate-limit response headers — headroom is unknown, not zero.`,
      };
    }
    if (this.scenario === 'no_key' || this.scenario === 'bad_key') {
      return {
        provider: this.provider,
        known: false,
        requestsRemainingPct: null,
        tokensRemainingPct: null,
        detail: 'No authenticated response to read rate-limit headers from.',
      };
    }
    if (this.scenario === 'rate_limited') {
      return {
        provider: this.provider,
        known: true,
        requestsRemainingPct: 4,
        tokensRemainingPct: 11,
        detail: `${this.spec.label} rate-limit headroom is low: 4% of requests and 11% of tokens remain — requests may start failing.`,
      };
    }
    return {
      provider: this.provider,
      known: true,
      requestsRemainingPct: 92,
      tokensRemainingPct: 88,
      detail: `${this.spec.label} rate-limit headroom: 92% of requests and 88% of tokens remain.`,
    };
  }

  async checkModel(): Promise<ModelCheck> {
    if (this.scenario === 'deprecated_model') {
      return {
        provider: this.provider,
        configuredModel: 'claude-3-sonnet-20240229',
        source: 'env',
        listKnown: true,
        presentInList: false,
        sampleModels: LIVE_MODELS,
        detail:
          "The configured model 'claude-3-sonnet-20240229' is not in the live model list — this is a config mismatch and requests naming it will fail.",
      };
    }
    if (this.scenario === 'no_key' || this.scenario === 'bad_key') {
      return {
        provider: this.provider,
        configuredModel: null,
        source: null,
        listKnown: false,
        presentInList: null,
        sampleModels: [],
        detail: 'Model list could not be read without a working API key.',
      };
    }
    return {
      provider: this.provider,
      configuredModel: LIVE_MODELS[0]!,
      source: 'env',
      listKnown: true,
      presentInList: true,
      sampleModels: LIVE_MODELS,
      detail: `The configured model '${LIVE_MODELS[0]}' is available.`,
    };
  }

  async checkProviderStatus(): Promise<ProviderStatusReport> {
    if (this.scenario === 'provider_incident') {
      return {
        provider: this.provider,
        known: true,
        ongoingIncidents: [
          {
            title: 'Elevated error rates on the Messages API',
            impact: 'major',
            url: 'https://status.anthropic.com/incidents/simulated',
          },
        ],
        detail: `${this.spec.label} reports 1 ongoing incident: Elevated error rates on the Messages API (major).`,
      };
    }
    return {
      provider: this.provider,
      known: true,
      ongoingIncidents: [],
      detail: `${this.spec.label} reports no ongoing incidents.`,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported llm-provider simulator command type: ${command.type}`);
    }
    if (command.operation === 'llm_provider_check') {
      return {
        keyPresence: await this.checkKeyPresence(),
        keyValidity: await this.checkKeyValidity(),
        rateLimitHeadroom: await this.checkRateLimitHeadroom(),
        model: await this.checkModel(),
        providerStatus: await this.checkProviderStatus(),
      };
    }
    return { simulated: true, operation: command.operation, parameters: command.parameters };
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

  async close(): Promise<void> {}
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run src/__tests__/llm-provider-simulator.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/simulator.ts src/__tests__/llm-provider-simulator.test.ts
git commit -m "feat(llm-provider): add scenario simulator for the six checks"
```

---

### Task 4: Manifest, capabilities, and signal explanations

**Files:**
- Create: `src/agent/llm-provider/manifest.ts`
- Modify: `src/framework/capability-registry.ts` (append two entries in the AI Provider section)
- Modify: `src/framework/signal-explanations.ts` (two `EXPLANATIONS` entries)
- Modify: `src/__tests__/explanation-coverage.test.ts` (add the `llm-provider` row)
- Test: `src/__tests__/llm-provider-agent.test.ts` (created here, extended in Tasks 5–6)

**Interfaces:**
- Consumes: `MANIFEST_API_VERSION`, `RECOVERY_AGENT_COMPATIBILITY_MODE`, `defaultManifestMetadata` from `src/framework/manifest-defaults.js`; `AgentManifest` from `src/types/manifest.js`; `LLM_PROVIDERS`, `LlmProviderId` from `src/agent/llm-provider/provider-table.js` (Task 1).
- Produces: `function buildLlmProviderManifest(providerId: LlmProviderId): AgentManifest` (agent name `llm-provider-diagnosis` for every provider, version `1.0.0`, `maxRiskLevel: 'routine'`, execution context `llm_read` declaring capabilities `llm.provider.status.read` and `llm.provider.key.verify`) plus `const LLM_PROVIDER_MATURITY: Record<LlmProviderId, 'live_validated' | 'simulator_only'>` (`anthropic`/`openai` → `live_validated`, `google`/`openrouter` → `simulator_only` — see the design doc's Maturity claim), the four built manifests exported by name (`anthropicManifest`, `openaiManifest`, `googleManifest`, `openrouterManifest`), and `const llmProviderManifests: Record<LlmProviderId, AgentManifest>` for Task 9's registration factory to index into.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-agent.test.ts` (Tasks 5 and 6 append to this file):

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  buildLlmProviderManifest,
  llmProviderManifests,
  LLM_PROVIDER_MATURITY,
} from '../agent/llm-provider/manifest.js';
import { LLM_PROVIDERS } from '../agent/llm-provider/provider-table.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';

describe('llm-provider manifests', () => {
  it('claims the per-provider maturity at routine risk for every provider', () => {
    for (const spec of LLM_PROVIDERS) {
      const manifest = llmProviderManifests[spec.id];
      expect(manifest.metadata.plugin.maturity).toBe(LLM_PROVIDER_MATURITY[spec.id]);
      expect(manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
      expect(manifest.spec.riskProfile.dataLossPossible).toBe(false);
      expect(manifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
    }
  });

  it('gives anthropic and openai live_validated, and google and openrouter simulator_only', () => {
    expect(LLM_PROVIDER_MATURITY.anthropic).toBe('live_validated');
    expect(LLM_PROVIDER_MATURITY.openai).toBe('live_validated');
    expect(LLM_PROVIDER_MATURITY.google).toBe('simulator_only');
    expect(LLM_PROVIDER_MATURITY.openrouter).toBe('simulator_only');
  });

  it('builds a fresh manifest object per call, not a shared mutable singleton', () => {
    expect(buildLlmProviderManifest('anthropic')).not.toBe(buildLlmProviderManifest('anthropic'));
    expect(buildLlmProviderManifest('anthropic')).toEqual(llmProviderManifests.anthropic);
  });

  it('declares only read privilege — this agent never mutates, for every provider', () => {
    for (const spec of LLM_PROVIDERS) {
      for (const ctx of llmProviderManifests[spec.id].spec.executionContexts) {
        expect(ctx.privilege).toBe('read');
      }
    }
  });

  it('registers every capability it declares, for every provider', () => {
    for (const spec of LLM_PROVIDERS) {
      for (const ctx of llmProviderManifests[spec.id].spec.executionContexts) {
        for (const capability of ctx.capabilities ?? []) {
          expect(isKnownCapability(capability), `unregistered capability ${capability}`).toBe(true);
        }
      }
    }
  });

  it('has a plain-language explanation for every signal source it emits', () => {
    for (const source of [
      'llm_key_present',
      'llm_key_valid',
      'llm_quota_billing',
      'llm_rate_limit_headroom',
      'llm_model_deprecated',
      'llm_provider_status',
    ]) {
      expect(explainSource(source), `no EXPLANATIONS entry for ${source}`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-agent.test.ts`
Expected: FAIL — cannot resolve `../agent/llm-provider/manifest.js`.

- [ ] **Step 3: Write the manifest**

Create `src/agent/llm-provider/manifest.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';
import { LLM_PROVIDERS, type LlmProviderId } from './provider-table.js';

/**
 * Maturity is per PROVIDER, not per agent: Anthropic and OpenAI have been
 * validated against real keys (see the verify-skill record in Task 14's
 * commit), Google and OpenRouter have the identical live code path but no
 * real-key validation yet. Each provider gets its own registration under its
 * own kind (`llm-provider.<provider>`, wired up in Task 9) so the existing
 * kind-keyed maturity machinery (`buildMaturityByKind`) buckets them
 * correctly without averaging one provider's validation state into another's.
 */
export const LLM_PROVIDER_MATURITY: Record<LlmProviderId, 'live_validated' | 'simulator_only'> = {
  anthropic: 'live_validated',
  openai: 'live_validated',
  google: 'simulator_only',
  openrouter: 'simulator_only',
};

/** Build the manifest for one provider's `llm-provider.<provider>` registration. */
export function buildLlmProviderManifest(providerId: LlmProviderId): AgentManifest {
  const spec = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!spec) throw new Error(`Unknown llm-provider id "${providerId}"`);

  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: 'AgentManifest',
    metadata: {
      name: 'llm-provider-diagnosis',
      version: '1.0.0',
      description: `Read-only health checks for ${spec.label}, the LLM provider an AI app depends on: API key presence and validity, quota and billing state, rate-limit headroom, configured-model availability, and provider incidents.`,
      ...defaultManifestMetadata(),
      tags: ['llm', 'ai-provider', 'api-key', 'quota', 'rate-limit', providerId],
      plugin: {
        id: `llm-provider.${providerId}.diagnosis`,
        kind: 'domain_pack',
        maturity: LLM_PROVIDER_MATURITY[providerId],
        compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
      },
    },
    spec: {
      targetSystems: [
        {
          technology: `llm-provider.${providerId}`,
          versionConstraint: '*',
          components: ['api-key', 'quota', 'rate-limit', 'model', 'provider-status'],
        },
      ],
      triggerConditions: [
        { type: 'health_check', name: 'llm_provider_status', status: 'degraded' },
        { type: 'manual', description: `Operator-initiated ${spec.label} check` },
      ],
      failureScenarios: [
        'api_key_missing',
        'api_key_invalid',
        'quota_or_billing_exhausted',
        'rate_limit_headroom_low',
        'configured_model_unavailable',
        'provider_incident',
      ],
      executionContexts: [
        {
          name: 'llm_read',
          type: 'api_call',
          privilege: 'read',
          target: `llm-provider.${providerId}`,
          allowedOperations: ['llm_provider_check'],
          capabilities: ['llm.provider.key.verify', 'llm.provider.status.read'],
        },
      ],
      observabilityDependencies: {
        required: ['provider_api_reachability'],
        optional: ['provider_status_page', 'provider_ratelimit_headers'],
      },
      riskProfile: {
        maxRiskLevel: 'routine',
        dataLossPossible: false,
        serviceDisruptionPossible: false,
      },
      humanInteraction: {
        requiresApproval: false,
        minimumApprovalRole: 'on_call_engineer',
        escalationPath: ['on_call_engineer', 'engineering_lead'],
      },
    },
  };
}

export const anthropicManifest = buildLlmProviderManifest('anthropic');
export const openaiManifest = buildLlmProviderManifest('openai');
export const googleManifest = buildLlmProviderManifest('google');
export const openrouterManifest = buildLlmProviderManifest('openrouter');

/** Looked up by Task 9's registration factory, one entry per provider kind. */
export const llmProviderManifests: Record<LlmProviderId, AgentManifest> = {
  anthropic: anthropicManifest,
  openai: openaiManifest,
  google: googleManifest,
  openrouter: openrouterManifest,
};
```

- [ ] **Step 4: Register the two capabilities**

In `src/framework/capability-registry.ts`, immediately after the `provider.traffic.shift` entry (the last of the `// ── AI Provider ──` section), add. `targetKinds` enumerates all four provider-scoped kinds — the capability is the same read operation regardless of which provider's registration performs it:

```ts
  // ── LLM Provider (read-only diagnosis) ──
  {
    id: 'llm.provider.key.verify',
    actionKind: 'read',
    description: 'Verify an LLM provider API key with a free, read-only metadata call.',
    targetKinds: ['llm-provider.anthropic', 'llm-provider.openai', 'llm-provider.google', 'llm-provider.openrouter'],
    manualFallback: 'Call the provider\'s models endpoint with your key using curl and read the HTTP status.',
  },
  {
    id: 'llm.provider.status.read',
    actionKind: 'read',
    description: 'Read an LLM provider\'s rate-limit headroom, model list, and public status page.',
    targetKinds: ['llm-provider.anthropic', 'llm-provider.openai', 'llm-provider.google', 'llm-provider.openrouter'],
    manualFallback: 'Open the provider\'s status page and usage dashboard in a browser.',
  },
```

- [ ] **Step 5: Add the signal explanations**

In `src/framework/signal-explanations.ts`, insert these two entries into `EXPLANATIONS` immediately **before** the existing `/^provider_health|^ai_provider|model_availability/` entry (order matters — `EXPLANATIONS.find` returns the first match):

```ts
  {
    match: /^llm_key|^llm_quota/,
    explanation: 'Your app authenticates to its LLM provider with an API key. A missing, rotated, or unpaid key makes every AI feature fail with errors that look like application bugs — the fix is in the provider dashboard, not the code.',
    learnMoreUrl: 'https://docs.claude.com/en/api/errors',
  },
  {
    match: /^llm_/,
    explanation: 'LLM provider health: rate-limit headroom, whether the model id your app names still exists, and whether the provider is having an incident. Any of these makes the app fail while your own infrastructure is perfectly healthy.',
    learnMoreUrl: 'https://docs.claude.com/en/api/rate-limits',
  },
```

- [ ] **Step 6: Add the agent kind to the explanation-coverage enforcement test**

In `src/__tests__/explanation-coverage.test.ts`, add four rows to `REPRESENTATIVE_SOURCES` after the `'iac-drift'` row — one per provider kind, each carrying the same six sources (every provider emits the same signal source names; only the kind and the eventual `checkId`/provider label differ):

```ts
  'llm-provider.anthropic': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.openai': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.google': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.openrouter': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
```

(The first assertion in that test — every kind in `builtinAgents` has a row — only starts covering these four kinds once Task 9 registers them. Adding the rows now keeps Task 9 from failing an unrelated test.)

- [ ] **Step 7: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/llm-provider-agent.test.ts src/__tests__/explanation-coverage.test.ts src/__tests__/capability-registry.test.ts
```
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/manifest.ts src/framework/capability-registry.ts src/framework/signal-explanations.ts src/__tests__/llm-provider-agent.test.ts src/__tests__/explanation-coverage.test.ts
git commit -m "feat(llm-provider): add manifest, read capabilities, and signal explanations"
```

---

### Task 5: Offline gate + agent `assessHealth` and `diagnose`

**Files:**
- Create: `src/agent/llm-provider/offline-gate.ts`
- Create: `src/agent/llm-provider/agent.ts`
- Test: `src/__tests__/llm-provider-agent.test.ts` (append)

**Interfaces:**
- Consumes: `LlmProviderBackend` and the result types from `backend.js`, `LLM_PROVIDER_CHECK_IDS` from `check-ids.js` (Task 2); `LlmProviderSimulator` from `simulator.js` (Task 3); `buildLlmProviderManifest` from `manifest.js` (Task 4); `getProviderSpec` from `provider-table.js` (Task 1); `getTriageReport(): TriageReport | null` from `src/framework/triage.js` (PR 2).
- Produces:
  - `interface ObserverOffline { verdict: 'local' | 'network'; explanation: string }`
  - `type OfflineGate = () => Promise<ObserverOffline | null>`
  - `const defaultOfflineGate: OfflineGate`
  - `class LlmProviderDiagnosisAgent implements RecoveryAgent` — `constructor(backend?: LlmProviderBackend, offlineGate?: OfflineGate)`, with `manifest` and `backend` public fields; `manifest` is built via `buildLlmProviderManifest(backend.getProviderId())` in the constructor, so each instance's manifest — and maturity — matches the provider its backend was constructed for. Task 6 adds `plan`/`replan` to this same class.
  - Signal sources emitted: `llm_key_present`, `llm_key_valid`, `llm_quota_billing`, `llm_rate_limit_headroom`, `llm_model_deprecated`, `llm_provider_status` — each carrying the matching `checkId`.

- [ ] **Step 1: Confirm PR 2's triage export names**

```bash
grep -n "export function getTriageReport\|export interface TriageReport" -A 6 src/framework/triage.ts
```

Expected (per PR 2's plan): `getTriageReport(): TriageReport | null`, with `TriageReport.verdict` one of `local | network | remote | mixed | healthy` and `TriageReport.explanation` a string. If the merged module names them differently, adapt **only** `offline-gate.ts` in Step 3 — every other file consumes the local `OfflineGate` type. If PR 2 exposes no report cache at all, make `defaultOfflineGate` return `null` unconditionally with a comment naming the missing accessor, and say so in the commit message: an agent that never defers is strictly better than an agent that re-runs network probes inside `assessHealth`.

- [ ] **Step 2: Write the failing test**

Append to `src/__tests__/llm-provider-agent.test.ts` (keep the existing imports and add these):

```ts
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { assembleContext } from '../framework/context.js';
import { healthToSignals } from '../framework/health-to-signals.js';
import type { AgentContext } from '../types/agent-context.js';
import type { OfflineGate } from '../agent/llm-provider/offline-gate.js';
import type { LlmProviderScenario } from '../agent/llm-provider/simulator.js';

function setup(scenario: LlmProviderScenario = 'healthy', gate?: OfflineGate) {
  const simulator = new LlmProviderSimulator(scenario);
  const agent = new LlmProviderDiagnosisAgent(simulator, gate ?? (async () => null));
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'llm-providerScanCheck', instance: 'derived-llm-anthropic', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { simulator, agent, context: assembleContext(trigger, agent.manifest) };
}

describe('LlmProviderDiagnosisAgent.assessHealth', () => {
  it('is healthy when every check passes', async () => {
    const { agent, context } = setup('healthy');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('healthy');
    expect(health.signals).toHaveLength(6);
  });

  it('tags every signal with its stable checkId', async () => {
    const { agent, context } = setup('healthy');
    const health = await agent.assessHealth(context);
    expect(health.signals.map((s) => s.checkId)).toEqual([
      LLM_PROVIDER_CHECK_IDS.keyPresent,
      LLM_PROVIDER_CHECK_IDS.keyValid,
      LLM_PROVIDER_CHECK_IDS.quotaBilling,
      LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
      LLM_PROVIDER_CHECK_IDS.modelDeprecated,
      LLM_PROVIDER_CHECK_IDS.providerStatus,
    ]);
  });

  it('is unhealthy with a critical key_valid signal when the key is rejected', async () => {
    const { agent, context } = setup('bad_key');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const keyValid = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyValid)!;
    expect(keyValid.status).toBe('critical');
    expect(keyValid.detail).toContain('401');
  });

  it('is unhealthy with a critical quota_billing signal when the account is out of credit', async () => {
    const { agent, context } = setup('quota_exhausted');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const quota = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.quotaBilling)!;
    expect(quota.status).toBe('critical');
  });

  it('is degraded when rate-limit headroom is below 20%', async () => {
    const { agent, context } = setup('rate_limited');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('recovering');
    expect(health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom)!.status).toBe('warning');
  });

  it('is degraded when the provider reports an ongoing incident', async () => {
    const { agent, context } = setup('provider_incident');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('recovering');
  });

  it('names the env vars it checked and the no-.env rule when no key is present', async () => {
    const { agent, context } = setup('no_key');
    const health = await agent.assessHealth(context);
    expect(health.status).toBe('unhealthy');
    const presence = health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyPresent)!;
    expect(presence.status).toBe('critical');
    expect(presence.detail).toContain('ANTHROPIC_API_KEY');
    expect(presence.detail).toContain('.env');
  });

  it('defers to the triage verdict instead of reporting the provider down when offline', async () => {
    const gate: OfflineGate = async () => ({
      verdict: 'network',
      explanation: 'this machine has no working internet connection (DNS resolves, but no host is reachable)',
    });
    const { agent, context } = setup('bad_key', gate);
    const health = await agent.assessHealth(context);

    expect(health.status).toBe('unknown');
    const networkChecks = health.signals.filter((s) => s.checkId !== LLM_PROVIDER_CHECK_IDS.keyPresent);
    expect(networkChecks).toHaveLength(5);
    for (const signal of networkChecks) {
      expect(signal.status).toBe('unknown');
      expect(signal.detail).toContain('no working internet connection');
    }
    // key_present still works offline.
    expect(health.signals.find((s) => s.checkId === LLM_PROVIDER_CHECK_IDS.keyPresent)!.status).toBe('healthy');
    expect(health.summary.toLowerCase()).not.toContain('provider is down');
  });

  it('maps its critical and warning signals onto the existing signal vocabulary', async () => {
    const { agent, context } = setup('bad_key');
    const mapped = healthToSignals(await agent.assessHealth(context));
    for (const signal of mapped) {
      expect(['connection', 'error_rate', 'config_mismatch', 'custom']).toContain(signal.type);
    }
    expect(mapped.find((s) => s.source === 'llm_key_valid')!.type).toBe('error_rate');

    const deprecated = setup('deprecated_model');
    const deprecatedMapped = healthToSignals(await deprecated.agent.assessHealth(deprecated.context));
    expect(deprecatedMapped.find((s) => s.source === 'llm_model_deprecated')!.type).toBe('config_mismatch');
  });
});

describe('LlmProviderDiagnosisAgent.diagnose', () => {
  it('identifies an invalid key', async () => {
    const { agent, context } = setup('bad_key');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('identified');
    expect(diagnosis.scenario).toBe('api_key_invalid');
    expect(diagnosis.findings.length).toBeGreaterThan(0);
  });

  it('identifies exhausted quota ahead of other scenarios', async () => {
    const { agent, context } = setup('quota_exhausted');
    expect((await agent.diagnose(context)).scenario).toBe('quota_or_billing_exhausted');
  });

  it('identifies a configured model that no longer exists', async () => {
    const { agent, context } = setup('deprecated_model');
    expect((await agent.diagnose(context)).scenario).toBe('configured_model_unavailable');
  });

  it('is inconclusive, not identified, when everything passes', async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('inconclusive');
    expect(diagnosis.scenario).toBeNull();
  });

  it('tags every finding with its checkId — PR 5 keys diagnose-path guidance on nothing else', async () => {
    const { agent, context } = setup('bad_key');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.findings.map((f) => f.checkId)).toEqual([
      LLM_PROVIDER_CHECK_IDS.keyPresent,
      LLM_PROVIDER_CHECK_IDS.keyValid,
      LLM_PROVIDER_CHECK_IDS.quotaBilling,
      LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
      LLM_PROVIDER_CHECK_IDS.modelDeprecated,
      LLM_PROVIDER_CHECK_IDS.providerStatus,
    ]);
  });

  it('tags the offline finding with a checkId too', async () => {
    const gate: OfflineGate = async () => ({ verdict: 'local', explanation: 'no network interface' });
    const { agent, context } = setup('bad_key', gate);
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.findings[0]!.checkId).toBe(LLM_PROVIDER_CHECK_IDS.providerStatus);
  });

  it('returns "unable" when the observer is offline', async () => {
    const gate: OfflineGate = async () => ({ verdict: 'local', explanation: 'this machine has no network interface with an address' });
    const { agent, context } = setup('bad_key', gate);
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.status).toBe('unable');
    expect(diagnosis.scenario).toBeNull();
    expect(diagnosis.findings[0]!.observation).toContain('no network interface');
  });
});
```

- [ ] **Step 3: Write the offline gate**

Create `src/agent/llm-provider/offline-gate.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The single seam between this agent and the triage module.
 *
 * When triage has already localised a failure to this machine or its network,
 * the provider checks would only report "the provider is unreachable" — which
 * is true but useless and reads as "the provider is down". This gate lets the
 * agent skip them and repeat triage's explanation instead.
 *
 * If PR 2's triage exports change shape, this file is the only one to update.
 *
 * Deliberate non-use: triage also populates the cached NetworkProfile
 * singleton, so `getNetworkProfile()?.internet.status` is a second offline
 * signal — and the only one available under `crisismode diagnose`, which runs
 * probeNetwork but not triage. It is not consulted here on purpose: it cannot
 * tell "this machine" from "this network", so it would degrade the very
 * distinction this gate exists to report. Without a triage verdict the checks
 * run and report their own per-check "could not be reached" unknowns, which is
 * already honest.
 */

import { getTriageReport } from '../../framework/triage.js';

export interface ObserverOffline {
  /** Which side triage localised the failure to. */
  verdict: 'local' | 'network';
  /** Triage's plain-language explanation, repeated verbatim in findings. */
  explanation: string;
}

export type OfflineGate = () => Promise<ObserverOffline | null>;

/**
 * Reads the triage report already computed in this process (scan runs triage
 * as step 0, which caches it).
 *
 * Never calls runTriage(): that runs live probes for several seconds, and scan
 * calls assessHealth once per target, so probing here would multiply triage's
 * cost by the number of targets.
 *
 * Two non-deferral cases that are correct, not oversights:
 * - `null` — triage has not run in this process (the normal case for
 *   `crisismode diagnose`). No information is not evidence of being offline.
 * - `mixed` — triage could not localise the failure. Deferring to a verdict
 *   that says "unclear" would be a guess dressed up as an explanation.
 */
export const defaultOfflineGate: OfflineGate = async () => {
  try {
    const report = getTriageReport();
    if (!report) return null;
    if (report.verdict !== 'local' && report.verdict !== 'network') return null;
    return { verdict: report.verdict, explanation: report.explanation };
  } catch {
    // A gate failure must never break the checks it is only meant to skip.
    return null;
  }
};
```

- [ ] **Step 4: Pin the gate's deferral rules with a test**

The three rules in Global Constraints are exactly the kind a later reader "fixes" into a bug — deferring on `mixed` looks like a missing case, and treating `null` as offline looks like a safety improvement. Both would make the agent claim an offline observer when it has no evidence of one. Lock them down.

Create `src/__tests__/llm-provider-offline-gate.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: the mock factory is evaluated when triage.js is first imported,
// which happens before a plain `const` at module scope is initialised.
const { getTriageReport } = vi.hoisted(() => ({ getTriageReport: vi.fn() }));
vi.mock('../framework/triage.js', () => ({ getTriageReport }));

import { defaultOfflineGate } from '../agent/llm-provider/offline-gate.js';

function report(verdict: string) {
  return {
    verdict,
    explanation: `triage says: ${verdict}`,
    nextStep: 'do the thing',
    layers: [],
    observerContext: 'laptop',
    observerContextEvidence: 'darwin',
    escalationLevel: 2,
    checkedAt: new Date().toISOString(),
    durationMs: 12,
  };
}

beforeEach(() => {
  getTriageReport.mockReset();
});

describe('defaultOfflineGate', () => {
  it('defers when triage localised the failure to this machine', async () => {
    getTriageReport.mockReturnValue(report('local'));
    expect(await defaultOfflineGate()).toEqual({ verdict: 'local', explanation: 'triage says: local' });
  });

  it('defers when triage localised the failure to the network', async () => {
    getTriageReport.mockReturnValue(report('network'));
    expect(await defaultOfflineGate()).toEqual({ verdict: 'network', explanation: 'triage says: network' });
  });

  it('does not defer when triage has not run — null is no information, not offline', async () => {
    getTriageReport.mockReturnValue(null);
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('does not defer on a mixed verdict — "could not localise" is not evidence the observer is offline', async () => {
    getTriageReport.mockReturnValue(report('mixed'));
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('does not defer when the machine and network are fine', async () => {
    for (const verdict of ['healthy', 'remote']) {
      getTriageReport.mockReturnValue(report(verdict));
      expect(await defaultOfflineGate(), verdict).toBeNull();
    }
  });

  it('does not defer when reading the triage cache throws', async () => {
    getTriageReport.mockImplementation(() => { throw new Error('triage module exploded'); });
    expect(await defaultOfflineGate()).toBeNull();
  });

  it('never runs triage itself — only the cached accessor is called', async () => {
    getTriageReport.mockReturnValue(null);
    await defaultOfflineGate();
    expect(getTriageReport).toHaveBeenCalledTimes(1);
  });
});
```

Run: `pnpm vitest run src/__tests__/llm-provider-offline-gate.test.ts`
Expected: PASS (7 tests).

No test in this plan calls `runTriage()`, so none of them populate the real cache and no `resetTriageReport()` cleanup is needed. If you add a test that does call `runTriage()`, put `resetTriageReport()` in its `afterEach` — same convention as the existing `resetNetworkProfile()`.

- [ ] **Step 5: Write the agent (health + diagnosis half)**

Create `src/agent/llm-provider/agent.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult, DiagnosisFinding } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthSignalStatus, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import { defaultReplan } from '../interface.js';
import { buildLlmProviderManifest } from './manifest.js';
import { getProviderSpec } from './provider-table.js';
import { LLM_PROVIDER_CHECK_IDS } from './check-ids.js';
import type {
  KeyPresence,
  KeyValidity,
  LlmProviderBackend,
  ModelCheck,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';
import type { AgentManifest } from '../../types/manifest.js';
import { LlmProviderSimulator } from './simulator.js';
import { defaultOfflineGate, type ObserverOffline, type OfflineGate } from './offline-gate.js';

/** Below this much remaining request headroom the provider layer is degraded. */
const HEADROOM_WARN_PCT = 20;

interface CheckBundle {
  presence: KeyPresence;
  /** Non-null when triage says the observer, not the provider, is the problem. */
  offline: ObserverOffline | null;
  validity: KeyValidity | null;
  headroom: RateLimitHeadroom | null;
  model: ModelCheck | null;
  status: ProviderStatusReport | null;
}

/**
 * One class, four registrations. `manifest` is built from the backend's own
 * `getProviderId()` rather than imported as a shared constant — each
 * provider's registration (Task 9) supplies a backend already bound to its
 * provider, so the manifest — and with it the per-provider maturity claim —
 * always matches the registration that constructed this instance.
 */
export class LlmProviderDiagnosisAgent implements RecoveryAgent {
  manifest: AgentManifest;
  backend: LlmProviderBackend;

  private readonly offlineGate: OfflineGate;

  constructor(backend?: LlmProviderBackend, offlineGate: OfflineGate = defaultOfflineGate) {
    this.backend = backend ?? new LlmProviderSimulator();
    this.manifest = buildLlmProviderManifest(this.backend.getProviderId());
    this.offlineGate = offlineGate;
  }

  private get label(): string {
    const provider = this.backend.getProviderId();
    return getProviderSpec(provider)?.label ?? provider;
  }

  /**
   * Run the checks that are worth running.
   *
   * key_present is always real — it reads the environment and works offline.
   * The five network checks are skipped when triage has localised the failure
   * to this machine, and the key-dependent ones are skipped when there is no
   * key to test. Provider status needs no key, so it still runs in that case.
   */
  private async runChecks(): Promise<CheckBundle> {
    const presence = await this.backend.checkKeyPresence();
    const offline = await this.offlineGate();

    if (offline) {
      return { presence, offline, validity: null, headroom: null, model: null, status: null };
    }

    if (!presence.present) {
      const status = await this.backend.checkProviderStatus();
      return { presence, offline: null, validity: null, headroom: null, model: null, status };
    }

    const [validity, headroom, model, status] = await Promise.all([
      this.backend.checkKeyValidity(),
      this.backend.checkRateLimitHeadroom(),
      this.backend.checkModel(),
      this.backend.checkProviderStatus(),
    ]);
    return { presence, offline: null, validity, headroom, model, status };
  }

  private buildSignals(bundle: CheckBundle, observedAt: string): HealthSignal[] {
    const { presence, offline } = bundle;
    const label = this.label;

    const skipDetail = offline
      ? `Skipped — ${offline.explanation}. CrisisMode cannot tell whether ${label} is healthy from a machine that is offline, so it is not guessing.`
      : `Skipped — no ${label} API key in this environment, so there is nothing to test.`;

    const signal = (
      source: string,
      checkId: string,
      status: HealthSignalStatus,
      detail: string,
    ): HealthSignal => ({ source, status, detail, observedAt, checkId });

    const signals: HealthSignal[] = [
      presence.present
        ? signal(
            'llm_key_present',
            LLM_PROVIDER_CHECK_IDS.keyPresent,
            'healthy',
            `${label} API key found in ${presence.envVar} (${presence.fingerprint}).`,
          )
        : signal(
            'llm_key_present',
            LLM_PROVIDER_CHECK_IDS.keyPresent,
            'critical',
            `No ${label} API key in this process's environment (checked ${presence.checkedEnvVars.join(', ')}). CrisisMode reads process.env only — it never parses .env files, so a key that lives in .env is invisible here.`,
          ),
    ];

    // key_valid
    if (bundle.validity === null) {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'unknown', skipDetail));
    } else if (bundle.validity.outcome === 'invalid_key' || bundle.validity.outcome === 'permission') {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'critical', bundle.validity.detail));
    } else if (bundle.validity.outcome === 'unknown' || bundle.validity.outcome === 'other') {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'unknown', bundle.validity.detail));
    } else {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'healthy', bundle.validity.detail));
    }

    // quota_billing — same probe, different question.
    if (bundle.validity === null) {
      signals.push(signal('llm_quota_billing', LLM_PROVIDER_CHECK_IDS.quotaBilling, 'unknown', skipDetail));
    } else if (bundle.validity.outcome === 'billing_or_quota') {
      signals.push(signal('llm_quota_billing', LLM_PROVIDER_CHECK_IDS.quotaBilling, 'critical', bundle.validity.detail));
    } else if (bundle.validity.outcome === 'valid' || bundle.validity.outcome === 'rate_limited') {
      signals.push(
        signal(
          'llm_quota_billing',
          LLM_PROVIDER_CHECK_IDS.quotaBilling,
          'healthy',
          `${label} returned no billing or quota error on the probe request.`,
        ),
      );
    } else {
      signals.push(
        signal(
          'llm_quota_billing',
          LLM_PROVIDER_CHECK_IDS.quotaBilling,
          'unknown',
          `Quota and billing state could not be determined: ${bundle.validity.detail}`,
        ),
      );
    }

    // rate_limit_headroom
    if (bundle.headroom === null) {
      signals.push(signal('llm_rate_limit_headroom', LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom, 'unknown', skipDetail));
    } else if (!bundle.headroom.known) {
      signals.push(signal('llm_rate_limit_headroom', LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom, 'unknown', bundle.headroom.detail));
    } else {
      const low = (bundle.headroom.requestsRemainingPct ?? 100) < HEADROOM_WARN_PCT
        || (bundle.headroom.tokensRemainingPct ?? 100) < HEADROOM_WARN_PCT;
      signals.push(
        signal(
          'llm_rate_limit_headroom',
          LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
          low ? 'warning' : 'healthy',
          bundle.headroom.detail,
        ),
      );
    }

    // model_deprecated
    if (bundle.model === null) {
      signals.push(signal('llm_model_deprecated', LLM_PROVIDER_CHECK_IDS.modelDeprecated, 'unknown', skipDetail));
    } else if (!bundle.model.listKnown || bundle.model.configuredModel === null) {
      signals.push(signal('llm_model_deprecated', LLM_PROVIDER_CHECK_IDS.modelDeprecated, 'unknown', bundle.model.detail));
    } else {
      signals.push(
        signal(
          'llm_model_deprecated',
          LLM_PROVIDER_CHECK_IDS.modelDeprecated,
          bundle.model.presentInList === false ? 'warning' : 'healthy',
          bundle.model.detail,
        ),
      );
    }

    // provider_status
    if (bundle.status === null) {
      signals.push(signal('llm_provider_status', LLM_PROVIDER_CHECK_IDS.providerStatus, 'unknown', skipDetail));
    } else if (!bundle.status.known) {
      signals.push(signal('llm_provider_status', LLM_PROVIDER_CHECK_IDS.providerStatus, 'unknown', bundle.status.detail));
    } else {
      signals.push(
        signal(
          'llm_provider_status',
          LLM_PROVIDER_CHECK_IDS.providerStatus,
          bundle.status.ongoingIncidents.length > 0 ? 'warning' : 'healthy',
          bundle.status.detail,
        ),
      );
    }

    return signals;
  }

  private overallStatus(signals: HealthSignal[]): HealthStatus {
    if (signals.some((s) => s.status === 'critical')) return 'unhealthy';
    if (signals.some((s) => s.status === 'warning')) return 'recovering';
    // Every network check unknown means we learned nothing about the provider.
    const networkChecks = signals.filter((s) => s.checkId !== LLM_PROVIDER_CHECK_IDS.keyPresent);
    if (networkChecks.every((s) => s.status === 'unknown')) return 'unknown';
    return 'healthy';
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const bundle = await this.runChecks();
    const signals = this.buildSignals(bundle, observedAt);
    const status = this.overallStatus(signals);
    const label = this.label;

    if (bundle.offline) {
      return {
        status,
        confidence: 0.3,
        summary: `${label} checks were skipped: ${bundle.offline.explanation}. Fix this machine's connectivity first — nothing here says ${label} is unhealthy.`,
        observedAt,
        signals,
        recommendedActions: [
          'Run `crisismode triage` for the full localisation detail and next step.',
          `Re-run this check once this machine is back online to learn the real ${label} state.`,
        ],
      };
    }

    const summary =
      status === 'unhealthy'
        ? `${label} is not usable from this environment: ${signals.find((s) => s.status === 'critical')!.detail}`
        : status === 'recovering'
          ? `${label} is reachable but degraded: ${signals.find((s) => s.status === 'warning')!.detail}`
          : status === 'unknown'
            ? `${label} state could not be determined — every live check returned an honest unknown.`
            : `${label} is healthy: the API key works, quota and rate-limit headroom are fine, the configured model exists, and the provider reports no incidents.`;

    const recommendedActions =
      status === 'unhealthy'
        ? [
            `Open the ${label} console and confirm the API key and billing state.`,
            'After fixing it, re-run `crisismode scan` to confirm the check turns green.',
          ]
        : status === 'recovering'
          ? [
              `Review the ${label} usage dashboard — the app is close to a limit or the provider is mid-incident.`,
              'Retry-with-backoff on the client side keeps requests alive through short rate-limit and incident windows.',
            ]
          : status === 'unknown'
            ? ['Re-run the check when the provider endpoints are reachable — no conclusion should be drawn from this result.']
            : ['No action required. Continue monitoring.'];

    return { status, confidence: status === 'unknown' ? 0.3 : 0.95, summary, observedAt, signals, recommendedActions };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const bundle = await this.runChecks();
    const label = this.label;

    if (bundle.offline) {
      return {
        status: 'unable',
        scenario: null,
        confidence: 0,
        findings: [
          {
            source: 'llm_provider_status',
            checkId: LLM_PROVIDER_CHECK_IDS.providerStatus,
            observation: `${label} could not be diagnosed from this machine: ${bundle.offline.explanation}.`,
            severity: 'info',
            data: { offline: bundle.offline, keyPresence: bundle.presence },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    const headroomLow =
      bundle.headroom?.known === true &&
      ((bundle.headroom.requestsRemainingPct ?? 100) < HEADROOM_WARN_PCT ||
        (bundle.headroom.tokensRemainingPct ?? 100) < HEADROOM_WARN_PCT);

    let scenario: string | null;
    let confidence: number;

    if (!bundle.presence.present) {
      scenario = 'api_key_missing';
      confidence = 0.99;
    } else if (bundle.validity?.outcome === 'invalid_key' || bundle.validity?.outcome === 'permission') {
      scenario = 'api_key_invalid';
      confidence = 0.98;
    } else if (bundle.validity?.outcome === 'billing_or_quota') {
      scenario = 'quota_or_billing_exhausted';
      confidence = 0.97;
    } else if (bundle.model?.presentInList === false) {
      scenario = 'configured_model_unavailable';
      confidence = 0.9;
    } else if (headroomLow) {
      scenario = 'rate_limit_headroom_low';
      confidence = 0.9;
    } else if ((bundle.status?.ongoingIncidents.length ?? 0) > 0) {
      scenario = 'provider_incident';
      confidence = 0.85;
    } else {
      scenario = null;
      confidence = 1.0;
    }

    // Every finding carries its checkId: the guidance registry keys diagnose-path
    // advice on this field alone, so an untagged finding silently gets none.
    const findings: DiagnosisFinding[] = [
      {
        source: 'llm_key_present',
        checkId: LLM_PROVIDER_CHECK_IDS.keyPresent,
        observation: bundle.presence.present
          ? `${label} API key found in ${bundle.presence.envVar} (${bundle.presence.fingerprint}).`
          : `No ${label} API key in this process's environment (checked ${bundle.presence.checkedEnvVars.join(', ')}). CrisisMode reads process.env only and never parses .env files.`,
        severity: bundle.presence.present ? 'info' : 'critical',
        data: { presence: bundle.presence },
      },
      {
        source: 'llm_key_valid',
        checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
        observation: bundle.validity?.detail ?? 'Key validity was not tested.',
        severity:
          bundle.validity?.outcome === 'invalid_key' || bundle.validity?.outcome === 'permission' ? 'critical' : 'info',
        data: { validity: bundle.validity },
      },
      {
        source: 'llm_quota_billing',
        checkId: LLM_PROVIDER_CHECK_IDS.quotaBilling,
        observation:
          bundle.validity?.outcome === 'billing_or_quota'
            ? bundle.validity.detail
            : `No billing or quota error observed for ${label}.`,
        severity: bundle.validity?.outcome === 'billing_or_quota' ? 'critical' : 'info',
        data: { validity: bundle.validity },
      },
      {
        source: 'llm_rate_limit_headroom',
        checkId: LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
        observation: bundle.headroom?.detail ?? 'Rate-limit headroom was not read.',
        severity: headroomLow ? 'warning' : 'info',
        data: { headroom: bundle.headroom },
      },
      {
        source: 'llm_model_deprecated',
        checkId: LLM_PROVIDER_CHECK_IDS.modelDeprecated,
        observation: bundle.model?.detail ?? 'The configured model was not verified.',
        severity: bundle.model?.presentInList === false ? 'warning' : 'info',
        data: { model: bundle.model },
      },
      {
        source: 'llm_provider_status',
        checkId: LLM_PROVIDER_CHECK_IDS.providerStatus,
        observation: bundle.status?.detail ?? 'Provider status was not read.',
        severity: (bundle.status?.ongoingIncidents.length ?? 0) > 0 ? 'warning' : 'info',
        data: { providerStatus: bundle.status },
      },
    ];

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, _diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    throw new Error('not implemented — Task 6');
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return defaultReplan();
  }
}
```

The `plan` stub exists only so the class satisfies the `RecoveryAgent` interface between tasks. Commit it as written — no test in this task calls `plan` — and Task 6 replaces it in its own commit.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pnpm vitest run src/__tests__/llm-provider-agent.test.ts src/__tests__/llm-provider-offline-gate.test.ts`
Expected: PASS (all `assessHealth` and `diagnose` tests, the Task 4 manifest tests, and the seven gate tests).

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/offline-gate.ts src/agent/llm-provider/agent.ts src/__tests__/llm-provider-agent.test.ts src/__tests__/llm-provider-offline-gate.test.ts
git commit -m "feat(llm-provider): assess health and diagnose across the six checks"
```

---

### Task 6: Agent `plan` + `replan`, and harness validation

**Files:**
- Modify: `src/agent/llm-provider/agent.ts` (replace the `plan` stub, add two private helpers)
- Test: `src/__tests__/llm-provider-plan.test.ts`

**Interfaces:**
- Consumes: `createPlanEnvelope` from `src/framework/plan-helpers.js`; `RecoveryStep` from `src/types/step-types.js`; `validateAgent` from `src/framework/agent-test-harness.js`.
- Produces: `LlmProviderDiagnosisAgent.plan()` returning a suggestion-only `RecoveryPlan` (three steps: `diagnosis_action`, `human_notification`, `replanning_checkpoint`) with a `rollbackStrategy` and no mutating step.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-plan.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { assembleContext } from '../framework/context.js';
import { validateAgent } from '../framework/agent-test-harness.js';
import type { AgentContext } from '../types/agent-context.js';
import type { LlmProviderScenario } from '../agent/llm-provider/simulator.js';

function setup(scenario: LlmProviderScenario = 'bad_key') {
  const agent = new LlmProviderDiagnosisAgent(new LlmProviderSimulator(scenario), async () => null);
  const trigger: AgentContext['trigger'] = {
    type: 'manual',
    source: 'cli',
    payload: { instance: 'derived-llm-anthropic', severity: 'warning' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, agent.manifest) };
}

describe('LlmProviderDiagnosisAgent.plan', () => {
  it('produces a valid plan with unique step ids and a rollback strategy', async () => {
    const { agent, context } = setup();
    const plan = await agent.plan(context, await agent.diagnose(context));

    expect(plan.kind).toBe('RecoveryPlan');
    expect(plan.metadata.agentName).toBe('llm-provider-diagnosis');
    expect(plan.rollbackStrategy).toBeDefined();
    const ids = plan.steps.map((s) => s.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never proposes a mutating step — this agent only suggests', async () => {
    const { agent, context } = setup();
    const plan = await agent.plan(context, await agent.diagnose(context));
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    expect(plan.impact.dataLossRisk).toBe('none');
  });

  it('puts the fix direction for the diagnosed scenario in the notification', async () => {
    const { agent, context } = setup('quota_exhausted');
    const plan = await agent.plan(context, await agent.diagnose(context));
    const notification = plan.steps.find((s) => s.type === 'human_notification')!;
    expect(JSON.stringify(notification)).toMatch(/billing|credit/i);
  });

  it('does not invent an incident when the diagnosis found nothing', async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBeNull();

    const plan = await agent.plan(context, diagnosis);
    expect(plan.metadata.scenario).toBe('no_finding');

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/incident/i);
    expect(serialized).not.toMatch(/status page/i);
    expect(plan.steps.find((s) => s.type === 'human_notification')!.message.actionRequired).toBe(false);
    expect(plan.metadata.summary).toMatch(/no actionable/i);
  });

  it('passes the generic agent contract harness', async () => {
    const { agent, context } = setup();
    const result = await validateAgent(agent, context);
    const failures = result.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`);
    expect(failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-plan.test.ts`
Expected: FAIL — `not implemented — Task 6`.

- [ ] **Step 3: Replace the `plan` stub**

In `src/agent/llm-provider/agent.ts`, add `RecoveryStep` to the type imports:

```ts
import type { RecoveryStep } from '../../types/step-types.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
```

Replace the `plan` stub with:

```ts
  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || `llm-${this.backend.getProviderId()}`);
    // A null scenario means diagnose found nothing actionable. Defaulting to a
    // real failure scenario here would make the plan assert a provider incident
    // that no check observed — the plan must not out-claim its diagnosis.
    const scenario = diagnosis.scenario ?? 'no_finding';
    const label = this.label;

    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: `Re-read ${label} provider state`,
        executionContext: 'llm_read',
        target,
        command: {
          type: 'api_call',
          operation: 'llm_provider_check',
          parameters: { provider: this.backend.getProviderId() },
        },
        outputCapture: {
          name: 'llm_provider_baseline',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: `Report the ${label} check result and its fix direction`,
        recipients: [
          {
            role: 'on_call_engineer',
            urgency: scenario === 'no_finding' ? 'low' : scenario === 'provider_incident' ? 'medium' : 'high',
          },
        ],
        message: {
          summary:
            scenario === 'no_finding'
              ? `${label}: no actionable provider issue found (${target})`
              : `${label}: ${scenario.replace(/_/g, ' ')} (${target})`,
          detail: this.fixDirection(scenario, label),
          contextReferences: ['llm_provider_baseline'],
          actionRequired: scenario !== 'provider_incident' && scenario !== 'no_finding',
        },
        channel: 'auto',
      },
      {
        stepId: 'step-003',
        type: 'replanning_checkpoint',
        name: `Re-check ${label} after the operator acts`,
        // Deliberately neutral wording: this description is emitted for every
        // scenario including 'no_finding', so it must not name a failure the
        // diagnosis did not find.
        description: `Re-run the ${label} checks and confirm whether the reported state has changed.`,
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_fix_llm_state',
            captureType: 'command_output',
            statement: 'llm_provider_check',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
    ];

    return {
      ...createPlanEnvelope({
        // Suffixed with the provider id, not the bare 'llm-provider' family
        // name — four provider agents can each produce a plan in the same
        // scan run, and plan ids need to stay unique across them.
        planIdSuffix: `llm-provider-${this.backend.getProviderId()}`,
        agentName: 'llm-provider-diagnosis',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT2M',
        summary:
          scenario === 'no_finding'
            ? `Re-read ${label} provider state for ${target} and record the result. No actionable provider issue was found, so this plan asserts nothing and asks for nothing.`
            : `Report the ${label} ${scenario.replace(/_/g, ' ')} on ${target} and tell the operator exactly what to change. Read-only: CrisisMode cannot rotate keys, pay bills, or change provider state.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: `llm-provider.${this.backend.getProviderId()}`,
            role: 'ai-inference',
            impactType: 'diagnosis_and_notification',
          },
        ],
        affectedServices: [`${label} API`],
        estimatedUserImpact:
          scenario === 'no_finding'
            ? 'None observed — the provider checks that ran all passed.'
            : scenario === 'api_key_missing' || scenario === 'api_key_invalid' || scenario === 'quota_or_billing_exhausted'
              ? 'Every AI feature in the app is failing until the provider account is fixed.'
              : 'AI features may fail intermittently.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'This plan only reads provider metadata and notifies humans. There are no mutations to roll back.',
      },
    };
  }

  /** The one thing the operator should change, per diagnosed scenario. */
  private fixDirection(scenario: string, label: string): string {
    switch (scenario) {
      case 'no_finding':
        return `No actionable ${label} issue was found: the key works, quota and headroom are fine, the configured model exists, and the provider reports nothing. Nothing to change here — if the app is still failing, the cause is elsewhere.`;
      case 'api_key_missing':
        return `No ${label} API key is set in the environment CrisisMode ran in. Export the key in the shell or platform environment your app uses. CrisisMode never reads .env files, so a key that only lives in .env will keep looking missing here even when the app works.`;
      case 'api_key_invalid':
        return `${label} rejected the API key. It has most likely been rotated, revoked, or copied incompletely. Create a fresh key in the ${label} console and replace it everywhere the app reads it — local shell, CI secrets, and the deploy platform.`;
      case 'quota_or_billing_exhausted':
        return `${label} accepted the key but refused to serve requests because the account is out of quota or credit. Add credit or raise the spend limit in the ${label} billing settings; no code change will fix this.`;
      case 'configured_model_unavailable':
        return `The model id the app is configured to use is not in ${label}'s live model list — it has been retired or misspelled. Update the model id to one of the models listed in the diagnosis findings.`;
      case 'rate_limit_headroom_low':
        return `The app is close to its ${label} rate limit. Add retry-with-backoff on the client, spread bursts out, or request a limit increase in the ${label} console.`;
      case 'provider_incident':
        return `${label} is reporting an ongoing incident on its status page. This is on the provider's side: nothing in the app is broken. Watch the status page and add retry-with-backoff so short incidents degrade instead of failing outright.`;
      default:
        return `Review the ${label} diagnosis findings and address the failing check.`;
    }
  }
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run src/__tests__/llm-provider-plan.test.ts`
Expected: PASS (4 tests, including the harness).

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/agent.ts src/__tests__/llm-provider-plan.test.ts
git commit -m "feat(llm-provider): add suggestion-only recovery plan and harness coverage"
```

---

### Task 7: Live client — request shape, error classification, key secrecy

**Files:**
- Create: `src/agent/llm-provider/live-client.ts`
- Modify: `src/cli/commands/scan.ts` (export `AGENT_TIMEOUT_MS`, one word — see Step 3)
- Test: `src/__tests__/llm-provider-live-client.test.ts`
- Test: `src/__tests__/llm-provider-secrecy.test.ts`

**Interfaces:**
- Consumes: `LlmProviderSpec`, `getProviderSpec`, `fingerprintKey`, `LlmProviderId` from `provider-table.js` (Task 1); every type from `backend.js` (Task 2).
- Produces:
  - `interface LlmProviderLiveConfig { provider: LlmProviderId; apiKey: string; configuredModel?: string | undefined; env?: NodeJS.ProcessEnv; timeoutMs?: number }`
  - `class LlmProviderLiveClient implements LlmProviderBackend` — `constructor(config: LlmProviderLiveConfig)`
  - `function classifyAuthFailure(httpStatus: number, errorType: string | undefined, message: string | undefined): KeyFailureKind` (exported for tests)
  - `function extractErrorInfo(body: unknown): { type?: string; message?: string }` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/llm-provider-live-client.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LlmProviderLiveClient,
  classifyAuthFailure,
  extractErrorInfo,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
} from '../agent/llm-provider/live-client.js';
import { getProviderSpec } from '../agent/llm-provider/provider-table.js';
import { AGENT_TIMEOUT_MS } from '../cli/commands/scan.js';

interface MockRoute {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Route requests by URL substring; records every request for assertions. */
function mockFetch(routes: Record<string, MockRoute>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, headers });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked fetch: ${url}`);
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers ?? {},
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyAuthFailure', () => {
  it('treats 401 as an invalid key', () => {
    expect(classifyAuthFailure(401, 'authentication_error', 'invalid x-api-key')).toBe('invalid_key');
  });

  it('separates a billing 403 from a permission 403', () => {
    expect(classifyAuthFailure(403, 'billing_error', 'credit balance is too low')).toBe('billing_or_quota');
    expect(classifyAuthFailure(403, 'permission_error', 'not allowed to use this resource')).toBe('permission');
  });

  it('separates OpenAI insufficient_quota from ordinary rate limiting', () => {
    expect(classifyAuthFailure(429, 'insufficient_quota', 'You exceeded your current quota')).toBe('billing_or_quota');
    expect(classifyAuthFailure(429, 'rate_limit_error', 'Number of requests has exceeded your limit')).toBe('rate_limited');
  });

  it('recognises a Gemini invalid key reported as a 400', () => {
    expect(classifyAuthFailure(400, 'API_KEY_INVALID', 'API key not valid. Please pass a valid API key.')).toBe('invalid_key');
  });

  it('falls back to "other" rather than guessing', () => {
    expect(classifyAuthFailure(500, undefined, undefined)).toBe('other');
  });
});

describe('extractErrorInfo', () => {
  it('reads the Anthropic error shape', () => {
    expect(extractErrorInfo({ type: 'error', error: { type: 'authentication_error', message: 'nope' } }))
      .toEqual({ type: 'authentication_error', message: 'nope' });
  });

  it('prefers OpenAI error.code over error.type', () => {
    expect(extractErrorInfo({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'no quota' } }).type)
      .toBe('insufficient_quota');
  });

  it('reads the Google error.status shape', () => {
    expect(extractErrorInfo({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } }))
      .toEqual({ type: 'PERMISSION_DENIED', message: 'denied' });
  });

  it('returns an empty object for a non-JSON-object body', () => {
    expect(extractErrorInfo('<html>502</html>')).toEqual({});
    expect(extractErrorInfo(null)).toEqual({});
  });
});

describe('LlmProviderLiveClient key presence', () => {
  it('reports the env var name and a last-4 fingerprint, never the key', async () => {
    const client = new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant-api03-SECRETSECRET-1234',
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRET-1234' } as NodeJS.ProcessEnv,
    });
    const presence = await client.checkKeyPresence();
    expect(presence.present).toBe(true);
    expect(presence.envVar).toBe('ANTHROPIC_API_KEY');
    expect(presence.fingerprint).toBe('…1234');
    expect(JSON.stringify(presence)).not.toContain('SECRETSECRET');
  });

  it('reports every env var it checked when no key is present', async () => {
    const client = new LlmProviderLiveClient({ provider: 'google', apiKey: '', env: {} as NodeJS.ProcessEnv });
    const presence = await client.checkKeyPresence();
    expect(presence.present).toBe(false);
    expect(presence.checkedEnvVars).toEqual(['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  });
});

describe('LlmProviderLiveClient key validity', () => {
  it('sends the Anthropic auth and version headers to the models endpoint', async () => {
    const { calls } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } } });
    const client = new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-test-key' });

    const validity = await client.checkKeyValidity();

    expect(validity.outcome).toBe('valid');
    expect(validity.httpStatus).toBe(200);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends a bearer token to the OpenAI models endpoint', async () => {
    const { calls } = mockFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai-test' }).checkKeyValidity();
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-openai-test');
  });

  it('authenticates OpenRouter against its key-info endpoint', async () => {
    const { calls } = mockFetch({
      'openrouter.ai/api/v1/key': { status: 200, body: { data: { label: 'k', limit: 100, limit_remaining: 60, usage: 40, is_free_tier: false } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-test' }).checkKeyValidity();
    expect(validity.outcome).toBe('valid');
    // Whichever path Task 1 Step 5's curl confirmed — assert against the table
    // rather than a hardcoded string, so this test follows the source of truth.
    expect(calls[0]!.url).toBe(getProviderSpec('openrouter')!.keyInfoUrl);
  });

  it('classifies a rejected key without echoing the key', async () => {
    mockFetch({
      'api.anthropic.com': { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-BADSECRET' }).checkKeyValidity();
    expect(validity.outcome).toBe('invalid_key');
    expect(validity.httpStatus).toBe(401);
    expect(validity.detail).toContain('401');
    expect(validity.detail).not.toContain('BADSECRET');
  });

  it('classifies an exhausted OpenAI quota as billing_or_quota', async () => {
    mockFetch({
      'api.openai.com': { status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } },
    });
    const validity = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai' }).checkKeyValidity();
    expect(validity.outcome).toBe('billing_or_quota');
  });

  it('reports unknown — not "down" — when the network call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.anthropic.com'); }));
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    expect(validity.outcome).toBe('unknown');
    expect(validity.httpStatus).toBeNull();
    expect(validity.detail).toContain('could not be reached');
    expect(validity.detail.toLowerCase()).not.toContain('is down');
  });

  it('reports unknown when there is no key to test, without calling the network', async () => {
    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: {} } });
    const validity = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: '' }).checkKeyValidity();
    expect(validity.outcome).toBe('unknown');
    expect(fn).not.toHaveBeenCalled();
  });

  it('makes exactly one authenticated request no matter how many checks run', async () => {
    const { fn } = mockFetch({
      'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } },
      'status.anthropic.com': { status: 200, body: { incidents: [] } },
    });
    const client = new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    await client.checkKeyValidity();
    await client.checkKeyValidity();
    const apiCalls = fn.mock.calls.filter((c) => String(c[0]).includes('api.anthropic.com'));
    expect(apiCalls).toHaveLength(1);
  });

  it('fits inside scan\'s per-agent budget and actually passes an abort signal', async () => {
    // If a request outlives AGENT_TIMEOUT_MS, scan substitutes an assessment
    // with signals: [] — which erases every checkId and the guidance keyed on
    // them. This assertion breaks loudly if either number moves.
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBeLessThan(AGENT_TIMEOUT_MS);

    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [] } } });
    await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never sends a POST — no billable inference call is ever made', async () => {
    const { fn } = mockFetch({ 'api.anthropic.com': { status: 200, body: { data: [] } } });
    await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkKeyValidity();
    for (const call of fn.mock.calls) {
      const method = (call[1] as RequestInit | undefined)?.method;
      expect(method === undefined || method === 'GET').toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run src/__tests__/llm-provider-live-client.test.ts`
Expected: FAIL — cannot resolve `../agent/llm-provider/live-client.js`.

- [ ] **Step 3: Write the live client**

First, in `src/cli/commands/scan.ts`, export the existing per-agent timeout constant so the budget relationship is checkable rather than a comment (line 51, add `export`):

```ts
/** Per-agent timeout for health checks during scan (ms). */
export const AGENT_TIMEOUT_MS = 2000;
```

Then create `src/agent/llm-provider/live-client.ts`:

```ts
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

/**
 * Page cap for a paginated models list (Google today). Each page is its own
 * request against DEFAULT_LLM_REQUEST_TIMEOUT_MS, so this bounds total
 * fetches per checkModel() call rather than any single request's deadline.
 * Requesting pageSize=1000 keeps the common case at one round-trip; the cap
 * exists so a pathological response can't turn one check into an unbounded
 * fetch loop.
 */
const MAX_MODEL_LIST_PAGES = 3;

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
  /** True when a `nextPageToken` was still present after MAX_MODEL_LIST_PAGES pages — the list may be incomplete. */
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run src/__tests__/llm-provider-live-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the no-key-leak test the design requires**

Create `src/__tests__/llm-provider-secrecy.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LlmProviderLiveClient } from '../agent/llm-provider/live-client.js';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

/** A distinctive fake key. If any of it reaches output, these tests fail. */
const SECRET = 'sk-ant-api03-DO-NOT-LEAK-THIS-VALUE-abcd';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
  );
}

describe('llm-provider key secrecy', () => {
  it('keeps key material out of every value the agent emits, in every scenario', async () => {
    const scenarios: Array<[number, unknown]> = [
      [200, { data: [{ id: 'claude-sonnet-4-5' }] }],
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
      [429, { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } }],
    ];

    for (const [status, body] of scenarios) {
      stubFetch(status, body, { 'anthropic-ratelimit-requests-remaining': '5', 'anthropic-ratelimit-requests-limit': '1000' });

      const backend = new LlmProviderLiveClient({
        provider: 'anthropic',
        apiKey: SECRET,
        env: { ANTHROPIC_API_KEY: SECRET } as NodeJS.ProcessEnv,
      });
      const agent = new LlmProviderDiagnosisAgent(backend, async () => null);
      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'cli-scan',
        payload: { instance: 'derived-llm-anthropic', severity: 'info' },
        receivedAt: new Date().toISOString(),
      };
      const context = assembleContext(trigger, agent.manifest);

      const health = await agent.assessHealth(context);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      const emitted = JSON.stringify({ health, diagnosis, plan });
      expect(emitted, `key leaked for HTTP ${status}`).not.toContain(SECRET);
      expect(emitted, `key body leaked for HTTP ${status}`).not.toContain('DO-NOT-LEAK-THIS-VALUE');
      // The fingerprint is the only key-derived value allowed out.
      expect(emitted).toContain('…abcd');
    }
  });

  it('keeps the key out of thrown errors when the provider misbehaves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const backend = new LlmProviderLiveClient({ provider: 'openai', apiKey: SECRET });
    const validity = await backend.checkKeyValidity();
    expect(JSON.stringify(validity)).not.toContain(SECRET);
  });

  it('never puts the key in a request URL', async () => {
    const fn = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fn);
    await new LlmProviderLiveClient({ provider: 'google', apiKey: SECRET }).checkKeyValidity();
    for (const call of fn.mock.calls) {
      expect(String(call[0])).not.toContain(SECRET);
    }
  });
});
```

- [ ] **Step 6: Run the secrecy test and verify it passes**

Run: `pnpm vitest run src/__tests__/llm-provider-secrecy.test.ts`
Expected: PASS (3 tests).

If the `…abcd` assertion fails for the 401/429 scenarios, that is correct behaviour to preserve — the fingerprint comes from `key_present`, which runs in every scenario. Investigate rather than deleting the assertion.

- [ ] **Step 7: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/live-client.ts src/cli/commands/scan.ts src/__tests__/llm-provider-live-client.test.ts src/__tests__/llm-provider-secrecy.test.ts
git commit -m "feat(llm-provider): add live client with error classification and key secrecy tests"
```

---

### Task 8: Live client — headroom, model list, provider status

**Files:**
- Modify: `src/agent/llm-provider/live-client.ts` (replace the three stubs, add helpers)
- Test: `src/__tests__/llm-provider-live-client-checks.test.ts`

**Interfaces:**
- Consumes: `HttpProbe`, `probeAuth`, `get`, `spec` from Task 7's class.
- Produces: real `checkRateLimitHeadroom()`, `checkModel()`, `checkProviderStatus()`; exported `function parseHeadroomFromHeaders(headers: Record<string, string>, prefix: string): { requestsRemainingPct: number | null; tokensRemainingPct: number | null }`; exported `function extractModelIds(body: unknown, shape: 'data_id' | 'models_name'): string[]`; a private `fetchModelList()` that follows `nextPageToken` for providers whose spec sets `paginated: true` (Google), capped at `MAX_MODEL_LIST_PAGES` (3).

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/llm-provider-live-client-checks.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LlmProviderLiveClient,
  parseHeadroomFromHeaders,
  extractModelIds,
} from '../agent/llm-provider/live-client.js';

function routeFetch(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked fetch: ${url}`);
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), { status: route.status, headers: route.headers ?? {} });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseHeadroomFromHeaders', () => {
  it('computes request and token percentages from an Anthropic response', () => {
    expect(parseHeadroomFromHeaders(
      {
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '250',
        'anthropic-ratelimit-tokens-limit': '80000',
        'anthropic-ratelimit-tokens-remaining': '8000',
      },
      'anthropic-ratelimit-',
    )).toEqual({ requestsRemainingPct: 25, tokensRemainingPct: 10 });
  });

  it('computes percentages from OpenAI headers', () => {
    expect(parseHeadroomFromHeaders(
      { 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '5' },
      'x-ratelimit-',
    ).requestsRemainingPct).toBe(1);
  });

  it('falls back to input-token headers when the plain token headers are absent', () => {
    expect(parseHeadroomFromHeaders(
      {
        'anthropic-ratelimit-input-tokens-limit': '100',
        'anthropic-ratelimit-input-tokens-remaining': '15',
      },
      'anthropic-ratelimit-',
    ).tokensRemainingPct).toBe(15);
  });

  it('returns nulls rather than guessing when headers are missing or zero-limit', () => {
    expect(parseHeadroomFromHeaders({}, 'anthropic-ratelimit-')).toEqual({ requestsRemainingPct: null, tokensRemainingPct: null });
    expect(parseHeadroomFromHeaders(
      { 'x-ratelimit-limit-requests': '0', 'x-ratelimit-remaining-requests': '0' },
      'x-ratelimit-',
    ).requestsRemainingPct).toBeNull();
  });
});

describe('extractModelIds', () => {
  it('reads the data[].id shape', () => {
    expect(extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }, 'data_id')).toEqual(['a', 'b']);
  });

  it('reads the Google models[].name shape and strips the models/ prefix', () => {
    expect(extractModelIds({ models: [{ name: 'models/gemini-2.5-pro' }] }, 'models_name')).toEqual(['gemini-2.5-pro']);
  });

  it('returns an empty list for an unexpected body', () => {
    expect(extractModelIds({ unexpected: true }, 'data_id')).toEqual([]);
    expect(extractModelIds(null, 'models_name')).toEqual([]);
  });
});

describe('LlmProviderLiveClient.checkRateLimitHeadroom', () => {
  it('reads headroom from the cached authenticated response', async () => {
    routeFetch({
      'api.anthropic.com': {
        status: 200,
        body: { data: [{ id: 'claude-sonnet-4-5' }] },
        headers: {
          'anthropic-ratelimit-requests-limit': '1000',
          'anthropic-ratelimit-requests-remaining': '120',
        },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBe(12);
    expect(headroom.detail).toContain('12%');
  });

  it('reports honest unknown for a provider that publishes no ratelimit headers', async () => {
    routeFetch({ 'generativelanguage.googleapis.com': { status: 200, body: { models: [] } } });
    const headroom = await new LlmProviderLiveClient({ provider: 'google', apiKey: 'g-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.requestsRemainingPct).toBeNull();
    expect(headroom.detail).toContain('does not publish');
  });

  it('derives OpenRouter headroom from remaining credit', async () => {
    routeFetch({
      'openrouter.ai/api/v1/key': {
        status: 200,
        body: { data: { label: 'k', limit: 200, limit_remaining: 10, usage: 190, is_free_tier: false } },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(true);
    expect(headroom.requestsRemainingPct).toBe(5);
    expect(headroom.detail).toContain('credit');
  });

  it('reports unknown for an OpenRouter key with no credit cap', async () => {
    routeFetch({
      'openrouter.ai/api/v1/key': {
        status: 200,
        body: { data: { label: 'k', limit: null, limit_remaining: null, usage: 12, is_free_tier: false } },
      },
    });
    const headroom = await new LlmProviderLiveClient({ provider: 'openrouter', apiKey: 'or-key' }).checkRateLimitHeadroom();
    expect(headroom.known).toBe(false);
    expect(headroom.detail).toContain('no credit limit');
  });
});

describe('LlmProviderLiveClient.checkModel', () => {
  it('confirms a configured model that exists in the live list', async () => {
    routeFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      configuredModel: 'claude-sonnet-4-5',
    }).checkModel();
    expect(model.source).toBe('config');
    expect(model.presentInList).toBe(true);
  });

  it('flags a configured model that is gone, and offers live ids', async () => {
    routeFetch({ 'api.anthropic.com': { status: 200, body: { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      configuredModel: 'claude-3-sonnet-20240229',
    }).checkModel();
    expect(model.presentInList).toBe(false);
    expect(model.sampleModels).toContain('claude-sonnet-4-5');
    expect(model.detail).toContain('mismatch');
  });

  it('falls back to the provider model env var when config declares none', async () => {
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    const model = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      env: { OPENAI_MODEL: 'gpt-4o' } as NodeJS.ProcessEnv,
    }).checkModel();
    expect(model.source).toBe('env');
    expect(model.configuredModel).toBe('gpt-4o');
    expect(model.presentInList).toBe(true);
  });

  it('distinguishes an unreadable model list from a genuinely empty one', async () => {
    // Unreadable: the check learned nothing.
    routeFetch({ 'api.openai.com': { status: 500, body: { error: { message: 'upstream error' } } } });
    const unreadable = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      configuredModel: 'gpt-4o',
    }).checkModel();
    expect(unreadable.listKnown).toBe(false);
    expect(unreadable.presentInList).toBeNull();
    expect(unreadable.detail).toContain('could not be read');

    // Readable but empty: the provider answered, and the configured model is
    // definitively not there. That is a real finding, not an unknown.
    vi.unstubAllGlobals();
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [] } } });
    const empty = await new LlmProviderLiveClient({
      provider: 'openai',
      apiKey: 'sk-openai',
      configuredModel: 'gpt-4o',
    }).checkModel();
    expect(empty.listKnown).toBe(true);
    expect(empty.presentInList).toBe(false);
    expect(empty.detail).toContain('returned an empty model list');
  });

  it('reports unknown — not a failure — when no model is configured anywhere', async () => {
    routeFetch({ 'api.openai.com': { status: 200, body: { data: [{ id: 'gpt-4o' }] } } });
    const model = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai', env: {} as NodeJS.ProcessEnv }).checkModel();
    expect(model.configuredModel).toBeNull();
    expect(model.presentInList).toBeNull();
    expect(model.detail).toContain('no model id');
  });

  it('fetches the public models list separately for OpenRouter', async () => {
    const fn = routeFetch({
      'openrouter.ai/api/v1/key': { status: 200, body: { data: { limit: null, limit_remaining: null } } },
      'openrouter.ai/api/v1/models': { status: 200, body: { data: [{ id: 'anthropic/claude-sonnet-4.5' }] } },
    });
    const model = await new LlmProviderLiveClient({
      provider: 'openrouter',
      apiKey: 'or-key',
      configuredModel: 'anthropic/claude-sonnet-4.5',
    }).checkModel();
    expect(model.presentInList).toBe(true);
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/v1/models'))).toBe(true);
  });

  it('follows Google nextPageToken to find a model beyond the first page', async () => {
    routeFetch({
      // Listed first: routeFetch's route matching is url.includes(key), and
      // Object.keys iterates in insertion order — this specific key must be
      // checked before the bare-host fallback below, or every call would
      // match the fallback instead.
      'pageToken=next-page-token': {
        status: 200,
        body: { models: [{ name: 'models/gemini-1.5-pro' }] },
      },
      'generativelanguage.googleapis.com': {
        status: 200,
        body: { models: [{ name: 'models/gemini-1.0-pro' }], nextPageToken: 'next-page-token' },
      },
    });
    const model = await new LlmProviderLiveClient({
      provider: 'google',
      apiKey: 'goog-key',
      configuredModel: 'gemini-1.5-pro',
    }).checkModel();
    expect(model.listKnown).toBe(true);
    expect(model.presentInList).toBe(true);
    expect(model.sampleModels).toContain('gemini-1.5-pro');
  });

  it('reports unknown, not deprecated, when the Google model list has more pages than the cap follows', async () => {
    // Every page returns a nextPageToken, so the loop exhausts
    // MAX_MODEL_LIST_PAGES (3) without ever reading a page containing the
    // configured model — this must never resolve to presentInList: false,
    // since the model might be on the page the check gave up before reaching.
    let page = 0;
    const fn = vi.fn(async () => {
      page += 1;
      return new Response(
        JSON.stringify({ models: [{ name: `models/filler-${page}` }], nextPageToken: `token-${page}` }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fn);
    const model = await new LlmProviderLiveClient({
      provider: 'google',
      apiKey: 'goog-key',
      configuredModel: 'gemini-1.5-pro',
    }).checkModel();
    expect(model.listKnown).toBe(false);
    expect(model.presentInList).toBeNull();
    expect(model.detail).toContain('more pages');
    expect(fn.mock.calls.length).toBe(3);
  });
});

describe('LlmProviderLiveClient.checkProviderStatus', () => {
  it('reports ongoing Statuspage incidents', async () => {
    routeFetch({
      'api.anthropic.com': { status: 200, body: { data: [] } },
      'status.anthropic.com': {
        status: 200,
        body: { incidents: [{ name: 'Elevated error rates', impact: 'major', shortlink: 'https://stspg.io/x', status: 'investigating' }] },
      },
    });
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toEqual([
      { title: 'Elevated error rates', impact: 'major', url: 'https://stspg.io/x' },
    ]);
  });

  it('ignores resolved Statuspage incidents', async () => {
    routeFetch({
      'api.anthropic.com': { status: 200, body: { data: [] } },
      'status.anthropic.com': { status: 200, body: { incidents: [{ name: 'Old outage', impact: 'minor', status: 'resolved' }] } },
    });
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.ongoingIncidents).toEqual([]);
    expect(status.detail).toContain('no ongoing incidents');
  });

  it('reads unresolved Google Cloud incidents for AI services only', async () => {
    routeFetch({
      'generativelanguage.googleapis.com': { status: 200, body: { models: [] } },
      'status.cloud.google.com': {
        status: 200,
        body: [
          { external_desc: 'Gemini API elevated errors', severity: 'medium', service_name: 'Gemini API', uri: 'incidents/abc' },
          { external_desc: 'Old Cloud SQL issue', severity: 'high', service_name: 'Cloud SQL', end: '2026-08-01T00:00:00Z' },
          { external_desc: 'Resolved Gemini issue', severity: 'low', service_name: 'Gemini API', end: '2026-08-02T00:00:00Z' },
        ],
      },
    });
    const status = await new LlmProviderLiveClient({ provider: 'google', apiKey: 'g-key' }).checkProviderStatus();
    expect(status.known).toBe(true);
    expect(status.ongoingIncidents).toHaveLength(1);
    expect(status.ongoingIncidents[0]!.title).toBe('Gemini API elevated errors');
  });

  it('reports unknown when the status endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).includes('status.')) throw new Error('ENOTFOUND');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const status = await new LlmProviderLiveClient({ provider: 'anthropic', apiKey: 'sk-ant' }).checkProviderStatus();
    expect(status.known).toBe(false);
    expect(status.ongoingIncidents).toEqual([]);
    expect(status.detail).toContain('could not be read');
  });

  it('reports unknown when the status body is not the shape we expect', async () => {
    routeFetch({
      'api.openai.com': { status: 200, body: { data: [] } },
      'status.openai.com': { status: 200, body: { unexpected: 'shape' } },
    });
    const status = await new LlmProviderLiveClient({ provider: 'openai', apiKey: 'sk-openai' }).checkProviderStatus();
    expect(status.known).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run src/__tests__/llm-provider-live-client-checks.test.ts`
Expected: FAIL — `parseHeadroomFromHeaders` is not exported, and the three checks return their "not implemented yet" stubs.

- [ ] **Step 3: Add the parsing helpers**

In `src/agent/llm-provider/live-client.ts`, add these exported functions below `classifyAuthFailure`:

```ts
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
```

- [ ] **Step 4: Replace the three stubs**

In `src/agent/llm-provider/live-client.ts`, replace the "Task 8 implements these three" block with:

```ts
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
```

Add these two module-level parsers below `extractModelIds` (they return `null` — meaning "unrecognised shape" — rather than an empty list, so an unexpected body is never read as "all clear"):

```ts
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
```

Add `ProviderIncident` to the type import from `./backend.js`.

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/llm-provider-live-client-checks.test.ts src/__tests__/llm-provider-live-client.test.ts src/__tests__/llm-provider-secrecy.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/live-client.ts src/__tests__/llm-provider-live-client-checks.test.ts
git commit -m "feat(llm-provider): read rate-limit headroom, model list, and provider status"
```

---

### Task 9: Registration and config wiring

**Files:**
- Create: `src/agent/llm-provider/registration.ts`
- Modify: `src/config/schema.ts` (add `LlmTargetOptions`, `TargetConfig.llm`, `ResolvedTarget.llm`)
- Modify: `src/config/resolve.ts` (pass `llm` through)
- Modify: `src/config/builtin-agents.ts` (import + register)
- Modify: `src/cli/errors.ts` (`SUPPORTED_KINDS`)
- Modify: `src/cli/commands/scan.ts` (`KIND_PREFIX`)
- Test: `src/__tests__/llm-provider-registration.test.ts`

**Interfaces:**
- Consumes: `createLiveRegistration` from `src/config/live-registration.js`; `llmProviderManifests` (Task 4); `LlmProviderDiagnosisAgent` (Task 5); `LlmProviderSimulator` (Task 3); `LlmProviderLiveClient` (Task 7); `getProviderSpec` (Task 1).
- Produces:
  - `interface LlmTargetOptions { provider?: string; model?: string }` — `provider` is now optional: the registration's own kind already names the provider, so `provider` is only needed to catch a target that has been misfiled under the wrong kind.
  - `function buildLlmProviderRegistration(providerId: LlmProviderId): AgentRegistration` (kind `llm-provider.<providerId>`, name `llm-provider-diagnosis`, manifest `llmProviderManifests[providerId]`)
  - Four built registrations exported by name (`anthropicRegistration`, `openaiRegistration`, `googleRegistration`, `openrouterRegistration`) plus `const llmProviderRegistrations: AgentRegistration[]` (provider-table order) for `builtin-agents.ts` to spread.
  - Finding-id prefix `LLM` for all four `llm-provider.<provider>` kinds.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/llm-provider-registration.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import {
  anthropicRegistration,
  googleRegistration,
  llmProviderRegistrations,
} from '../agent/llm-provider/registration.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LlmProviderLiveClient, DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '../agent/llm-provider/live-client.js';
import { AGENT_TIMEOUT_MS } from '../cli/commands/scan.js';
import { resolveTarget } from '../config/resolve.js';

const originalKey = process.env['ANTHROPIC_API_KEY'];
afterEach(() => {
  if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalKey;
});

describe('llm-provider registrations', () => {
  it('registers one built-in agent per provider-scoped kind', () => {
    expect(llmProviderRegistrations).toHaveLength(4);
    expect(llmProviderRegistrations.map((r) => r.kind)).toEqual([
      'llm-provider.anthropic',
      'llm-provider.openai',
      'llm-provider.google',
      'llm-provider.openrouter',
    ]);
    for (const kind of llmProviderRegistrations.map((r) => r.kind)) {
      expect(builtinAgents.map((a) => a.kind)).toContain(kind);
    }
    expect(llmProviderRegistrations.every((r) => r.name === 'llm-provider-diagnosis')).toBe(true);
  });

  it('gives each provider-scoped kind its own manifest maturity', () => {
    const maturity = (kind: string) =>
      builtinAgents.find((a) => a.kind === kind)!.manifest.metadata.plugin.maturity;
    expect(maturity('llm-provider.anthropic')).toBe('live_validated');
    expect(maturity('llm-provider.openai')).toBe('live_validated');
    expect(maturity('llm-provider.google')).toBe('simulator_only');
    expect(maturity('llm-provider.openrouter')).toBe('simulator_only');
  });

  it('keeps ai-provider registered for explicit config and demo mode', () => {
    expect(builtinAgents.map((a) => a.kind)).toContain('ai-provider');
  });

  it('uses the simulator for an explicit simulator target, bound to the registration\'s own provider', async () => {
    const target = resolveTarget({ name: 'demo', kind: 'llm-provider.google', primary: { host: 'simulator', port: 0 } });
    const instance = await googleRegistration.createAgent(target);
    expect(instance.backend).toBeInstanceOf(LlmProviderSimulator);
    // Regression guard: createLiveRegistration's loadSimulator constructs with
    // no arguments, so a naive re-export of LlmProviderSimulator would default
    // every provider's demo target to 'anthropic'. The google registration
    // must wrap the simulator so its demo target simulates google.
    expect((instance.backend as LlmProviderSimulator).getProviderId()).toBe('google');
  });

  it('builds a live client for a real target, carrying provider and model', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
      llm: { model: 'claude-sonnet-4-5' },
    });
    const instance = await anthropicRegistration.createAgent(target);
    expect(instance.backend).toBeInstanceOf(LlmProviderLiveClient);
    expect((instance.backend as LlmProviderLiveClient).getProviderId()).toBe('anthropic');
  });

  it('gives the live client a timeout that fits inside scan\'s per-agent budget', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    // The client keeps its config on a readonly field; assert the wiring rather
    // than re-deriving the number.
    const config = (instance.backend as unknown as { config: { timeoutMs?: number } }).config;
    expect(config.timeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(config.timeoutMs!).toBeLessThan(AGENT_TIMEOUT_MS);
  });

  it('defaults to its own provider when the target names none', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    expect((instance.backend as LlmProviderLiveClient).getProviderId()).toBe('anthropic');
  });

  it('fails loudly when the target\'s llm.provider conflicts with the registration\'s own kind', async () => {
    const target = resolveTarget({
      name: 'misfiled',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
      llm: { provider: 'openai' },
    });
    await expect(anthropicRegistration.createAgent(target)).rejects.toThrow(/llm-provider\.openai/);
  });

  it('does not throw when the key is absent — a missing key is a finding, not a crash', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    const presence = await (instance.backend as LlmProviderLiveClient).checkKeyPresence();
    expect(presence.present).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/llm-provider-registration.test.ts`
Expected: FAIL — cannot resolve `../agent/llm-provider/registration.js`.

- [ ] **Step 3: Add the target config option**

In `src/config/schema.ts`, add the interface next to `IacTargetOptions`:

```ts
export interface LlmTargetOptions {
  /**
   * Provider id: 'anthropic' | 'openai' | 'google' | 'openrouter'. Optional —
   * the target's kind (`llm-provider.<provider>`) already names the provider;
   * set this only to get a loud error if a target is ever misfiled under the
   * wrong provider's kind.
   */
  provider?: string;
  /** Model id the app uses. Falls back to the provider's model env var when omitted. */
  model?: string;
}
```

Add the field to `TargetConfig` (after `iac`):

```ts
  /** LLM provider options for llm-provider.<provider> targets. */
  llm?: LlmTargetOptions;
```

And to `ResolvedTarget` (after `iac`):

```ts
  /** LLM provider options for llm-provider.<provider> targets. */
  llm?: LlmTargetOptions | undefined;
```

In `src/config/resolve.ts`, add to the object returned by `resolveTarget`:

```ts
    llm: target.llm,
```

- [ ] **Step 4: Write the registration factory**

Create `src/agent/llm-provider/registration.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import type { AgentRegistration } from '../../config/agent-registration.js';
import { llmProviderManifests } from './manifest.js';
import { getProviderSpec, hasConfiguredKey, type LlmProviderId } from './provider-table.js';
import { LlmProviderSimulator } from './simulator.js';

/**
 * One registration per provider, each under its own `llm-provider.<provider>`
 * kind — see the design doc's Maturity claim for why the kind must be
 * provider-scoped rather than a single shared `llm-provider` kind.
 */
function buildLlmProviderRegistration(providerId: LlmProviderId): AgentRegistration {
  const spec = getProviderSpec(providerId)!; // always defined — providerId is a valid LlmProviderId by construction

  return createLiveRegistration({
    kind: `llm-provider.${providerId}`,
    name: 'llm-provider-diagnosis',
    manifest: llmProviderManifests[providerId],
    loadAgent: async () => {
      const { LlmProviderDiagnosisAgent } = await import('./agent.js');
      return LlmProviderDiagnosisAgent as never;
    },
    // createLiveRegistration's loadSimulator contract constructs with no
    // arguments, so a demo target under this kind must get a simulator
    // already bound to this provider — otherwise every provider's demo
    // target would silently simulate 'anthropic' (LlmProviderSimulator's
    // default).
    loadSimulator: async () => {
      class BoundSimulator extends LlmProviderSimulator {
        constructor() {
          super('healthy', providerId);
        }
      }
      return BoundSimulator as never;
    },
    buildLiveBackend: async (target) => {
      if (target.llm?.provider !== undefined && target.llm.provider !== providerId) {
        throw new Error(
          `Target "${target.name}" is registered under kind "llm-provider.${providerId}" but its llm.provider is "llm-provider.${target.llm.provider}". Either use kind "llm-provider.${target.llm.provider}" for this target, or drop llm.provider to default to ${providerId}.`,
        );
      }

      // A missing key is a finding (key_present), not a construction failure —
      // an empty apiKey makes the client report it honestly instead of throwing.
      const envVar = spec.envVars.find((name) => hasConfiguredKey(process.env, name));

      const { LlmProviderLiveClient, DEFAULT_LLM_REQUEST_TIMEOUT_MS } = await import('./live-client.js');
      return new LlmProviderLiveClient({
        provider: spec.id,
        apiKey: envVar ? process.env[envVar]! : '',
        // Set explicitly, not left to the constructor default: scan gives each
        // agent 2000ms and replaces a timed-out assessment with an empty-signal
        // one, which would drop every checkId this agent exists to emit.
        timeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        ...(target.llm?.model !== undefined ? { configuredModel: target.llm.model } : {}),
      });
    },
  });
}

export const anthropicRegistration = buildLlmProviderRegistration('anthropic');
export const openaiRegistration = buildLlmProviderRegistration('openai');
export const googleRegistration = buildLlmProviderRegistration('google');
export const openrouterRegistration = buildLlmProviderRegistration('openrouter');

/** Provider-table order; builtin-agents.ts spreads this array. */
export const llmProviderRegistrations: AgentRegistration[] = [
  anthropicRegistration,
  openaiRegistration,
  googleRegistration,
  openrouterRegistration,
];
```

- [ ] **Step 5: Register the four agents and teach the CLI their kinds**

In `src/config/builtin-agents.ts`, add the import next to the other AI agents:

```ts
import { llmProviderRegistrations } from '../agent/llm-provider/registration.js';
```

and spread it into the array, in the `// AI application recovery agents` group, immediately **before** `aiProviderRegistration`:

```ts
  ...llmProviderRegistrations,
```

In `src/cli/errors.ts`, add the four kinds to `SUPPORTED_KINDS`:

```ts
const SUPPORTED_KINDS = [
  'postgresql', 'redis', 'etcd', 'kafka', 'kubernetes', 'ceph', 'flink',
  'application', 'llm-provider.anthropic', 'llm-provider.openai', 'llm-provider.google', 'llm-provider.openrouter',
  'ai-provider', 'managed-database', 'message-queue', 'application-config',
];
```

In `src/cli/commands/scan.ts`, add four finding-id prefix entries next to the existing `'ai-provider': 'AI',` entry — all four share the `LLM` prefix, matching the single shared prefix `'ai-provider': 'AI'` already uses for one kind, since the finding-id prefix identifies "this is an LLM-provider finding," not which of the four providers:

```ts
  'llm-provider.anthropic': 'LLM',
  'llm-provider.openai': 'LLM',
  'llm-provider.google': 'LLM',
  'llm-provider.openrouter': 'LLM',
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/llm-provider-registration.test.ts src/__tests__/explanation-coverage.test.ts
```
Expected: PASS. (`explanation-coverage` now exercises the four `llm-provider.<provider>` rows added in Task 4.)

- [ ] **Step 7: Run the full suite, typecheck, lint, and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add src/agent/llm-provider/registration.ts src/config/schema.ts src/config/resolve.ts src/config/builtin-agents.ts src/cli/errors.ts src/cli/commands/scan.ts src/__tests__/llm-provider-registration.test.ts
git commit -m "feat(llm-provider): register the agent and add llm target options"
```

---

### Task 10: Autodiscovery switches from `ai-provider` to per-provider `llm-provider.<provider>`

**Files:**
- Modify: `src/cli/autodiscovery.ts` (import, `AI_PROVIDER_DEPS`, `deriveGatedTargets`, `detectAiProviders`)
- Modify: `src/agent/ai-provider/provider-table.ts` (re-export `AI_ENV_VARS`)
- Modify: `src/__tests__/ai-provider-table.test.ts` (the `AI_ENV_VARS mirrors the probe table` assertion)
- Modify: `src/__tests__/autodiscovery-gated-targets.test.ts` (replace the two ai-provider cases)
- Test: `src/__tests__/autodiscovery-gated-targets.test.ts`, `src/__tests__/autodiscovery.test.ts`

**Interfaces:**
- Consumes: `AI_ENV_VARS`, `detectConfiguredProviders` from `src/agent/llm-provider/provider-table.js` (Task 1); `LlmTargetOptions` via `TargetConfig` (Task 9).
- Produces: derived targets named `derived-llm-<provider>` of kind `llm-provider.<provider>` (matching the registration's own kind from Task 9 — no blanket `llm-provider` kind), each with `llm: { provider }`, `primary: { host: <apiHost>, port: 443 }`, and note `from <ENV_VAR>`. `derived-ai-provider` no longer exists.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/autodiscovery-gated-targets.test.ts`, **replace** the two tests `derives ai-provider from an API key even without SDK deps` and `derives ai-provider from an SDK dep even without keys` with:

```ts
  it('derives one target per detected provider key, each under its own provider-scoped kind', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(
      stack([]),
      dir,
      { ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv,
    );

    const llm = gated.targets.filter((t) => t.kind.startsWith('llm-provider.'));
    expect(llm.map((t) => t.name)).toEqual(['derived-llm-anthropic', 'derived-llm-google']);
    expect(llm.map((t) => t.kind)).toEqual(['llm-provider.anthropic', 'llm-provider.google']);
    expect(llm[0]!.llm).toEqual({ provider: 'anthropic' });
    expect(llm[0]!.primary).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(gated.notes['derived-llm-anthropic']).toBe('from ANTHROPIC_API_KEY');
    expect(gated.notes['derived-llm-google']).toBe('from GEMINI_API_KEY');
  });

  it('no longer derives a derived-ai-provider target, and never a blanket llm-provider kind', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(
      stack(['@anthropic-ai/sdk']),
      dir,
      { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv,
    );
    expect(gated.targets.find((t) => t.kind === 'ai-provider')).toBeUndefined();
    expect(gated.targets.find((t) => t.name === 'derived-ai-provider')).toBeUndefined();
    expect(gated.targets.find((t) => t.kind === 'llm-provider')).toBeUndefined();
  });

  it('derives nothing from an SDK dependency alone — a key in .env is not a missing key', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack(['@anthropic-ai/sdk']), dir, {} as NodeJS.ProcessEnv);
    expect(gated.targets.filter((t) => t.kind.startsWith('llm-provider.'))).toEqual([]);
  });

  it('never puts key material in a derived target name or note', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack([]), dir, { OPENAI_API_KEY: 'sk-supersecret' } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify({ targets: gated.targets, notes: gated.notes });
    expect(serialized).not.toContain('sk-supersecret');
  });
```

In `src/__tests__/autodiscovery.test.ts`, add this test to the "AI provider detection" group:

```ts
  it('reports one entry per provider even when several of its key env vars are set', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.GOOGLE_API_KEY = 'g-key-2';
    // Pin the package.json read explicitly rather than inheriting whatever the
    // previous test left on the shared mock.
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({});
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    const google = profile.aiProviders.filter((p) => p.provider === 'google');
    expect(google).toHaveLength(1);
    expect(google[0]!.configured).toBe(true);
    expect(google[0]!.envVar).toBe('GEMINI_API_KEY');

    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  it('treats a set-but-empty key as unconfigured, consistently with target derivation', async () => {
    process.env.OPENAI_API_KEY = '';
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ openai: '^4.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    const openai = profile.aiProviders.find((p) => p.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.configured).toBe(false);

    delete process.env.OPENAI_API_KEY;
  });
```

In `src/__tests__/ai-provider-table.test.ts`, **replace** the `AI_ENV_VARS mirrors the probe table` test with:

```ts
  it('AI_ENV_VARS is re-exported from the llm-provider table and still covers every probe-table provider', () => {
    const names = AI_ENV_VARS.map((v) => v.envVar);
    for (const spec of PROVIDER_PROBE_TABLE) {
      expect(names, `${spec.provider} key missing from AI_ENV_VARS`).toContain(spec.envVar);
    }
    expect(AI_ENV_VARS.map((v) => v.provider)).toContain('openai');
    // The llm-provider table adds google's alternate key names.
    expect(names).toContain('GEMINI_API_KEY');
    expect(names.length).toBeGreaterThan(PROVIDER_PROBE_TABLE.length);
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
pnpm vitest run src/__tests__/autodiscovery-gated-targets.test.ts src/__tests__/ai-provider-table.test.ts
```
Expected: FAIL — targets are still `derived-ai-provider`, and `AI_ENV_VARS` still has one entry per probe-table row.

- [ ] **Step 3: Re-export `AI_ENV_VARS` from the llm-provider table**

In `src/agent/ai-provider/provider-table.ts`, delete the local `AI_ENV_VARS` definition (the `/** Env-var detection list, derived from the probe table (single source of truth). */` block) and replace it with a re-export, updating the file header comment:

```ts
/**
 * Static probe table for known AI providers: health endpoint, auth shape,
 * and the env var carrying the API key. Drives ai-provider's live probing for
 * explicitly configured targets and demo mode.
 *
 * NOTE: the AI env-var detection list is no longer defined here. It lives in
 * src/agent/llm-provider/provider-table.ts (one source of truth for every
 * consumer) and is re-exported below for compatibility.
 *
 * SECURITY: API keys are read from env at backend-creation time and passed
 * directly to the live client. Never logged.
 */
```

and, after the `PROVIDER_PROBE_TABLE` declaration:

```ts
/** Env-var detection list — single source of truth lives with the llm-provider agent. */
export { AI_ENV_VARS } from '../llm-provider/provider-table.js';
```

- [ ] **Step 4: Switch the derivation in autodiscovery**

In `src/cli/autodiscovery.ts`, change the import on line 22 to pull both helpers from the new table:

```ts
import { AI_ENV_VARS, detectConfiguredProviders, hasConfiguredKey } from '../agent/llm-provider/provider-table.js';
```

Extend `AI_PROVIDER_DEPS` with the two SDK packages the current map misses. **Verify both package names before adding them** — a wrong name is a silently dead detection branch, and these are the entries that drive Task 13's blocked-visibility row:

```bash
npm view @google/genai name version --json
npm view @openrouter/ai-sdk-provider name version --json
# Only if this one also resolves, add it as a second openrouter entry:
npm view @openrouter/sdk name version --json
```

Add only the names that resolve:

```ts
const AI_PROVIDER_DEPS: Record<string, string> = {
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  'cohere-ai': 'cohere',
  '@google/generative-ai': 'google',
  '@google/genai': 'google',
  '@openrouter/ai-sdk-provider': 'openrouter',
  '@mistralai/mistralai': 'mistral',
  '@huggingface/inference': 'huggingface',
  'replicate': 'replicate',
};
```

In `deriveGatedTargets`, replace the whole `// ai-provider: an API key present OR an AI SDK dependency` block (lines ~384-395) with:

```ts
  // llm-provider.<provider>: one target per provider whose API key is in this
  // environment, under that provider's own kind — never a blanket
  // 'llm-provider' kind (see the design doc's Maturity claim for why).
  // Deliberately NOT derived from an SDK dependency alone: a vibe coder's key
  // usually lives in .env, which CrisisMode does not read, so "dep but no key"
  // would produce a false "your key is missing" alarm. That case surfaces as a
  // visibility entry instead (see aiKeyBlockedEntries in scan.ts).
  for (const { provider, envVar, spec } of detectConfiguredProviders(env)) {
    const target: TargetConfig = {
      name: `derived-llm-${provider}`,
      kind: `llm-provider.${provider}`,
      primary: { host: spec.apiHost, port: 443 },
      llm: { provider },
    };
    targets.push(target);
    notes[target.name] = `from ${envVar}`;
  }
```

Replace `detectAiProviders` (lines ~601-618) with a provider-deduped version — env-configured providers first, so a provider with several key env vars is never reported twice or reported as unconfigured when one of its keys is set. Note it uses the **same `hasConfiguredKey` predicate as `detectConfiguredProviders`**: if these two disagreed about whether `FOO_API_KEY=` counts, a provider could be reported as configured while no target was derived for it:

```ts
function detectAiProviders(appStack: AppStackInfo): AiProviderInfo[] {
  const providers: AiProviderInfo[] = [];
  const seen = new Set<string>();

  // Pass 1: providers with a key in the environment.
  for (const { envVar, provider } of AI_ENV_VARS) {
    if (seen.has(provider) || !hasConfiguredKey(process.env, envVar)) continue;
    seen.add(provider);
    providers.push({ provider, configured: true, envVar });
  }

  // Pass 2: providers detected from an SDK dependency but with no key here.
  for (const { envVar, provider } of AI_ENV_VARS) {
    if (seen.has(provider)) continue;
    if (!appStack.dependencies.some((d) => AI_PROVIDER_DEPS[d] === provider)) continue;
    seen.add(provider);
    providers.push({ provider, configured: false, envVar });
  }

  return providers;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/autodiscovery-gated-targets.test.ts src/__tests__/autodiscovery.test.ts src/__tests__/ai-provider-table.test.ts src/__tests__/visibility.test.ts
```
Expected: PASS. `visibility.test.ts` still uses a hand-built `derived-ai-provider` profile fixture — that is a unit fixture for the report builder, not a claim about autodiscovery, so leave it alone.

- [ ] **Step 6: Run the full suite, typecheck, lint, and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add src/cli/autodiscovery.ts src/agent/ai-provider/provider-table.ts src/__tests__/autodiscovery-gated-targets.test.ts src/__tests__/autodiscovery.test.ts src/__tests__/ai-provider-table.test.ts
git commit -m "feat(cli): derive llm-provider targets per provider and retire derived-ai-provider"
```

---

### Task 11: `checkId` on the scan finding shape

**Files:**
- Modify: `src/cli/output.ts` (`ScanFinding`)
- Modify: `src/cli/commands/scan.ts` (`checkTargetHealth`, new `dominantCheckId`)
- Test: `src/__tests__/scan-check-id.test.ts`

**Interfaces:**
- Consumes: `HealthSignal.checkId` (Task 2); the llm-provider agent's signals (Task 5).
- Produces:
  - `ScanFinding.checkId?: string` and `ScanFinding.signals[].checkId?: string`
  - `export function dominantCheckId(signals: Array<{ status: string; checkId?: string }>): string | undefined` in `src/cli/commands/scan.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/scan-check-id.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { checkTargetHealth, dominantCheckId } from '../cli/commands/scan.js';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import type { TargetConfig } from '../config/schema.js';

describe('dominantCheckId', () => {
  it('prefers the first failing signal that carries a check id', () => {
    expect(dominantCheckId([
      { status: 'healthy', checkId: 'llm-provider.key_present' },
      { status: 'critical', checkId: 'llm-provider.key_valid' },
      { status: 'warning', checkId: 'llm-provider.provider_status' },
    ])).toBe('llm-provider.key_valid');
  });

  it('falls back to the first signal with a check id when nothing is failing', () => {
    expect(dominantCheckId([{ status: 'healthy', checkId: 'llm-provider.key_present' }]))
      .toBe('llm-provider.key_present');
  });

  it('returns undefined for agents that have not adopted check ids', () => {
    expect(dominantCheckId([{ status: 'critical' }])).toBeUndefined();
    expect(dominantCheckId([])).toBeUndefined();
  });
});

describe('checkTargetHealth check ids', () => {
  const target: TargetConfig = {
    name: 'derived-llm-anthropic',
    kind: 'llm-provider.anthropic',
    primary: { host: 'simulator', port: 0 },
  };

  function registry(scenario: 'bad_key' | 'healthy') {
    return {
      supportedKinds: () => ['llm-provider.anthropic'],
      createForTarget: async () => {
        const backend = new LlmProviderSimulator(scenario, 'anthropic');
        return { agent: new LlmProviderDiagnosisAgent(backend, async () => null), backend, target: target as never };
      },
    };
  }

  it('carries the failing check id on the finding and on each signal', async () => {
    const result = await checkTargetHealth(target, registry('bad_key') as never);
    expect(result.finding.checkId).toBe(LLM_PROVIDER_CHECK_IDS.keyValid);
    expect(result.finding.signals.map((s) => s.checkId)).toContain(LLM_PROVIDER_CHECK_IDS.quotaBilling);
  });

  it('leaves checkId undefined for a healthy-but-unadopted agent shape', async () => {
    const plainRegistry = {
      supportedKinds: () => ['llm-provider.anthropic'],
      createForTarget: async () => ({
        agent: {
          manifest: new LlmProviderDiagnosisAgent().manifest,
          assessHealth: async () => ({
            status: 'healthy' as const,
            confidence: 1,
            summary: 'ok',
            observedAt: new Date().toISOString(),
            signals: [{ source: 'legacy_signal', status: 'healthy' as const, detail: 'fine', observedAt: new Date().toISOString() }],
            recommendedActions: [],
          }),
          diagnose: async () => ({ status: 'inconclusive' as const, scenario: null, confidence: 1, findings: [], diagnosticPlanNeeded: false }),
        },
        backend: { close: async () => {} },
        target: target as never,
      }),
    };
    const result = await checkTargetHealth(target, plainRegistry as never);
    expect(result.finding.checkId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/scan-check-id.test.ts`
Expected: FAIL — `dominantCheckId` is not exported from `../cli/commands/scan.js`.

- [ ] **Step 3: Add the field to the finding shape**

In `src/cli/output.ts`, make two **additive** edits to `ScanFinding` — do not retype the whole interface, because PR 1 added `bestEffort?: boolean` and PR 2 added `possiblyObserverCaused?: boolean` to it and both must survive.

Change the `signals` line to allow a per-signal check id:

```ts
  signals: Array<{ status: string; detail: string; source?: string; checkId?: string }>;
```

and add one new optional field at the end of the interface:

```ts
  /** Stable id of the check behind the dominant signal (e.g. 'llm-provider.key_valid'). Present only for agents that emit check ids. */
  checkId?: string;
```

Human and pipe output are unchanged — pipe mode's tab-separated columns are a fixed contract, and `checkId` is a machine-mode field. Machine mode serialises the whole `ScanResult`, so it appears there automatically.

- [ ] **Step 4: Derive the finding-level check id**

In `src/cli/commands/scan.ts`, add the helper next to `enrichScanFinding`:

```ts
/**
 * The check id a finding should carry: the first failing signal's, falling
 * back to the first signal that has one. Mirrors how enrichScanFinding picks
 * the dominant signal for the plain-language explanation, so the explanation
 * and the check id always describe the same signal.
 */
export function dominantCheckId(
  signals: Array<{ status: string; checkId?: string }>,
): string | undefined {
  const failing = signals.find((s) => s.status !== 'healthy' && s.checkId !== undefined);
  if (failing) return failing.checkId;
  return signals.find((s) => s.checkId !== undefined)?.checkId;
}
```

In `checkTargetHealth`, change the signal mapping and add the finding-level id (the success path only — the catch path has no signals):

```ts
    const signals = health.signals.map((s) => ({
      status: s.status,
      detail: s.detail,
      source: s.source,
      ...(s.checkId !== undefined ? { checkId: s.checkId } : {}),
    }));
    const checkId = dominantCheckId(signals);

    return {
      kind: target.kind,
      health,
      agentAvailable,
      finding: {
        service: `${target.kind} (${target.name})`,
        status: health.status,
        summary: health.summary,
        confidence: health.confidence,
        escalationLevel: health.status === 'healthy' ? 1 : 2,
        signals,
        ...(checkId !== undefined ? { checkId } : {}),
      },
    };
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/scan-check-id.test.ts src/__tests__/cli-output.test.ts src/__tests__/cli-snapshots.test.ts
```
Expected: PASS. If a snapshot changed, inspect the diff first — only additive `checkId` fields in machine output are acceptable; a changed human line means something else moved.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/cli/output.ts src/cli/commands/scan.ts src/__tests__/scan-check-id.test.ts
git commit -m "feat(cli): carry stable check ids on scan findings"
```

---

### Task 12: Regression test — per-provider kinds already give one watching row per provider

**Files:**
- Test only: `src/__tests__/visibility.test.ts` (append)
- No source change to `src/cli/visibility.ts`.

**Interfaces:**
- Consumes: `StackProfile.derivedTargets` / `derivedNotes` (Task 10 puts one `llm-provider.<provider>` target per detected provider there, each under its own kind).
- Produces: no new exports.

**Why this task shrank to a regression test.** An earlier version of this plan had `buildVisibilityReport` derive several targets under one shared `llm-provider` kind, which would have broken its `profile.derivedTargets.find((t) => t.kind === kind)` lookup (`find` returns only the first match, silently hiding every other provider's coverage). Task 9's Maturity claim forced kinds to be per-provider instead — `llm-provider.anthropic`, `llm-provider.google`, etc. — for a different reason (maturity buckets), but it has the side effect of fixing this problem too: **at most one derived target can ever share a kind now**, so the existing one-row-per-kind code in `visibility.ts` is already correct. This task exists to pin that with a test, not to change `buildVisibilityReport`.

- [ ] **Step 1: Write the regression test**

Append to `src/__tests__/visibility.test.ts`:

```ts
  it('gives each provider its own watching row for free, because each has its own kind', () => {
    const profile = makeProfile({
      derivedTargets: [
        { name: 'derived-llm-anthropic', kind: 'llm-provider.anthropic', primary: { host: 'api.anthropic.com', port: 443 }, llm: { provider: 'anthropic' } },
        { name: 'derived-llm-google', kind: 'llm-provider.google', primary: { host: 'generativelanguage.googleapis.com', port: 443 }, llm: { provider: 'google' } },
      ],
      derivedNotes: {
        'derived-llm-anthropic': 'from ANTHROPIC_API_KEY',
        'derived-llm-google': 'from GOOGLE_AI_API_KEY',
      },
    });

    const report = buildVisibilityReport(profile, ['llm-provider.anthropic', 'llm-provider.google'], 'none');

    const rows = report.watching.filter((e) => e.label.startsWith('llm-provider.'));
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.label)).toEqual(['llm-provider.anthropic', 'llm-provider.google']);
    expect(rows.map((e) => e.detail)).toEqual(['from ANTHROPIC_API_KEY', 'from GOOGLE_AI_API_KEY']);
  });

  it('never collapses two providers onto one row, even if a caller mistakenly passes a shared kind twice', () => {
    // Defence in depth: if `ranKinds` ever repeated a kind, the loop must not
    // duplicate or drop rows. This does not exercise per-provider behaviour —
    // it just confirms the existing one-row-per-kind loop is idempotent.
    const profile = makeProfile({
      derivedTargets: [
        { name: 'derived-llm-anthropic', kind: 'llm-provider.anthropic', primary: { host: 'api.anthropic.com', port: 443 }, llm: { provider: 'anthropic' } },
      ],
      derivedNotes: { 'derived-llm-anthropic': 'from ANTHROPIC_API_KEY' },
    });

    const report = buildVisibilityReport(profile, ['llm-provider.anthropic', 'llm-provider.anthropic'], 'none');
    const rows = report.watching.filter((e) => e.label === 'llm-provider.anthropic');
    expect(rows).toHaveLength(2); // one per ranKinds entry — ranKinds itself is expected to be deduped upstream, this only pins today's loop behaviour
  });
```

> If PR 1 added a `maturityByKind` argument to `buildVisibilityReport`, pass whatever the neighbouring tests in this file pass — do not change the call shape PR 1 established.

- [ ] **Step 2: Run the test and verify it passes without touching `visibility.ts`**

```bash
pnpm vitest run src/__tests__/visibility.test.ts
```
Expected: PASS immediately — this is a regression test for behaviour Task 9's per-provider kinds already produce, not a new feature. If it fails, something upstream (Task 9 or Task 10) is still using a shared `llm-provider` kind; fix that instead of `visibility.ts`.

- [ ] **Step 3: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/__tests__/visibility.test.ts
git commit -m "test(cli): pin that per-provider kinds give llm-provider its own watching row per provider"
```

---

### Task 13: Visibility entry for an AI SDK with no key in the environment

**Files:**
- Modify: `src/cli/commands/scan.ts` (new `aiKeyBlockedEntries`, wired into the `buildVisibilityReport` call)
- Create: `src/__tests__/scan-ai-key-visibility.test.ts`

**Interfaces:**
- Consumes: `StackProfile.aiProviders` (`Array<{ provider: string; configured: boolean; envVar: string }>`) from `src/cli/autodiscovery.js`; `VisibilityEntry` from `src/cli/visibility.js`.
- Produces: `export function aiKeyBlockedEntries(profile: Pick<StackProfile, 'aiProviders'>): VisibilityEntry[]`.

**This preserves existing behaviour across the boundary change rather than adding scope.** Today an AI SDK dependency alone derives a `derived-ai-provider` target, so the provider appears in the visibility report's watching list. Task 10 stops deriving that target (a key in `.env` would otherwise produce a false "your key is missing" finding), which would silently drop the provider out of the report entirely — the user would see *less* than before. This task keeps it visible, moved to the bucket that matches what CrisisMode actually knows: found, not checkable, with the reason. "Found but cannot check" is exactly the blocked bucket, and unlike an unhealthy finding it does not accuse a working app of being broken.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/scan-ai-key-visibility.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { aiKeyBlockedEntries } from '../cli/commands/scan.js';

describe('aiKeyBlockedEntries', () => {
  it('reports a detected provider whose key is not in this environment', () => {
    const entries = aiKeyBlockedEntries({
      aiProviders: [{ provider: 'anthropic', configured: false, envVar: 'ANTHROPIC_API_KEY' }],
    });

    expect(entries).toHaveLength(1);
    // Matches the kind-as-label format the watching rows use (Task 12) —
    // 'llm-provider.anthropic', not a parenthesised family name — so watching
    // and blocked rows for the same provider read as the same thing.
    expect(entries[0]!.label).toBe('llm-provider.anthropic');
    expect(entries[0]!.detail).toContain('ANTHROPIC_API_KEY');
    expect(entries[0]!.hint).toContain('.env');
  });

  it('says nothing about a provider whose key is present — that one is watched', () => {
    expect(aiKeyBlockedEntries({
      aiProviders: [{ provider: 'openai', configured: true, envVar: 'OPENAI_API_KEY' }],
    })).toEqual([]);
  });

  it('returns nothing when no AI provider was detected at all', () => {
    expect(aiKeyBlockedEntries({ aiProviders: [] })).toEqual([]);
  });

  it('never includes key material — it only ever sees names', () => {
    const entries = aiKeyBlockedEntries({
      aiProviders: [{ provider: 'google', configured: false, envVar: 'GOOGLE_AI_API_KEY' }],
    });
    expect(JSON.stringify(entries)).not.toMatch(/sk-|AIza/);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run src/__tests__/scan-ai-key-visibility.test.ts`
Expected: FAIL — `aiKeyBlockedEntries` is not exported.

- [ ] **Step 3: Write the function and wire it in**

In `src/cli/commands/scan.ts`, add below `iamBlockedEntries`:

```ts
/**
 * Providers whose SDK is a dependency but whose key is not in this process's
 * environment. CrisisMode reads process.env only, so a key living in .env is
 * invisible here — reporting that as an unhealthy finding would accuse a
 * perfectly working app of being broken. It belongs in the blocked bucket:
 * found, not checkable, with the reason.
 *
 * SECURITY: only env var NAMES reach this function.
 */
export function aiKeyBlockedEntries(profile: Pick<StackProfile, 'aiProviders'>): VisibilityEntry[] {
  return profile.aiProviders
    .filter((p) => !p.configured)
    .map((p) => ({
      // Label format matches the watching rows' label (the kind itself, e.g.
      // 'llm-provider.anthropic' — see Task 12), so the same provider reads
      // identically whether it ends up watched or blocked.
      label: `llm-provider.${p.provider}`,
      detail: `your project depends on the ${p.provider} SDK, but ${p.envVar} is not set in this environment`,
      hint: `CrisisMode reads process.env only — it never parses .env files. Export the key (or run CrisisMode from the same environment as your app) to enable live ${p.provider} checks.`,
    }));
}
```

Add `StackProfile` to the type imports at the top of the file:

```ts
import type { StackProfile } from '../autodiscovery.js';
```

(`discoverStack` is already imported from that module; add the type to the existing import line if one exists, otherwise add this line next to it.)

Then extend the `buildVisibilityReport` call in `runScan`:

```ts
  result.visibility = buildVisibilityReport(stackProfile, ranKinds, configSource, [
    ...iamBlockedEntries(findings),
    ...aiKeyBlockedEntries(stackProfile),
  ]);
```

> **PR 1 note:** if PR 1 added a `maturityByKind` parameter to `buildVisibilityReport`, keep that argument exactly as PR 1 left it and only replace the `extraBlocked` argument.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm vitest run src/__tests__/scan-ai-key-visibility.test.ts src/__tests__/visibility.test.ts
```
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/cli/commands/scan.ts src/__tests__/scan-ai-key-visibility.test.ts
git commit -m "feat(cli): surface AI SDKs whose key is absent from the environment"
```

---

### Task 14: Documentation and live validation at the real surface

**Files:**
- Modify: `README.md` (the "Modern Application Incidents" table)
- Modify: `CLAUDE.md` (the Key Files table)
- Test: none new — this task's deliverable is verified behaviour plus the full suite

**Interfaces:**
- Consumes: everything shipped in Tasks 1–13.
- Produces: accurate documentation of what shipped, and a recorded per-provider validation status.

- [ ] **Step 1: Update the README agent table**

In `README.md`, in the **Modern Application Incidents** table, add a row above the existing AI Provider row and rewrite that row so its scope is honest:

```markdown
| LLM provider failures (key, quota, rate limit, model, outage) | LLM Provider | Live (diagnosis only) -- validated against real Anthropic and OpenAI keys; Google and OpenRouter paths implemented, best-effort validated |
| AI provider degradation / failover | AI Provider | Simulator -- explicit config and demo only; no longer auto-detected from API keys |
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, in the Key Files table, add a row immediately above the `src/agent/ai-provider/` row:

```markdown
| `src/agent/llm-provider/` | LLM provider diagnosis agent — API key, quota/billing, rate-limit headroom, model deprecation, provider status |
```

and change the `ai-provider` row's description to:

```markdown
| `src/agent/ai-provider/` | AI service failover and fallback agent (explicit config and demo only) |
```

- [ ] **Step 3: Run the whole suite and both gates**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
```
Expected: all green. Fix anything red before continuing — do not proceed to validation with a failing suite.

- [ ] **Step 4: Validate at the real CLI surface — healthy path**

Use the `verify` skill (build and drive the real CLI, not the tests). With a real, working `ANTHROPIC_API_KEY` exported and no other AI keys set:

```bash
pnpm run build
node dist/cli/index.js scan --json > /tmp/llm-scan.json
node -e "const r=require('fs').readFileSync('/tmp/llm-scan.json','utf8').split('\n').filter(Boolean).map(JSON.parse); const scan=r.find(e=>e.type==='scan'||e.scan); console.log(JSON.stringify(scan,null,2))" | grep -A3 'llm-provider'
```

Confirm, and record in the commit message:
1. Exactly **one** target of kind `llm-provider.anthropic` appears (watching label `llm-provider.anthropic`), and **no** `derived-ai-provider` / `ai-provider` target and no blanket `llm-provider` kind appear.
2. Its finding carries a `checkId` and the signals include key validity and rate-limit headroom values.
3. It lands in the live-validated watching bucket of the visibility section (PR 1's split) — confirming `llm-provider.anthropic`'s manifest maturity resolved correctly.
4. `node dist/cli/index.js scan` in human mode reads clearly and contains no key material: `node dist/cli/index.js scan 2>&1 | grep -c "$ANTHROPIC_API_KEY"` must print `0`.

- [ ] **Step 5: Validate the invalid-key path**

```bash
ANTHROPIC_API_KEY=sk-ant-api03-deliberately-invalid-key-0000 node dist/cli/index.js scan --json > /tmp/llm-badkey.json
grep -o 'llm-provider\.[a-z_]*' /tmp/llm-badkey.json | sort -u
grep -c 'sk-ant-api03-deliberately-invalid-key-0000' /tmp/llm-badkey.json
```

Expected: the check-id list contains `llm-provider.key_valid`; the key-material grep prints `0`. The human-mode finding must name Anthropic and the fix direction (rotate the key in the console).

- [ ] **Step 6: Validate the OpenAI path**

Repeat Steps 4–5 with a real `OPENAI_API_KEY` (and `ANTHROPIC_API_KEY` unset), confirming two things the Anthropic run cannot show: the `x-ratelimit-*` header parsing produces a real headroom percentage, and `OPENAI_MODEL` set to a retired model id (e.g. `text-davinci-003`) produces `llm-provider.model_deprecated`.

- [ ] **Step 7: Validate the offline path**

Turn off wifi (or block egress) and run:

```bash
node dist/cli/index.js scan
```

Expected: the llm-provider finding is `unknown`, repeats triage's explanation, and nowhere claims the provider is down. If triage's cached verdict is not populated during scan, the finding should still be `unknown` with per-check "could not be reached" reasons — never `unhealthy`. Record which of the two behaviours you observed.

- [ ] **Step 8: Record per-provider validation status and commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(llm-provider): document the agent and record per-provider validation status"
```

Use the commit body to state exactly what was validated live (Anthropic: healthy + invalid key; OpenAI: healthy + headroom + deprecated model; Google/OpenRouter: mocked only) — the `live_validated` maturity claim rests on that record.

---

## Self-Review

Run after all fourteen tasks are complete.

**Spec coverage — every requirement maps to a task:**

| Design requirement | Task |
|---|---|
| `src/agent/llm-provider/` standard layout, simulator first | 1–9 |
| key_present / key_valid / quota_billing checks | 3, 5, 7 |
| rate_limit_headroom / model_deprecated / provider_status checks | 3, 5, 8 |
| Provider table (4 providers, google's 3 env vars, endpoints, auth, headers, status APIs) | 1 |
| Single source of truth for AI env vars, and for what "configured" means | 1, 10 |
| Autodiscovery derives per-provider `llm-provider.<provider>` targets, each under the matching provider-scoped kind; `derived-ai-provider` and any blanket `llm-provider` kind removed | 9, 10 |
| Per-provider kind (`llm-provider.<provider>`) so maturity buckets correctly via the existing kind-keyed machinery | 4, 5, 7, 9, 10 |
| ai-provider stays registered for explicit config and demo | 9 (test), 14 (docs) |
| `checkId` on health signals, diagnosis findings, and scan findings; exported constants for PR 5 | 2, 5, 11 |
| Per-provider coverage stays visible and honest in the visibility report | 12, 13 |
| `process.env` only, no `.env` parsing | 1, 10, 13 (and the constraint text in every user-facing string) |
| Key secrecy + no-leak grep test | 1 (`fingerprintKey`), 7 (`llm-provider-secrecy.test.ts`) |
| Offline defer to triage verdict | 5 |
| Per-check honest `unknown` | 3, 5, 7, 8 |
| Health mapping (invalid/quota → unhealthy; <20% headroom or incident → degraded) | 5 |
| Signals feed `health-to-signals` with existing vocabulary | 5 (mapping test) |
| `live_validated` maturity, `routine` risk | 4 |
| No mutation, no SDKs, no new deps | 4 (manifest), 6 (plan test), 7 (fetch-only) |
| Plans never out-claim their diagnosis | 6 (`no_finding` scenario) |
| Checks complete inside scan's per-agent budget so check ids survive | 7 (default + test), 9 (explicit wiring) |
| Agent-test-harness coverage | 6 |
| Live validation with real keys incl. a deliberately invalid one | 14 |

**Placeholder scan:** every code step contains complete, runnable code. The only intentional temporary code is the `plan` stub in Task 5 (replaced in Task 6) and the three `checkRateLimitHeadroom`/`checkModel`/`checkProviderStatus` stubs in Task 7 (replaced in Task 8) — both are called out in place, keep the intermediate commits green, and return honest values rather than lies.

**Type consistency spot-checks:**
- `LLM_PROVIDER_CHECK_IDS` lives in `check-ids.ts` (Task 2) and is imported from `check-ids.js` by the agent (Task 5) and both test files that use it (Tasks 2, 5, 11); `backend.ts` re-exports it for in-agent convenience and Task 2 asserts the re-export is the same object. Its keys (`keyPresent`, `keyValid`, `quotaBilling`, `rateLimitHeadroom`, `modelDeprecated`, `providerStatus`) are used identically everywhere.
- `DEFAULT_LLM_REQUEST_TIMEOUT_MS` is defined in `live-client.ts` (Task 7) and consumed by the registration (Task 9) and two tests; `AGENT_TIMEOUT_MS` is exported from `scan.ts` in Task 7 and imported by tests in Tasks 7 and 9.
- `hasConfiguredKey(env, envVar)` is defined in Task 1 and is the only emptiness test in both `detectConfiguredProviders` (Task 1) and `detectAiProviders` (Task 10).
- `LlmProviderBackend`'s six methods (Task 2) are implemented by both `LlmProviderSimulator` (Task 3) and `LlmProviderLiveClient` (Tasks 7–8) and consumed by `runChecks` (Task 5).
- `ModelCheck.listKnown` / `presentInList` (never `known`/`present`) are used consistently in Tasks 2, 3, 5, 8.
- `RateLimitHeadroom.requestsRemainingPct` / `tokensRemainingPct` are the names used in Tasks 2, 3, 5, 8, 11.
- `detectConfiguredProviders` returns `{ provider, envVar, spec }` in Task 1 and is destructured with those exact names in Tasks 9 and 10.
- `LlmTargetOptions` fields `provider`/`model` (Task 9) match `target.llm?.provider` / `target.llm?.model` in the registration (Task 9) and the derived target in autodiscovery (Task 10). `provider` is optional everywhere: the registration's own kind (`llm-provider.<provider>`) is the source of truth for which provider a target uses, and `target.llm.provider`, when present, is validated against it rather than substituted for it.
- The four kinds (`llm-provider.anthropic`, `.openai`, `.google`, `.openrouter`) are used identically as: `AgentRegistration.kind` (Task 9), `TargetConfig.kind` / derived target `kind` (Task 10), `KIND_PREFIX` and `SUPPORTED_KINDS` entries (Task 9), `capability-registry.ts` `targetKinds` (Task 4), `REPRESENTATIVE_SOURCES` keys (Task 4), and `CapabilityProviderDescriptor.targetKinds` in `listCapabilityProviders()` (Task 7/8, one kind per provider instance).
- `OfflineGate` returns `ObserverOffline | null` in Task 5 and every test injects a matching `async () => null`.

**Known integration risk:** the triage import in `offline-gate.ts` is the one name this plan cannot verify against merged code — the contract (`getTriageReport(): TriageReport | null`, `.verdict`, `.explanation`) is confirmed against PR 2's plan, not against merged source. Task 5, Step 1 checks it before anything depends on it; Task 5, Step 4 pins the deferral rules; and the blast radius is a single file.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-05-llm-provider-agent.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
