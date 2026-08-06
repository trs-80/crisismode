# PR 3 — LLM Provider Agent: Live Checks for the AI Stack

**Date:** 2026-08-05 (revised same day after secondary evaluation)
**Series:** Reliability-first (PR 3 of 5). Depends on PR 1 (maturity/visibility contract) and PR 2 (triage verdict, for the offline-defer behavior). PR 5 anchors guidance to this PR's `checkId`s.

## Problem

The target user's app is usually an AI app, and the most common way it breaks is the LLM provider layer: an invalid or rotated API key, exhausted quota/billing, rate limiting, a deprecated model id, or a provider outage.

Today this space is covered by the `ai-provider` agent — and the coverage is misshapen for this user. That agent models an app-side failover layer (circuit breakers, fallback chains, traffic shifting) that vibe coders don't have, yet it is live-wired: `registration.ts` uses `createLiveRegistration`, `live-client.ts#probeProvider` probes provider models endpoints with keys from env, and autodiscovery (`src/cli/autodiscovery.ts:385-395`) derives a `derived-ai-provider` target from `AI_ENV_VARS` whenever any AI key is present — while its manifest claims `simulator_only`. So the existing state is: real live probes, failover-shaped diagnosis the user can't act on, and a maturity label that PR 1's machinery would render as misleadingly *under*-confident. No coverage exists for quota/billing classification, rate-limit headroom, model deprecation, or provider status.

## Goals

A new diagnosis-focused agent, `src/agent/llm-provider/`, that **takes over the env-key-derived role** from ai-provider, covering Anthropic, OpenAI, Google (Gemini API), and OpenRouter with read-only checks — shipping `live_validated` for Anthropic and OpenAI, `simulator_only` for Google and OpenRouter (per-provider maturity; see Maturity claim for the mechanism):

1. **key_present** — provider key discovered in the process environment.
2. **key_valid** — cheap authenticated call succeeds (models-list endpoint).
3. **quota_billing** — classify authenticated failures: 401 invalid key vs. 403 `billing_error`/`permission_error` vs. 429 with quota-exhaustion markers (e.g. OpenAI `insufficient_quota`).
4. **rate_limit_headroom** — parse ratelimit response headers where the provider returns them; report remaining requests/tokens as a percentage.
5. **model_deprecated** — when a model id is configured (crisismode.yaml target config or well-known env vars like `ANTHROPIC_MODEL` / `OPENAI_MODEL`), verify it appears in the live models list.
6. **provider_status** — fetch the provider's status page API (Statuspage-style JSON summary endpoint) and report ongoing incidents.

## Boundary with the existing ai-provider agent (the load-bearing decision)

- **Autodiscovery switches kinds:** the `derived-ai-provider` derivation and the `AI_ENV_VARS` scan in `src/cli/autodiscovery.ts` are changed to derive **provider-scoped `llm-provider.<provider>`** targets (one per detected provider, not one blanket target). After this PR, setting `ANTHROPIC_API_KEY` produces exactly one watched target, of kind `llm-provider.anthropic` (see Maturity claim for why the kind is provider-scoped). No duplicate or contradictorily-labeled coverage.
- **ai-provider remains registered** for explicitly configured targets and demo mode only (its failover-layer modeling is still useful for teams that have such a layer, and for the simulator demo). It is no longer reachable via zero-config autodiscovery, which makes its `simulator_only` manifest claim accurate again for the zero-config path.
- **One source of truth for provider env vars:** the provider env-var table moves to `src/agent/llm-provider/provider-table.ts`; ai-provider's `AI_ENV_VARS` and autodiscovery import from it (or it re-exports for compatibility). The existing key set is preserved and extended (see table).

## Non-goals

