# PR 1 — Honesty Foundation: Maturity Surfacing + Inference Reframe

**Date:** 2026-08-05 (revised same day after secondary evaluation)
**Series:** Reliability-first (PR 1 of 5). No dependencies; every later PR builds on the output contract this PR establishes.

## Problem

CrisisMode registers 20 agents but only 6 are `live_validated` (pg-replication, dns, tls, disk, backup, kubernetes). The other 14 declare `maturity: 'simulator_only'` in their manifests (`metadata.plugin.maturity`), yet nothing in scan output distinguishes them — a detected Kafka broker renders as "watching" with the same confidence as a live-validated Postgres. For the target user (a vibe coder who cannot independently judge our claims), this is a trust liability.

Separately, `src/framework/root-cause-synthesis.ts` contains 11 hand-authored `CORRELATION_RULES` that present incident-shape pattern matches as root causes with confidence boosts. These are the brittle part of the deterministic layer: real incidents are combinatorial, and each added rule increases cross-rule interaction surface (we have already shipped two fixes for this: pairwise `requiredTypesByKind` and evidence-reference keying of the signal maps).

## Goals

1. Scan output never implies live-validated coverage that doesn't exist.
2. Correlation output is framed as investigation guidance, not root-cause assertion.
3. The correlation-rule set is frozen under an explicit written policy.
4. The remaining open synthesis follow-ups from the Arc 2/3 ledger are fixed.

## Non-goals

- Removing, quarantining, or gating any agent (decision: label + de-emphasize, nothing deleted).
- Changing autodiscovery behavior — detection is unchanged; only presentation and claims change.
- Adding new correlation rules or new inference of any kind.

## Design

### 1. Maturity in the visibility report

`buildVisibilityReport` (src/cli/visibility.ts) currently buckets entries as watching / blocked / invisible, and receives only autodiscovery data — it has no path to agent manifests. Changes:

- `buildVisibilityReport` gains a `maturityByKind: Map<string, AgentMaturity>` parameter, built once in scan from the agent registry (kind → registration → `metadata.plugin.maturity`). A ran kind with no registered agent (or no maturity value) is treated as best-effort — the honest default.
- `VisibilityEntry` gains `maturity: 'live_validated' | 'simulator_only'`.
- Human output splits the watching bucket: **Watching** (live-validated) and **Watching (best-effort)** with a one-line honest hint: "checks exist but have never been validated against a real <system>; treat findings as leads, not conclusions."
- Machine mode (`--json`) includes the `maturity` field per entry. Pipe mode continues to omit the visibility section (pre-existing convention, unchanged).

### 2. Coverage claims vs. finding counts — explicit semantics

Two different surfaces make two different claims; this PR changes one and deliberately leaves the other:

- **Coverage claims** (the visibility section's watching count in `src/cli/output.ts`, and the "what CrisisMode is watching" statements fed into the plain-language summary): count only live-validated kinds as "watched"; best-effort kinds are listed separately and never folded into that number.
- **Finding counts** (`buildHeadline` in `src/cli/incident-summary.ts` — "N services unhealthy out of M checked (score: X/100)" — and the score itself): **unchanged**. Simulator-only agents' findings are real probe results and continue to count in "checked", "unhealthy", and the score; excluding them would make the headline arithmetically inconsistent with the findings list below it. Their findings instead carry the best-effort caveat (below).
- Findings from simulator-only agents carry a `bestEffort: true` field in machine output and a suffix line in the human explanation.

### 3. Plain-language summary input

`generatePlainEnglishSummary` (src/cli/ai-summary.ts) is an LLM call with a deterministic fallback, not a counter. The change is to its inputs and fallback: the serialized visibility text it receives distinguishes validated vs. best-effort watching, and `buildFallbackSummary`'s coverage sentence uses only the live-validated count.

### 4. `agent list` maturity column

`crisismode agent list` gains a maturity column so the roster is honest at a glance. `agent info` shows the same field with the hint text.

### 5. Synthesis reframe (root-cause-synthesis.ts)

- Presentation wording changes from root-cause assertion ("Recent deployment triggered cascading failures") to investigation-path framing: the rule's `rootCauseTemplate` output is rendered under a "Likely investigation path" / "hint" heading with the `investigationOrder` as the actionable content. Templates themselves keep their text; the *framing* around them changes in output layers (scan, incident report, operator summary).
- Confidence language is capped: rendered confidence never exceeds "possible pattern match"; numeric confidence stays internal for ordering only in human output (machine output keeps the number, documented as ordering weight, not probability).
- A file-header contract documents the freeze policy: **no new correlation rules unless a new agent class ships with a concretely evidenced signal pairing; no speculative incident templates.** CONTRIBUTING.md gets a matching paragraph.

### 6. Ledgered synthesis fixes (in-file, so they ride along)

- **Confidence scoping:** rule confidence boosts apply only to the agents matched by the rule, not globally to the incident.
- **Dead `bestClusterPerAgent` de-dup:** the per-agent best-cluster map computed in `synthesizeRootCause` (~`root-cause-synthesis.ts:367-377`) is computed but never applied, so mixed incidents fire both RDS rules for the same agent. Wire it up (or delete it and de-dup where clusters are consumed) so one agent contributes to at most its best-matching cluster; add a mixed-incident regression test asserting a single RDS rule fires.

(The previously ledgered same-kind ordering fix shipped in `c61991e` with regression tests and is **not** part of this PR.)

## Error handling

No new runtime failure modes: maturity is a static manifest field; an unregistered or maturity-less kind degrades to the best-effort label. An enforcement test locks in that all registered manifests declare maturity.

## Testing

- Unit tests: visibility bucketing by maturity (live/best-effort/blocked/invisible), maturity-map plumbing including the unregistered-kind default, best-effort caveat present on simulator-agent findings in human + machine modes, fallback-summary coverage sentence.
- Enforcement test (knowledge-map style, per Arc 1 precedent): every registered agent manifest declares a maturity value; the visibility renderer has a mapping for every value.
- Synthesis: regression tests for confidence scoping and the mixed-incident single-cluster behavior.
- Snapshot updates for scan human output.

## Acceptance criteria

- `crisismode scan --json` distinguishes live-validated and best-effort watching entries, and simulator-agent findings carry `bestEffort: true`.
- The visibility watching count equals the count of live-validated watched kinds only; `buildHeadline`'s "checked" count and score are unchanged by this PR.
- No output surface renders a correlation match as a definitive root cause; a mixed RDS incident fires exactly one RDS correlation rule.
- 2323+ tests green; typecheck and lint clean.
