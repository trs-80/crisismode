# PR 5 — Guidance-Grade Recovery: Exact Console Steps as a First-Class Type

**Date:** 2026-08-05
**Series:** Reliability-first (PR 5 of 5). Depends on PR 3 (LLM provider finding types) and PR 4 (vector/pgvector finding types); migrates existing aws-rds guidance. Ships last.

## Problem

For the target user, recovery is rarely a `system_action` we can execute — it's "rotate the key in the Anthropic console", "switch the Supabase pooler to transaction mode", "bump the plan tier". Today this guidance exists only as inline prose strings in aws-rds (`agent.ts` — "RDS console → Databases → <instance> → Modify → Allocated storage…") and ad-hoc aws-cli text. It is not structured, not consistently rendered across output modes, not keyed to findings, and not reusable by other agents. A vibe coder cannot confidently act on raw CLI text; they can follow "open this URL, click this, expect that".

## Goals

1. A structured guidance type in the agent SDK, rendered consistently in human/pipe/json output.
2. Guidance content for the AI + DB provider consoles: Anthropic, OpenAI, Supabase, Neon.
3. Existing aws-rds inline console strings migrated to the new type (no behavior change beyond formatting).
4. A `verifiedOn` freshness policy so console-path rot is visible instead of silent.

## Non-goals

- Automating any of these actions (dashboard actions stay human-performed; this is Suggest-level escalation).
- Deploy-platform guidance (Vercel/Netlify/Railway) — no deploy-platform diagnosis exists to anchor it; deferred to a future arc.
- Screenshots or deep-links requiring account context (paths and top-level URLs only).

## Design

### Type (packages/agent-sdk)

```ts
export interface RemediationGuide {
  id: string;                      // unique, e.g. 'anthropic-rotate-key'
  platform: string;                // 'anthropic-console', 'supabase', 'aws-rds', ...
  title: string;                   // "Rotate your Anthropic API key"
  applicableFindingTypes: string[];// finding/signal types this guide answers
  url?: string;                    // stable console entry URL
  consoleSteps: string[];          // ordered human steps: "Settings → API keys → Create Key"
  cliEquivalent?: string;          // optional, for users comfortable with a terminal
  expectedAfter: string;           // what the user should observe when it worked
  caution?: string;                // risk note, when a step is destructive-adjacent (e.g. old key stops working)
  verifiedOn: string;              // ISO date the path was last human-verified
}
```

Zero runtime dependencies preserved (types only in the SDK; content and registry live in the main package).

### Anchoring contract (what `applicableFindingTypes` matches against)

Today's scan findings carry only display ids (`AI-001`), so "finding type" needs a definition. The contract, by surface:

- **Readiness findings:** the rule id (`connection-headroom`, `serverless-pooling`, `connection-limit-tier`, `vector-index-missing`, `ivfflat-lists-mismatch`) — these already exist as stable identifiers.
- **Scan/diagnose findings:** the `checkId` field introduced by PR 3 (`llm-provider.key_valid`, `llm-provider.quota_billing`, `llm-provider.rate_limit_headroom`, `llm-provider.model_deprecated`, `llm-provider.provider_status`) and PR 4 (`vector-store.reachable`, `vector-store.auth_valid`, `vector-store.index_status`).
- **aws-rds findings:** have no `checkId` today; **this PR adds them during the migration** (`aws-rds.storage_full`, `aws-rds.instance_class`, `aws-rds.sg_inbound`, `aws-rds.instance_stopped` — final names fixed at implementation to match the migrated strings one-to-one).

The enforcement test resolves `applicableFindingTypes` against the union of registered readiness rule ids and the `checkId` constants exported by each agent — so a renamed rule or check breaks the build, not the lookup at runtime.

### Registry + attachment

- `src/framework/guidance/registry.ts` — static registry of guides, indexed by `applicableFindingTypes`. Pure data + lookup; no I/O.
- Attachment point: when scan/diagnose/readiness emit a finding whose type has guides, the top-matching guide(s) attach to the finding (machine mode: full objects under `guides`; human mode: rendered block; pipe mode: `guide:<id>` reference column, consistent with pipe minimalism).
- Suggestion-only plans (`human_notification` / suggestion steps) reference guides by id instead of duplicating prose.

### Rendering

- Human: a "How to fix it" block — title, numbered steps, URL, expected-after line, caution line when present, and a trailing `(path verified 2026-08-05)` freshness note. Respects `--terse` (collapses to title + URL).
- Machine: full structure, no truncation.
- One renderer in `src/cli/output.ts` used by every surface (scan, diagnose, readiness, recover proposal) — no per-command formatting.

### Content (initial set)

| platform | guides |
|---|---|
| anthropic-console | rotate key; check/raise rate limits; billing & credit exhaustion |
| openai-platform | rotate key; usage limits & quota exhausted; billing |
| supabase | pooler mode (session vs transaction) for serverless; connection cap by plan tier; upgrade plan tier |
| neon | connection pooling endpoint; compute size/autoscaling limits |
| aws-rds | migrate the existing inline strings (storage full, instance class, security-group inbound, start instance) — content unchanged, structure new |

Each guide keyed to the concrete finding types from PRs 3–4 and the existing PG readiness rules (`connection-headroom`, `serverless-pooling`, `connection-limit-tier`) and RDS findings.

### Freshness policy

- Every guide carries `verifiedOn`, set by a human who followed the path.
- A unit test fails when any guide's `verifiedOn` is older than 12 months (a nudge, not a runtime behavior — output shows the date regardless).
- CONTRIBUTING.md documents the rule: editing a guide's steps requires re-verifying and updating the date.

## Error handling

Guidance is static data — the only failure modes are lookup misses (finding type with no guide: render nothing, exactly today's behavior) and registry validation (duplicate ids, empty steps, unparseable `verifiedOn` — caught by a validation test, not at runtime).

## Testing

- Registry validation test (ids unique, dates valid, every `applicableFindingTypes` entry resolves per the anchoring contract above — enforcement-style, so a renamed rule id or `checkId` can't silently orphan its guides).
- Renderer tests across the three output modes, including `--terse`.
- aws-rds migration: existing suggestion-plan tests updated; assert the same console paths survive in structured form.
- Freshness test as described.

## Acceptance criteria

- An invalid Anthropic key finding (PR 3) renders a numbered rotate-key guide with URL and expected outcome in human mode, and structured `guides` in `--json`.
- aws-rds suggestions render through the shared type with no lost content.
- Every registered guide maps to at least one finding type that the codebase actually emits.