- Any mutation, failover, or traffic control — checks are Diagnose level; plans are suggestion-only text (structured guidance arrives in PR 5).
- Provider SDK dependencies. All calls are raw `fetch` against provider REST endpoints (protects the 256Mi spoke target and avoids four SDKs).
- **`.env` file parsing.** v1 reads `process.env` only. Parsing a secrets file is new attack surface that deserves its own design (quoting rules, which keys, forensics guarantees); if wanted later it is a follow-up, not a rider.
- Vector stores, inference platforms (Replicate/Groq/Together as diagnosis targets), and AI gateways beyond OpenRouter (deferred; breadth-over-depth is the mistake we're correcting). ai-provider's existing 7-provider probe table is unaffected for explicit-config users.
- New correlation rules (per PR 1's freeze policy — none needed at ship).

## Design

### Agent structure (standard pattern)

```
src/agent/llm-provider/
  backend.ts        # LlmProviderBackend interface
  provider-table.ts # per-provider static config; source of truth for AI env vars
  simulator.ts      # in-memory scenarios: healthy, bad key, quota exhausted, rate limited, deprecated model, provider incident
  live-client.ts    # fetch-based implementation
  manifest.ts       # exports one manifest per provider, kind: 'llm-provider.<provider>', maxRiskLevel: routine; maturity is per-provider (see Maturity claim)
  agent.ts          # RecoveryAgent implementation, parameterized by provider id
  registration.ts   # one lazy factory per provider kind; all four registered in builtin-agents.ts
```

### Provider table

One entry per provider, everything else generic:

| field | anthropic | openai | google | openrouter |
|---|---|---|---|---|
| env keys | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GOOGLE_AI_API_KEY` (existing convention), `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `OPENROUTER_API_KEY` |
| models endpoint | `GET api.anthropic.com/v1/models` | `GET api.openai.com/v1/models` | `GET generativelanguage.googleapis.com/v1beta/models` | `GET openrouter.ai/api/v1/models` (+ `/api/v1/auth/key` for auth) |
| auth | `x-api-key` + `anthropic-version` | `Authorization: Bearer` | `x-goog-api-key` header | `Authorization: Bearer` |
| ratelimit headers | `anthropic-ratelimit-*` | `x-ratelimit-*` | not exposed → report honest `unknown` | not exposed via headers; parsed from `GET /api/v1/auth/key` response body (`data.rate_limit.requests` / `data.rate_limit.interval`, `data.usage` vs `data.limit`) → else honest `unknown` |
| status API | `GET status.anthropic.com/api/v2/summary.json` (Statuspage; no auth) | `GET status.openai.com/api/v2/summary.json` (Statuspage; no auth) | `GET status.cloud.google.com/incidents.json` (no auth; JSON array of incident objects, each with `service_name`, `severity`, `begin`, `end` — `end: null` means ongoing; an incident is active when `end` is null and `service_name` matches a Gemini/Generative Language service) | `GET status.openrouter.ai/api/v2/summary.json` (Statuspage-shaped; no auth; same `{ status: { indicator, description }, incidents: [...] }` contract as Anthropic/OpenAI) |

Endpoint/header details above are concrete, testable contracts — the table is the single place they live. Anthropic's models endpoint and error taxonomy were verified at design time (models list exists; 401 `authentication_error`; error `.type` distinguishes `billing_error` from `permission_error`; 429 carries `retry-after` and ratelimit headers). Google's `incidents.json` shape and OpenRouter's Statuspage-style `summary.json` URL are design-time best-effort placeholders — confirmed against current provider docs during implementation and updated here if the real shape differs; a live-client test asserts against whatever shape is pinned in this table, not an ad hoc guess at the call site. If a provider's real response doesn't match, the check degrades to `unknown` (per Honest degradation) rather than the agent crashing or misreporting an incident.

### Timeouts and cancellation

Every live fetch this agent makes — models-list, quota/billing, rate-limit, model-list, and status-page calls, for all four providers — is bounded by a **1200ms per-request deadline** (within the repo's ≤1500ms provider-fetch-timeout convention), enforced with `AbortController`: `fetch(url, { signal: controller.signal })` paired with `setTimeout(() => controller.abort(), 1200)`. No check is exempt. A slow or non-responsive provider or status endpoint therefore cannot block `scan`/`diagnose`: on abort, the check classifies as `unknown` with a "timed out after 1200ms" reason — the same honest-degradation contract used for other unverifiable failures (see Honest degradation and Health assessment mapping below).

### Discovery and secrecy

Autodiscovery detects provider env vars in the process environment (per the boundary section above). **Full key material never appears in output, logs, plans, or forensics** — only the provider name plus a masked `fingerprintKey` identifier (the established cross-PR convention: `'…' + last four characters`, or `'(key too short to fingerprint)'` for keys under 8 characters) is ever referenced, never the complete secret. This is enforced by a test that greps all emitted output for the full key value in a scenario run, confirming the complete secret never appears; the intentional last-4 `fingerprintKey` identifier is, by design, the one permitted rendering of a credential and is exempt from that grep.

### Finding output contract (consumed by PR 5)

Every finding this agent emits carries a stable **`checkId`** of the form `llm-provider.<check>` (e.g. `llm-provider.key_valid`, `llm-provider.quota_billing`, `llm-provider.rate_limit_headroom`, `llm-provider.model_deprecated`, `llm-provider.provider_status`), present in machine output on the finding object and available to the guidance registry. This is a new field on the scan finding shape (today findings have only display ids like `AI-001`); the field is optional so existing agents are unaffected until they adopt it (aws-rds adopts it in PR 5's migration).

### Honest degradation (Arc 2 precedent)

- Per-check degradation: one provider or one check failing (e.g., status page unreachable) never crashes the agent; the check reports `unknown` with the reason.
- Offline: key_present still works; network checks report "cannot verify while offline" and defer to PR 2's triage verdict (if triage says `local`/`network`, provider checks are skipped with that explanation rather than reporting the provider down).
- Where a provider doesn't expose a signal (e.g., Gemini rate-limit headers), the check reports honest `unknown`, not a guess — same contract as iac-drift's `DriftUnknown`.

### Health assessment mapping

Every possible check result maps deterministically to a finding severity and an overall health contribution — no check result is left unmapped:

- **key_valid**: invalid (401) → unhealthy, severity high — the app is down for AI features.
- **quota_billing** (classifying authenticated failures only; see `unknown` restriction below):
  - 401 → `invalid_key` → unhealthy, severity high.
  - 403 with a billing-type error body → `billing_error` → unhealthy, severity high (the account can't be used).
  - 403 with a permissions-type error body → `permission_error` → degraded, severity medium (the key is valid but scoped too narrowly for this call; other calls may still succeed).
  - 429 with quota-exhaustion markers (e.g. `insufficient_quota`) → `quota_exhausted` → unhealthy, severity high.
  - 429 without quota-exhaustion markers (plain rate limiting, no billing signal) → degraded, severity medium, reported via `rate_limit_headroom` rather than `quota_billing`.
- **rate_limit_headroom**: < 20% remaining → degraded, severity medium; provider incident → degraded; header not exposed by the provider → honest `unknown`, severity low (not a guess, not a failure).
- **model_deprecated**: configured model id absent from the live models list → degraded, severity medium (the app may break on its next call); present → healthy; models-list fetch fails → `unknown`, severity low.
- **provider_status**: an active incident affecting the provider → degraded, severity medium (high if the incident is a full outage); status endpoint unreachable, unparsable, or an unsupported response shape → `unknown`, severity low.
- **`unknown` is reserved for unverified failures only** — transport errors, parse errors, unsupported/unexpected response shapes, timeouts (per Timeouts and cancellation above), or offline/unreachable conditions. It is never used in place of a classified authenticated failure: 401/403/429 responses are always categorized per the `quota_billing` rules above, not folded into `unknown`. `unknown` findings are severity low and reported honestly as "cannot verify," distinct from both healthy and failing states.
- All checks pass → healthy.
- Findings feed signals (`health-to-signals.ts`) with types from the existing signal vocabulary (`connection`, `error_rate`, `config_mismatch`) — no new signal types needed for synthesis.

### Maturity claim

Maturity in this codebase is a property of a whole agent **registration**, not of an individual runtime target: `agentMaturity(manifest)` (`src/framework/agent-maturity.ts`) reads a single `manifest.metadata.plugin?.maturity`, and `buildMaturityByKind` builds a `Map<kind, AgentMaturity>` keyed by the registration's `kind` string, taking the *weakest* value when multiple registrations share a kind. A single `kind: 'llm-provider'` manifest-level maturity would therefore bucket every provider together under one value — either misreporting Google/OpenRouter as `live_validated`, or (once `buildMaturityByKind`'s weakest-wins rule applies) dragging Anthropic/OpenAI down to `simulator_only`.

To keep maturity provider-specific using the *existing* kind-keyed machinery (no new maturity mechanism needed), each provider gets its **own registration under its own provider-scoped `kind`**: `llm-provider.anthropic`, `llm-provider.openai`, `llm-provider.google`, `llm-provider.openrouter`. All four share the same `agent.ts` / `backend.ts` / `live-client.ts` implementation, parameterized by provider id from `provider-table.ts`; only `manifest.ts` differs per provider, each declaring its own `maturity`:

- `llm-provider.anthropic` → `live_validated` (verify-skill validation against a real Anthropic key).
- `llm-provider.openai` → `live_validated` (verify-skill validation against a real OpenAI key).
- `llm-provider.google` → `simulator_only` (live path implemented identically, not yet validated against a real key).
- `llm-provider.openrouter` → `simulator_only` (same).

Autodiscovery (see boundary section) derives one target per detected provider using these provider-scoped kinds directly — an autodiscovered Google target therefore reports `simulator_only` and an autodiscovered Anthropic target reports `live_validated`, even though both come from the same `llm-provider` family, because `buildMaturityByKind` only ever sees one registration per provider-scoped kind (nothing to average down). The README documents per-provider validation status; when Google/OpenRouter later pass verify-skill validation, only their manifests flip to `live_validated`, with no effect on the other providers' buckets.

## Testing

- Simulator scenarios for all six checks × healthy/failing.
- Live-client unit tests with mocked `fetch` (per-provider request shape, error classification table, header parsing, no-key-leak test).
- Autodiscovery tests: env detection derives per-provider `llm-provider` targets; `derived-ai-provider` is no longer produced; explicit ai-provider config still works.
- Agent-test-harness coverage.
- Live validation at the real surface: `crisismode scan` and `crisismode diagnose` against real Anthropic + OpenAI keys, including a deliberately invalid key.

## Acceptance criteria

- `crisismode scan` on a machine with `ANTHROPIC_API_KEY` set reports exactly one AI-provider target — kind `llm-provider.anthropic`, live-validated bucket — with key validity and headroom, and no `derived-ai-provider` target.
- An invalid key produces a plain-language finding naming the provider and the fix direction, with the complete key value absent from every output mode (provider name + masked `fingerprintKey` identifier only — never the full key or an accidental larger substring of it), carrying `checkId: llm-provider.key_valid`.
- Offline, the agent defers to triage instead of reporting providers down.
