# PR 1 — Honesty Foundation: Maturity Surfacing + Inference Reframe

**Date:** 2026-08-05
**Series:** Reliability-first (PR 1 of 5). No dependencies; every later PR builds on the output contract this PR establishes.

## Problem

CrisisMode registers 20 agents but only 6 are `live_validated` (pg-replication, dns, tls, disk, backup, kubernetes). The other 14 declare `maturity: 'simulator_only'` in their manifests, yet nothing in scan output distinguishes them — a detected Kafka broker renders as "watching" with the same confidence as a live-validated Postgres. For the target user (a vibe coder who cannot independently judge our claims), this is a trust liability.

Separately, `src/framework/root-cause-synthesis.ts` contains 11 hand-authored `CORRELATION_RULES` that present incident-shape pattern matches as root causes with confidence boosts. These are the brittle part of the deterministic layer: real incidents are combinatorial, and each added rule increases cross-rule interaction surface (we have already shipped two fixes for this: pairwise `requiredTypesByKind` and signal-map keying).

## Goals

1. Scan output never implies live-validated coverage that doesn't exist.
2. Correlation output is framed as investigation guidance, not root-cause assertion.
3. The correlation-rule set is frozen under an explicit written policy.
4. The two ledgered synthesis follow-ups from Arc 3 are fixed.

## Non-goals

- Removing, quarantining, or gating any agent (decision: label + de-emphasize, nothing deleted).
- Changing autodiscovery behavior — detection is unchanged; only presentation and claims change.
- Adding new correlation rules or new inference of any kind.

## Design

### 1. Maturity in the visibility report

`buildVisibilityReport` (src/cli/visibility.ts) currently buckets entries as watching / blocked / invisible. Change:

- `VisibilityEntry` gains `maturity: 'live_validated' | 'simulator_only'`, sourced from the agent manifest.
- Human output splits the watching bucket: **Watching** (live-validated) and **Watching (best-effort)** with a one-line honest hint: "checks exist but have never been validated against a real <system>; treat findings as leads, not conclusions."
- Machine mode (`--json`) includes the `maturity` field per entry. Pipe mode continues to omit the visibility section (pre-existing convention, unchanged).

### 2. Scan claims count only validated coverage

- The scan headline ("N systems watched") and `generatePlainEnglishSummary` count only kinds whose agent is `live_validated`. Best-effort kinds are mentioned separately, never folded into the coverage number.
- Findings from simulator-only agents are still emitted (working read-only probes are not discarded) but carry a best-effort caveat: a `bestEffort: true` field in machine output and a suffix line in the human explanation.

### 3. `agent list` maturity column

`crisismode agent list` gains a maturity column so the roster is honest at a glance. `agent info` shows the same field with the hint text.

### 4. Synthesis reframe (root-cause-synthesis.ts)

- Presentation wording changes from root-cause assertion ("Recent deployment triggered cascading failures") to investigation-path framing: the rule's `rootCauseTemplate` output is rendered under a "Likely investigation path" / "hint" heading with the `investigationOrder` as the actionable content. Templates themselves keep their text; the *framing* around them changes in output layers (scan, incident report, operator summary).
- Confidence language is capped: rendered confidence never exceeds "possible pattern match"; numeric confidence stays internal for ordering only in human output (machine output keeps the number, documented as ordering weight, not probability).
- A file-header contract documents the freeze policy: **no new correlation rules unless a new agent class ships with a concretely evidenced signal pairing; no speculative incident templates.** CONTRIBUTING.md gets a matching paragraph.

### 5. Ledgered synthesis fixes (in-file, so they ride along)

- **Confidence scoping:** rule confidence boosts apply only to the agents matched by the rule, not globally to the incident.
- **`agentSignalTypes` same-kind order dependence:** when multiple agents share a kind, signal-type aggregation must not depend on registration/iteration order; key aggregation deterministically (by agent id) and add a regression test with two same-kind agents in both orders.

## Error handling

No new runtime failure modes: maturity is a static manifest field; a missing maturity value fails the existing manifest validation (all 20 manifests already declare it — an enforcement test locks this in).

## Testing

- Unit tests: visibility bucketing by maturity (live/best-effort/blocked/invisible), headline count excludes simulator-only kinds, best-effort caveat present on simulator-agent findings in human + machine modes.
- Enforcement test (knowledge-map style, per Arc 1 precedent): every registered agent manifest declares a maturity value; the visibility renderer has a mapping for every value.
- Synthesis: regression tests for confidence scoping and same-kind ordering (both orders produce identical output).
- Snapshot updates for scan human output.

## Acceptance criteria

- `crisismode scan --json` distinguishes live-validated and best-effort watching entries.
- Headline coverage number equals the count of live-validated watched kinds only.
- No output surface renders a correlation match as a definitive root cause.
- 2323+ tests green; typecheck and lint clean.
