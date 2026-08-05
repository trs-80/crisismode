# PR 3 — LLM Provider Agent: Live Checks for the AI Stack

**Date:** 2026-08-05
**Series:** Reliability-first (PR 3 of 5). Depends on PR 1 (maturity/visibility contract). PR 5 anchors guidance to this PR's finding types.

## Problem

The target user's app is usually an AI app, and the most common way it breaks is the LLM provider layer: an invalid or rotated API key, exhausted quota/billing, rate limiting, a deprecated model id, or a provider outage. CrisisMode has no live coverage here. The existing `ai-provider` agent models an app-side failover layer (circuit breakers, fallback chains, traffic shifting) that vibe coders don't have; it stays as-is (simulator/demo) and is **not** refit.

## Goals

A new diagnosis-focused agent, `src/agent/llm-provider/`, shipping `live_validated`, covering Anthropic, OpenAI, Google (Gemini API), and OpenRouter with read-only checks:

1. **key_present** — provider key discovered in env or `.env`.
2. **key_valid** — cheap authenticated call succeeds (models-list endpoint).
3. **quota_billing** — classify authenticated failures: 401 invalid key vs. 403 `billing_error`/`permission_error` vs. 429 with quota-exhaustion markers (e.g. OpenAI `insufficient_quota`).
4. **rate_limit_headroom** — parse ratelimit response headers where the provider returns them; report remaining requests/tokens as a percentage.
5. **model_deprecated** — when a model id is configured (crisismode.yaml target config or well-known env vars like `ANTHROPIC_MODEL` / `OPENAI_MODEL`), verify it appears in the live models list.
6. **provider_status** — fetch the provider's status page API (Statuspage-style JSON summary endpoint) and report ongoing incidents.

## Non-goals

- Any mutation, failover, or traffic control — checks are Observe/Diagnose level; plans are suggestion-only text (structured guidance arrives in PR 5).
- Provider SDK dependencies. All calls are raw `fetch` against provider REST endpoints (protects the 256Mi spoke target and avoids four SDKs).
- Vector stores, inference platforms (Replicate/Groq/Together), and AI gateways beyond OpenRouter (deferred; breadth-over-depth is the mistake we're correcting).
- New correlation rules (per PR 1's freeze policy — none needed at ship).

## Design

### Agent structure (standard pattern)

```
src/agent/llm-provider/
  backend.ts        # LlmProviderBackend interface
  provider-table.ts # per-provider static config (see below)
  simulator.ts      # in-memory scenarios: healthy, bad key, quota exhausted, rate limited, deprecated model, provider incident
  live-client.ts    # fetch-based implementation
  manifest.ts       # kind: 'llm-provider', maxRiskLevel: routine, maturity: live_validated
  agent.ts          # RecoveryAgent implementation
  registration.ts   # lazy factory; registered in builtin-agents.ts
```

### Provider table

One entry per provider, everything else generic:

| field | anthropic | openai | google | openrouter |
|---|---|---|---|---|
| env keys | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `OPENROUTER_API_KEY` |
| models endpoint | `GET api.anthropic.com/v1/models` | `GET api.openai.com/v1/models` | `GET generativelanguage.googleapis.com/v1beta/models` | `GET openrouter.ai/api/v1/models` (+ `/api/v1/auth/key` for auth) |
| auth | `x-api-key` + `anthropic-version` | `Authorization: Bearer` | `x-goog-api-key` header | `Authorization: Bearer` |
| ratelimit headers | `anthropic-ratelimit-*` | `x-ratelimit-*` | not exposed → report honest `unknown` | varies → verify, else `unknown` |
| status API | `status.anthropic.com/api/v2/summary.json` | `status.openai.com/api/v2/summary.json` | Google Cloud status (JSON feed) | `status.openrouter.ai` (verify) |

Endpoint/header details marked "verify" are confirmed against current provider docs during implementation (the table is the single place they live). Anthropic's models endpoint and error taxonomy were verified at design time (models list exists; 401 `authentication_error`; error `.type` distinguishes `billing_error` from `permission_error`; 429 carries `retry-after` and ratelimit headers).

### Discovery

Autodiscovery (`src/cli/autodiscovery.ts`) detects provider env vars in the process environment and in `./.env` (parsed read-only, reusing the existing credential-filtering conventions from the supply-chain hardening work). Each detected provider becomes one target of kind `llm-provider`. **Key material never appears in output, logs, plans, or forensics** — keys are referenced by provider name + last-4 fingerprint only. This is enforced by a test that greps all emitted output for the key value in a scenario run.

### Honest degradation (Arc 2 precedent)

- Per-check degradation: one provider or one check failing (e.g., status page unreachable) never crashes the agent; the check reports `unknown` with the reason.
- Offline: key_present still works; network checks report "cannot verify while offline" and defer to PR 2's triage verdict (if triage says `local`/`network`, provider checks are skipped with that explanation rather than reporting the provider down).
- Where a provider doesn't expose a signal (e.g., Gemini rate-limit headers), the check reports honest `unknown`, not a guess — same contract as iac-drift's `DriftUnknown`.

### Health assessment mapping

- Invalid key / quota exhausted → unhealthy (severity high — the app is down for AI features).
- Rate-limit headroom < 20% remaining or provider incident → degraded.
- All checks pass → healthy.
- Findings feed signals (`health-to-signals.ts`) with types from the existing signal vocabulary (`connection`, `error_rate`, `config_mismatch`) — no new signal types needed for synthesis.

### Maturity claim

Ships `live_validated` only after verify-skill validation against real Anthropic and OpenAI keys (both available). Google/OpenRouter live paths are implemented identically but validated best-effort; the agent-level claim rests on the two majors, and the README notes per-provider validation status.

## Testing

- Simulator scenarios for all six checks × healthy/failing.
- Live-client unit tests with mocked `fetch` (per-provider request shape, error classification table, header parsing, no-key-leak test).
- Agent-test-harness coverage; autodiscovery tests for env/.env detection.
- Live validation at the real surface: `crisismode scan` and `crisismode diagnose` against real Anthropic + OpenAI keys, including a deliberately invalid key.

## Acceptance criteria

- `crisismode scan` on a machine with `ANTHROPIC_API_KEY` set reports the provider as watched (live-validated bucket) with key validity and headroom.
- An invalid key produces a plain-language finding naming the provider and the fix direction, with zero key material in any output mode.
- Offline, the agent defers to triage instead of reporting providers down.
