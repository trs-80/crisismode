# Vibe-Coder UX, Arc 1: Plain-Language & Honesty Layer

**Date:** 2026-08-01
**Status:** Approved for implementation
**Scope:** Output/presentation layer only — no new diagnosis capability.

## Problem

CrisisMode's target user increasingly built their stack with heavy LLM
assistance and hosts on managed platforms (AWS, Vercel, Supabase). They may
not know what replication lag, a connection pool, or a WAL is. Today's output
assumes ops fluency in three places:

1. `scan` — the zero-config default command — renders raw agent summaries with
   no explanation layer (the `signal-explanations` knowledge map exists but is
   only wired into `diagnose`).
2. Nothing anywhere reports what CrisisMode *cannot* see or why that is
   normal. Service-level reach (client protocols over the network) versus
   OS-level reach (requires a spoke on the host) is invisible to the user, so
   silent gaps read as either bugs or false confidence.
3. Recovery risk renders as a colored badge (`elevated`), not as consequences
   a non-expert can weigh.

There is also no enforcement: 12 explanation entries cover 19 agents, and a
20th agent can ship with jargon-only output.

## Design principle (settled during brainstorming)

**Static first, AI enrich.** Every explanation, visibility note, and risk
framing works offline and keyless from curated text plus data the system
already produces. When `ANTHROPIC_API_KEY` is present, existing AI paths
(scan aiSummary, ai-explainer) layer situation-specific detail on top. This
matches the crisis-conditions ethos: the explanation must exist precisely when
infrastructure — possibly including API reachability — is degraded.

Plain language is **on by default** in human output. A new `--terse` flag
suppresses it for experts. Machine mode (`--json`) gains the same data as
additive fields — never a breaking change to existing records.

## Components

### 1. Scan explanations (comprehension)

- Wire the existing `signal-explanations` enrichment into `scan`'s finding
  assembly and human rendering: under each non-healthy finding, one dim line
  of plain-language explanation plus a learn-more URL.
- Scan currently drops signal `source` when building findings; retain it so
  the regex map can match (also fixes `--json` signals, additively).
- `--json` findings gain `explanation` and `learnMoreUrl` fields.
- `--terse` suppresses explanation lines in human mode.

### 2. Visibility section (first-contact honesty)

New module `src/cli/visibility.ts`: pure function from autodiscovery output
(env hints with `present` flags, platform detection, gated-derivation notes)
plus the set of agents that actually ran, to a `VisibilityReport` with three
buckets:

- **Watching** — what ran, with its evidence: `postgresql — via DATABASE_URL`.
- **Found but can't check yet** — detected credentials/platforms with no
  supported checks: `AWS credentials detected — control-plane checks (RDS,
  ElastiCache) aren't supported yet`. Each entry carries a static one-line
  remediation or expectation hint. This bucket is Arc 2's visible motivation.
- **Not visible by design** — inherent limits stated as normal:
  `disk/memory on managed hosts — nothing can see these from outside; run a
  CrisisMode spoke on the host if you need them`.

Rendered at the end of every `scan` in human mode; emitted as one `visibility`
JSONL record in machine mode; hidden by `--terse`. The report is also passed
to the existing AI summary path so AI enrichment can reference access gaps
("you're on Vercel with a Supabase URL but no direct DB access").

Access gaps must be **actionable**: every non-watching entry includes what the
user can do about it (set an env var, grant a permission, deploy a spoke), as
static text.

### 3. Plan risk framing (safe action)

Extend the **structural** `PlanExplanation` path (`ai-explainer.ts` fallback)
and plan rendering so each `system_action` step at `elevated`+ risk shows a
three-line block before any approval gate:

- **What this does** — the step's description.
- **What could go wrong** — a per-risk-level template sentence plus the step's
  actual `blastRadius.affectedComponents`.
- **How we undo it** — from `rollbackStrategy` / `statePreservation.before`,
  which the validator already guarantees exist at these risk levels.

Zero per-step authoring: this renders safety data plans already carry. AI
enrichment stays layered on top when a key is present.

### 4. Content pass + enforcement

- Author explanation entries for agent kinds the map misses (audit at
  implementation time; known gaps include flink, ceph, config-drift,
  db-migration, deploy-rollback, ai-provider).
- New unit test walks the built-in agent registry and fails if any agent's
  signal sources match no `signal-explanations` entry. New agents cannot ship
  jargon-only.

## Error handling

- Explanation lookup is best-effort: a finding with no matching entry renders
  exactly as today (no crash, no placeholder text). The enforcement test, not
  runtime behavior, is what keeps coverage complete.
- The visibility builder is a pure function over data already collected; if
  autodiscovery produced nothing (fully configured site, no env hints), the
  section renders only the Watching bucket.
- `--terse` + `--json` combined: `--terse` affects human rendering only;
  machine output always carries the full data.

## Testing

- Unit: visibility builder from fixture autodiscovery results (each bucket,
  empty cases); risk-framing renderer from fixture plans (each risk level,
  with/without rollback detail); scan enrichment (finding with/without map
  match); the enforcement test itself.
- Real surface (bundle): keyless `scan` in a bare temp dir shows explanations
  and visibility; `scan` with a fake `AWS_ACCESS_KEY_ID` shows the
  found-but-can't-check bucket; dry-run `recover` shows risk framing;
  `--terse` and `--json` variants.

## Out of scope (this iteration)

- Per-agent authored SDK explanation fields (`DiagnosisFinding.explanation`)
  — incremental precision work for later; the central map is the foundation.
- AWS control-plane diagnosis (Arc 2: provider detection from endpoints,
  RDS/ElastiCache checks via SDK, advice in AWS-console terms).
- Interactive AI-guided access setup ("help me get connected" flow) — the
  static remediation hints plus `ask` cover this iteration.
- IaC awareness (Arc 3 candidate): ask about / read Terraform or similar to
  learn intended configuration — pairs with the config-drift agent
  (intended vs. observed) and enables shape-of-stack discovery without
  probing. Revisit after Arc 2.
