# Guidance-Grade Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "here is what to click in the console" from inline prose in one agent into a structured, registry-backed `RemediationGuide` type that every CLI surface renders the same way.

**Architecture:** The type lives in `@crisismode/agent-sdk` (types only, zero runtime dependencies). The content and the registry live in the main package under `src/framework/guidance/` as static data with a lookup index keyed by finding type. One pure line-builder (`src/framework/guidance/render.ts`) produces the guide text; `src/cli/output.ts` is the single CLI rendering path that wraps it with mode/color/terse handling, and every surface (scan, diagnose, readiness, recover) goes through it. Guides anchor to identifiers the codebase actually emits — readiness rule ids and agent `checkId` constants — and an enforcement test breaks the build if a rule or check is renamed out from under a guide.

**Tech Stack:** TypeScript 7 (strict, ESM/NodeNext), pnpm workspaces, vitest, chalk, ESLint flat config.

## Global Constraints

These apply to every task. Do not restate them per task; do not violate them.

- **Series-wide check-id convention (decided at PR 3's review, applies to every agent).** Each agent exports a keyed `as const` object named `<AGENT>_CHECK_IDS` from **`src/agent/<agent>/check-ids.ts`**, re-exported from that agent's `backend.ts` for import convenience. Consumers read the values with `Object.values(...)`. This plan's `AWS_RDS_CHECK_IDS` follows it, and so does every anchoring import below.
- **Series position.** This is PR 5 of the reliability-first series. PRs 1–4 are merged.
  - **PR 3** shipped `src/agent/llm-provider/` with **six** checkIds — `llm-provider.key_present`, `llm-provider.key_valid`, `llm-provider.quota_billing`, `llm-provider.rate_limit_headroom`, `llm-provider.model_deprecated`, `llm-provider.provider_status` — as the object `LLM_PROVIDER_CHECK_IDS` (keys `keyPresent`, `keyValid`, `quotaBilling`, `rateLimitHeadroom`, `modelDeprecated`, `providerStatus`) at `src/agent/llm-provider/check-ids.ts`.
  - **PR 4** shipped `src/agent/vector-store/` with the object `VECTOR_STORE_CHECK_IDS` at `src/agent/vector-store/check-ids.ts` holding `vector-store.reachable`, `vector-store.auth_valid`, `vector-store.index_status`, plus readiness rules `vector-index-missing` and `ivfflat-lists-mismatch`.
  - All three constants — `LLM_PROVIDER_CHECK_IDS`, `VECTOR_STORE_CHECK_IDS`, `AWS_RDS_CHECK_IDS` — have the same shape and the same home: a keyed `as const` object in the agent's own `check-ids.ts`, read via `Object.values(...)`. There is no per-agent variation to account for. The convention was ratified after PR 3's and PR 4's plan documents were written, so those documents describe earlier shapes; the code is canonical, and Task 5 Step 1 verifies it before anything imports it.
- **PR 3 already owns three edits this plan touches.** `HealthSignal.checkId?: string` (agent-sdk), `ScanFinding.checkId?: string` and its `signals[].checkId?: string` (`src/cli/output.ts`), and the `checkId` spread in `src/cli/commands/scan.ts`'s health-signal mapping all ship in PR 3. Every step below that mentions them says "verify present, skip if so" — do not redeclare them and do not duplicate the spread.
- **Match the declaration style already in the file.** PR 3 writes these as `checkId?: string` (no explicit `| undefined`), and `ScanFinding`'s neighbours from PR 1 (`bestEffort?: boolean`) and PR 2 (`possiblyObserverCaused?: boolean`) follow the same style. That is a deliberate local exception to the `foo?: T | undefined` convention below: **new** members this PR introduces use `?: T | undefined`; members shared with PR 1–3 keep their existing style so the diff stays additive.
- **`src/types/index.ts` is `export * from '@crisismode/agent-sdk'`,** so exporting a new type from the SDK barrel is enough — no edit to the main package's barrel is needed. The per-file shim (`src/types/remediation-guide.ts`) exists only to preserve the `../types/<name>.js` import convention.
- **Do not create a branch.** Work on the current branch. Commit after every task, using Conventional Commits with scope `guidance` (or the scope of the file being changed, e.g. `feat(aws-rds): ...` for the migration task).
- **TypeScript strict, ESM NodeNext.** Every relative import carries a `.js` extension, including in tests. No default exports — named exports only. Use `import type { ... }` for type-only imports.
- **`@crisismode/agent-sdk` stays types-only.** No runtime code, no imports of anything outside the SDK, zero dependencies. Guide *content* and the registry live in the main package.
- **The SDK is consumed through its build output.** `node_modules/@crisismode/agent-sdk` is a symlink to `packages/agent-sdk`, whose `main`/`types` point at `dist/`. After editing any file under `packages/agent-sdk/src/`, run `pnpm --filter @crisismode/agent-sdk run build` before `pnpm vitest` or the main package will not see the new types. (`pnpm run typecheck` builds the SDK first; `pnpm test` does not.)
- **Optional-property style.** `exactOptionalPropertyTypes` is on. Declare optional interface members as `foo?: T | undefined`, and build objects with conditional spreads (`...(x !== undefined ? { x } : {})`) rather than assigning `undefined`.
- **TDD.** Write the failing test, run it, watch it fail for the right reason, then implement. Never write implementation first.
- **Test commands.** Single file: `pnpm vitest run src/__tests__/<file>.test.ts`. Full suite: `pnpm test`. Types: `pnpm run typecheck`. Lint: `pnpm run lint` (autofix: `pnpm run lint:fix`).
- **Every source file starts with the two-line SPDX header** used throughout the repo:
  ```ts
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **Guidance is static data.** No I/O, no network, no filesystem, no clock-dependent behavior in the registry or renderer (the freshness *test* reads the clock; the runtime never does).
- **No secrets, no invented infrastructure identifiers.** Guide content uses `<angle-bracket>` placeholder tokens (`<instance>`, `<security-group-id>`, `<db-port>`, `<target-storage-gb>`) that callers substitute at render time.
- **`verifiedOn` is `2026-08-05` for every guide in this PR.** Every console path in this plan was written from the best available knowledge at authoring time and **must be human-verified by the implementer before the date is left in place**. If you follow a path and it differs, fix the steps — the date stays `2026-08-05` only if you actually walked the path on or after that date. If you cannot verify a path, say so in the PR description rather than silently shipping the date.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/agent-sdk/src/types/remediation-guide.ts` | The `RemediationGuide` interface. Types only. |
| `src/types/remediation-guide.ts` | Re-export shim, matching the convention of the other `src/types/*.ts` files. |
| `src/framework/guidance/registry.ts` | The registry: aggregated guide list, id index, finding-type index, lookup functions, placeholder substitution. No content. |
| `src/framework/guidance/render.ts` | Pure line-builder shared by the CLI and by plan-step text. No chalk, no console. |
| `src/framework/guidance/attach.ts` | Generic helpers that attach guides to findings by `checkId` or `ruleId`. Structural generics — no imports from `src/cli/` or `src/readiness/`. |
| `src/framework/guidance/platforms.ts` | `platformsForTarget(kind, targetName)` — resolves which guide platforms may attach to a target, so an Anthropic user never sees OpenAI steps. |
| `src/framework/guidance/guides/anthropic.ts` | Anthropic Console guide content. |
| `src/framework/guidance/guides/openai.ts` | OpenAI Platform guide content. |
| `src/framework/guidance/guides/supabase.ts` | Supabase guide content (pooler, connection cap, compute upgrade, pgvector index). |
| `src/framework/guidance/guides/neon.ts` | Neon guide content (pooled endpoint, compute size). |
| `src/framework/guidance/guides/aws-rds.ts` | The four migrated aws-rds guides. |
| `src/agent/aws-rds/check-ids.ts` | `AWS_RDS_CHECK_IDS` + source→checkId map. |
| `src/__tests__/guidance-registry.test.ts` | Registry validation, freshness, and anchoring enforcement. |
| `src/__tests__/guidance-render.test.ts` | Pure renderer: full and terse forms. |
| `src/__tests__/guidance-output.test.ts` | CLI wiring: scan human/pipe/machine, diagnose, readiness. |

**Modified:**

| File | Change |
|---|---|
| `packages/agent-sdk/src/index.ts` | Export the new type module. |
| `packages/agent-sdk/src/types/diagnosis-result.ts` | `DiagnosisFinding` gains `checkId?` (PR 3 may already have added it) and `guides?`. |
| `packages/agent-sdk/src/types/health.ts` | `HealthSignal.checkId?` — **PR 3's edit**; verify only. |
| `packages/agent-sdk/src/types/step-types.ts` | `HumanNotificationStep.message` gains `guideIds?` and `guideVars?`. |
| `src/cli/output.ts` | `ScanFinding` gains `guides?`/`guidancePlatforms?` (its `checkId?` and signal `checkId?` are PR 3's); `printRemediationGuides()`; attachment + rendering in `printScanSummary`, `printDiagnosis`, and `printPlan`; `guide:<id>` column in pipe mode. |
| `src/cli/commands/scan.ts` | Populate `guidancePlatforms` from the target (the `checkId` spread is PR 3's — verify only). |
| `src/cli/commands/diagnose.ts` | Pass the target's guidance scope into `printDiagnosis`. |
| `src/cli/commands/readiness.ts` | Attach guides to readiness findings; render them in `renderReadinessReport`. |
| `src/readiness/types.ts` | `ReadinessFinding` gains `guides?`. |
| `src/agent/aws-rds/agent.ts` | Tag control-plane signals/findings with `checkId`; build suggestion text from guides instead of inline strings. |
| `src/__tests__/aws-rds-agent-control-plane.test.ts` | Updated assertions: same console paths, now via guides. |
| `CONTRIBUTING.md` | The `verifiedOn` re-verification rule. |
| `CLAUDE.md` | Key-files row for the guidance module. |

**Anchoring contract (used by Task 5's enforcement test).** `applicableFindingTypes` entries must resolve against the union of:
- registered readiness rule ids from `allRules` in `src/readiness/rules/index.ts` — today `connection-headroom`, `connection-limit-tier`, `long-transactions`, `missing-index`, `slow-queries`, `serverless-pooling`, plus PR 4's `vector-index-missing` and `ivfflat-lists-mismatch`;
- `checkId` constants exported by agents: `LLM_PROVIDER_CHECK_IDS` (PR 3), `VECTOR_STORE_CHECK_IDS` (PR 4), and `AWS_RDS_CHECK_IDS` (added by this PR in Task 5).

**aws-rds `checkId` names.** The spec proposed `aws-rds.storage_full`, `aws-rds.instance_class`, `aws-rds.sg_inbound`, `aws-rds.instance_stopped`, and said final names are fixed at implementation to match the migrated strings one-to-one. The migrated conditions are keyed off diagnosis-finding `source` values in `src/agent/aws-rds/agent.ts`, so the names follow those sources:

| finding source | checkId | note |
|---|---|---|
| `rds_storage` | `aws-rds.storage_full` | unchanged from the spec |
| `rds_connection_saturation` | `aws-rds.connection_saturation` | renamed: `instance_class` named the *fix*, not the check |
| `rds_security_group` | `aws-rds.security_group` | renamed from `sg_inbound` to match the source |
| `rds_instance_status` | `aws-rds.instance_status` | renamed from `instance_stopped`: the check fires on any non-`available` status (the agent's own comment notes stopped/failed/incompatible-parameters; only `stopped` is exercised by the simulator) |

**Design decisions this plan locks in** (the spec left these open; do not re-litigate them mid-implementation):

- **Placeholders, not per-target guides.** Guides are static and shared, but the aws-rds strings interpolate an instance id, security-group id, port, and target size. Guides carry `<angle-bracket>` tokens and callers substitute with `applyGuideVariables()` — matching the `<larger-class>` / `<app-security-group-id>` tokens the existing strings already use. Unknown tokens stay visible rather than collapsing to an empty string.
- **Plan steps carry the rendered text, the guide id, and the substitutions.** A suggestion step's `message.detail` is the observation line plus the guide rendered through the shared renderer; `message.guideIds` names the guide and `message.guideVars` records the placeholder values. `printPlan` re-renders the block from `guideIds` + `guideVars` through the registry — it never parses `detail` prose. `detail` stays populated as belt-and-suspenders for consumers that only read plan JSON, and nothing is printed twice because `printPlan` does not print `message.detail`.
- **Guides are filtered by platform when the finding names one.** `llm-provider.key_valid` matches both the Anthropic and OpenAI rotate-key guides, so an unfiltered lookup would tell an Anthropic user to rotate an OpenAI key. `platformsForTarget(kind, targetName)` resolves the platforms a target may show, and the registry lookup filters on it. Three cases, and the distinction is load-bearing: `undefined` means the platform is genuinely unknown (a plain `postgresql` target — show every match, because a connection-limit finding legitimately applies to whichever managed Postgres the user has); a non-empty array means show only those platforms; an **empty** array means the caller knows the platform and has no guides for it (Google, OpenRouter, Pinecone) — show nothing rather than another vendor's console.
- **One renderer, two entry points.** The line-building logic lives in `src/framework/guidance/render.ts` (pure). `src/cli/output.ts` is the only place that colors, indents, and mode-switches it; agents call `formatGuideForPlan()` for step text. This keeps `src/agent/` from importing `src/cli/`.
- **`supabase-pgvector-index` is a deliberate addition beyond the spec's content table.** That table lists three Supabase guides (pooler, connection cap, upgrade); this plan adds a fourth for the pgvector index because PR 4's spec explicitly defers "index guidance text only, structured guidance in PR 5" to this PR, and its two readiness rules are in the anchoring set. If a reviewer wants the spec's table honored literally, deleting this one guide costs nothing else.
- **`aws-rds.instance_status` gets one guide with conditional steps,** not three guides. The migrated code picked one of three status branches; the guide states all three as steps 3–5, so the structured form covers every status the check can report while still naming the observed status in the step name and observation line.

---

## Task 1: `RemediationGuide` type in the Agent SDK

**Files:**
- Create: `packages/agent-sdk/src/types/remediation-guide.ts`
- Create: `src/types/remediation-guide.ts`
- Modify: `packages/agent-sdk/src/index.ts`
- Modify: `packages/agent-sdk/src/types/diagnosis-result.ts`
- Modify: `packages/agent-sdk/src/types/health.ts`
- Modify: `packages/agent-sdk/src/types/step-types.ts`
- Test: `src/__tests__/guidance-registry.test.ts` (created here with a single type-level test; grows in Tasks 2–5)

**Interfaces:**
- Consumes: nothing.
- Produces: `RemediationGuide` (exported from `@crisismode/agent-sdk` and from `../types/remediation-guide.js`) with members `id: string`, `platform: string`, `title: string`, `applicableFindingTypes: string[]`, `url?: string | undefined`, `consoleSteps: string[]`, `cliEquivalent?: string | undefined`, `expectedAfter: string`, `caution?: string | undefined`, `verifiedOn: string`. Also: `DiagnosisFinding.checkId?: string`, `DiagnosisFinding.guides?: RemediationGuide[] | undefined`, `DiagnosisFinding.guideVars?: Record<string, string> | undefined`, `HealthSignal.guideVars?: Record<string, string> | undefined`, `HumanNotificationStep.message.guideIds?: string[] | undefined`, `HumanNotificationStep.message.guideVars?: Record<string, string> | undefined`. (`HealthSignal.checkId?: string` is PR 3's — this task only verifies it.) `guideVars` is new carrier for both types: the per-target substitutions (e.g. `{ instance: 'prod-db-01' }`) a checkId's matched guide needs resolved *before* it is rendered in scan or diagnose output — without it, attachment can only offer the raw guide with its `<instance>`-style placeholders still literal.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/guidance-registry.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { RemediationGuide } from '../types/remediation-guide.js';

describe('RemediationGuide type', () => {
  it('accepts a guide with every field populated', () => {
    const guide: RemediationGuide = {
      id: 'example-guide',
      platform: 'example-console',
      title: 'Do the thing',
      applicableFindingTypes: ['example.check'],
      url: 'https://example.com/console',
      consoleSteps: ['Open the console.', 'Click the button.'],
      cliEquivalent: 'example-cli do-the-thing',
      expectedAfter: 'The thing is done.',
      caution: 'The thing cannot be undone.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.consoleSteps).toHaveLength(2);
  });

  it('accepts a guide with only the required fields', () => {
    const guide: RemediationGuide = {
      id: 'minimal-guide',
      platform: 'example-console',
      title: 'Minimal',
      applicableFindingTypes: ['example.check'],
      consoleSteps: ['Open the console.'],
      expectedAfter: 'Something observable happened.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.url).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: FAIL — `Failed to resolve import "../types/remediation-guide.js"`.

- [ ] **Step 3: Add the type to the SDK**

Create `packages/agent-sdk/src/types/remediation-guide.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * A structured, human-performed remediation path — the "open this URL, click
 * this, expect that" instructions for fixes CrisisMode can see but must not
 * execute (dashboard actions on managed platforms). Static data: guides are
 * authored in the main package, keyed to finding types, and rendered
 * identically across every output mode.
 */
export interface RemediationGuide {
  /** Unique across the registry, e.g. 'anthropic-rotate-key'. */
  id: string;
  /** Platform the steps are for, e.g. 'anthropic-console', 'supabase', 'aws-rds'. */
  platform: string;
  /** Imperative one-liner, e.g. "Rotate your Anthropic API key". */
  title: string;
  /**
   * Finding/signal types this guide answers: readiness rule ids
   * (e.g. 'serverless-pooling') or agent checkIds (e.g. 'llm-provider.key_valid').
   */
  applicableFindingTypes: string[];
  /** Stable console entry URL — no account-specific deep links. */
  url?: string | undefined;
  /** Ordered human steps, e.g. "Settings → API keys → Create Key". */
  consoleSteps: string[];
  /** Optional single-line equivalent for users comfortable with a terminal. */
  cliEquivalent?: string | undefined;
  /** What the user should observe when it worked. */
  expectedAfter: string;
  /** Risk note, when a step is destructive-adjacent (e.g. the old key stops working). */
  caution?: string | undefined;
  /** ISO date (YYYY-MM-DD) the path was last human-verified. */
  verifiedOn: string;
}
```

- [ ] **Step 4: Export it from the SDK barrel**

In `packages/agent-sdk/src/index.ts`, add the export next to the other type exports (after the `action-template` line):

```ts
export * from './types/action-template.js';
export * from './types/remediation-guide.js';
```

- [ ] **Step 5: Add the shim in the main package**

Create `src/types/remediation-guide.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Re-exported from @crisismode/agent-sdk — the canonical definition (with doc
// comments) lives at packages/agent-sdk/src/types/remediation-guide.ts. This
// shim matches the '../types/<name>.js' import convention used elsewhere.
export type { RemediationGuide } from '@crisismode/agent-sdk';
```

- [ ] **Step 6: Add the carrier fields to the existing SDK types**

First confirm what PR 3 already landed:

Run: `grep -n "checkId" packages/agent-sdk/src/types/health.ts packages/agent-sdk/src/types/diagnosis-result.ts`

**Expect both hits.** PR 3 adds `HealthSignal.checkId?: string` *and* `DiagnosisFinding.checkId?: string` (its `diagnose()` tags per-finding check ids), so the normal path here is: change nothing in `health.ts`, and add only `guides` to `diagnosis-result.ts`. Adding the field this PR needs is a one-line edit precisely because PR 3 did the rest.

If either hit is missing — meaning PR 3 landed differently than planned — add the missing one in PR 3's exact style (`?: string`, no explicit `| undefined`), `HealthSignal`'s after `entityId`:

```ts
  /** Stable id of the check that produced this signal (e.g. 'llm-provider.key_valid') — consumed by the guidance registry. Optional: agents adopt it incrementally. */
  checkId?: string;
```

Then, regardless of what PR 3 landed, append `guideVars` to `HealthSignal` — this one is new to this PR, so it always needs adding:

```ts
  /** Per-target substitutions (e.g. { instance: 'prod-db-01' }) for this signal's checkId's matched guide, applied before the guide is attached. Undefined when the checkId's guide has no placeholders to fill. */
  guideVars?: Record<string, string> | undefined;
```

In `packages/agent-sdk/src/types/diagnosis-result.ts`, add the import and append the `guides` member to `DiagnosisFinding` after `learnMoreUrl` (plus the `checkId` line only in the unlikely case the grep above did not find it):

```ts
import type { RemediationGuide } from './remediation-guide.js';
```

```ts
  /** Stable check identifier, e.g. 'aws-rds.storage_full' — the guidance registry's anchor. */
  checkId?: string;
  /** Remediation guides matched to this finding's checkId (attached at render time). */
  guides?: RemediationGuide[] | undefined;
  /** Per-target substitutions for this finding's checkId's matched guide, applied before attachment — mirrors HealthSignal.guideVars. */
  guideVars?: Record<string, string> | undefined;
```

In `packages/agent-sdk/src/types/step-types.ts`, extend `HumanNotificationStep.message` (append after `actionRequired`):

```ts
  message: {
    summary: string;
    detail: string;
    contextReferences?: string[];
    actionRequired: boolean;
    /** Ids of RemediationGuides this notification's detail was rendered from. */
    guideIds?: string[] | undefined;
    /** Placeholder substitutions those guides were rendered with, so any renderer can reproduce the same text from the registry. */
    guideVars?: Record<string, string> | undefined;
  };
```

- [ ] **Step 7: Build the SDK and run the test**

Run: `pnpm --filter @crisismode/agent-sdk run build && pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-sdk/src/types/remediation-guide.ts packages/agent-sdk/src/types/diagnosis-result.ts packages/agent-sdk/src/types/step-types.ts packages/agent-sdk/src/index.ts src/types/remediation-guide.ts src/__tests__/guidance-registry.test.ts
git commit -m "feat(agent-sdk): add RemediationGuide type and finding guidance carriers"
```

(`packages/agent-sdk/src/types/health.ts` is deliberately absent — `HealthSignal.checkId` is PR 3's. Add it to the `git add` only if Step 6 found it missing and you re-added it.)

---

## Task 2: Registry with lookup, substitution, and validation

**Files:**
- Create: `src/framework/guidance/registry.ts`
- Create: `src/framework/guidance/platforms.ts`
- Create: `src/framework/guidance/guides/anthropic.ts`
- Modify: `src/__tests__/guidance-registry.test.ts`

**Interfaces:**
- Consumes: `RemediationGuide` from `../../types/remediation-guide.js`.
- Produces, from `src/framework/guidance/registry.ts`:
  - `REMEDIATION_GUIDES: readonly RemediationGuide[]`
  - `interface GuidanceScope { platforms?: readonly string[] | undefined }`
  - `guidesForFindingType(findingType: string, scope?: GuidanceScope): RemediationGuide[]`
  - `guidesForFindingTypes(findingTypes: readonly string[], scope?: GuidanceScope): RemediationGuide[]` — deduped by id, stable order
  - `getGuideById(id: string): RemediationGuide | undefined`
  - `applyGuideVariables(guide: RemediationGuide, vars: Record<string, string>): RemediationGuide`
- Produces, from `src/framework/guidance/platforms.ts`: `platformsForTarget(kind: string, targetName: string): readonly string[] | undefined`.
- Produces, from `src/framework/guidance/guides/anthropic.ts`: `anthropicGuides: RemediationGuide[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/guidance-registry.test.ts` (keep the existing imports and add these):

```ts
import {
  REMEDIATION_GUIDES,
  guidesForFindingType,
  guidesForFindingTypes,
  getGuideById,
  applyGuideVariables,
} from '../framework/guidance/registry.js';
import { platformsForTarget } from '../framework/guidance/platforms.js';

describe('guidance registry — structure', () => {
  it('has no duplicate guide ids', () => {
    const seen = new Set<string>();
    for (const g of REMEDIATION_GUIDES) {
      expect(seen.has(g.id), `duplicate guide id '${g.id}'`).toBe(false);
      seen.add(g.id);
    }
  });

  it('every guide has non-empty required content', () => {
    for (const g of REMEDIATION_GUIDES) {
      expect(g.id.length, 'guide id must be non-empty').toBeGreaterThan(0);
      expect(g.platform.length, `guide '${g.id}' has an empty platform`).toBeGreaterThan(0);
      expect(g.title.length, `guide '${g.id}' has an empty title`).toBeGreaterThan(0);
      expect(g.consoleSteps.length, `guide '${g.id}' has no console steps`).toBeGreaterThan(0);
      for (const step of g.consoleSteps) {
        expect(step.trim().length, `guide '${g.id}' has an empty console step`).toBeGreaterThan(0);
      }
      expect(g.expectedAfter.trim().length, `guide '${g.id}' has no expectedAfter`).toBeGreaterThan(0);
      expect(g.applicableFindingTypes.length, `guide '${g.id}' is not keyed to any finding type`).toBeGreaterThan(0);
    }
  });

  it('every verifiedOn is a parseable ISO date', () => {
    for (const g of REMEDIATION_GUIDES) {
      expect(g.verifiedOn, `guide '${g.id}' has a malformed verifiedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Number.isNaN(Date.parse(g.verifiedOn)),
        `guide '${g.id}' verifiedOn does not parse as a date`,
      ).toBe(false);
    }
  });

  it('every url is https', () => {
    for (const g of REMEDIATION_GUIDES) {
      if (g.url !== undefined) {
        expect(g.url, `guide '${g.id}' has a non-https url`).toMatch(/^https:\/\//);
      }
    }
  });
});

describe('guidance registry — lookup', () => {
  it('finds the Anthropic key-rotation guide by its finding type', () => {
    const guides = guidesForFindingType('llm-provider.key_valid');
    expect(guides.map((g) => g.id)).toContain('anthropic-rotate-key');
  });

  it('returns an empty array for a finding type with no guides', () => {
    expect(guidesForFindingType('nothing.matches_this')).toEqual([]);
  });

  it('dedupes guides matched through more than one finding type', () => {
    const ids = guidesForFindingTypes(['llm-provider.key_valid', 'llm-provider.key_valid']).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('looks a guide up by id', () => {
    expect(getGuideById('anthropic-rotate-key')?.platform).toBe('anthropic-console');
    expect(getGuideById('no-such-guide')).toBeUndefined();
  });
});

describe('guidance scope — platform filtering', () => {
  it('keeps only guides for the scoped platform', () => {
    const ids = guidesForFindingType('llm-provider.key_valid', { platforms: ['anthropic-console'] }).map((g) => g.id);
    expect(ids).toContain('anthropic-rotate-key');
    expect(ids).not.toContain('openai-rotate-key');
  });

  it('an empty platform list means the caller knows the platform and has no guides for it', () => {
    expect(guidesForFindingType('llm-provider.key_valid', { platforms: [] })).toEqual([]);
  });

  it('an absent scope means the platform is unknown — every match attaches', () => {
    expect(guidesForFindingType('llm-provider.key_valid').length).toBeGreaterThan(0);
  });
});

describe('platformsForTarget', () => {
  it('maps a provider-named llm-provider target to that provider\'s console', () => {
    expect(platformsForTarget('llm-provider', 'anthropic')).toEqual(['anthropic-console']);
    expect(platformsForTarget('llm-provider', 'openai')).toEqual(['openai-platform']);
  });

  it('returns an empty list for a provider with no guides, never another vendor\'s', () => {
    expect(platformsForTarget('llm-provider', 'google')).toEqual([]);
    expect(platformsForTarget('llm-provider', 'openrouter')).toEqual([]);
    expect(platformsForTarget('vector-store', 'pinecone')).toEqual([]);
  });

  it('scopes aws-rds targets to the aws-rds platform', () => {
    expect(platformsForTarget('aws-rds', 'prod-db-01')).toEqual(['aws-rds']);
  });

  it('leaves the platform unknown for a plain postgres target', () => {
    expect(platformsForTarget('postgresql', 'primary')).toBeUndefined();
  });
});

describe('applyGuideVariables', () => {
  it('substitutes placeholder tokens across every text field', () => {
    const guide: RemediationGuide = {
      id: 'token-test',
      platform: 'aws-rds',
      title: 'Resize <instance>',
      applicableFindingTypes: ['aws-rds.storage_full'],
      consoleSteps: ['Open Databases → <instance>.', 'Set storage to <target-storage-gb> GiB.'],
      cliEquivalent: 'aws rds modify-db-instance --db-instance-identifier <instance>',
      expectedAfter: '<instance> returns to available.',
      caution: 'Resizing <instance> reboots it.',
      verifiedOn: '2026-08-05',
    };

    const resolved = applyGuideVariables(guide, { instance: 'prod-db-01', 'target-storage-gb': '40' });

    expect(resolved.title).toBe('Resize prod-db-01');
    expect(resolved.consoleSteps[1]).toBe('Set storage to 40 GiB.');
    expect(resolved.cliEquivalent).toContain('prod-db-01');
    expect(resolved.expectedAfter).toBe('prod-db-01 returns to available.');
    expect(resolved.caution).toBe('Resizing prod-db-01 reboots it.');
  });

  it('leaves unknown tokens in place and does not mutate the original', () => {
    const guide = getGuideById('anthropic-rotate-key')!;
    const before = JSON.stringify(guide);
    const resolved = applyGuideVariables(guide, { instance: 'prod-db-01' });
    expect(JSON.stringify(guide)).toBe(before);
    expect(resolved.id).toBe(guide.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: FAIL — `Failed to resolve import "../framework/guidance/registry.js"`.

- [ ] **Step 3: Write the Anthropic guide content**

Create `src/framework/guidance/guides/anthropic.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * Anthropic Console remediation paths, keyed to the llm-provider agent's
 * checkIds. Console paths must be re-verified by a human before verifiedOn
 * is updated — see CONTRIBUTING.md.
 */
export const anthropicGuides: RemediationGuide[] = [
  {
    id: 'anthropic-rotate-key',
    platform: 'anthropic-console',
    title: 'Rotate your Anthropic API key',
    applicableFindingTypes: ['llm-provider.key_valid'],
    url: 'https://console.anthropic.com/settings/keys',
    consoleSteps: [
      'Open the Anthropic Console and sign in to the workspace your app uses.',
      'Go to Settings → API keys → Create Key, and name it after the app and environment (e.g. "myapp-production").',
      'Copy the key immediately — the console shows the full value only once.',
      'Set ANTHROPIC_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.',
      'Return to Settings → API keys and delete the old key only after the new one is live.',
    ],
    cliEquivalent:
      'curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"',
    expectedAfter:
      'The key check passes on the next `crisismode scan`, and API calls stop returning 401 authentication_error.',
    caution:
      'Deleting the old key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'anthropic-rate-limits',
    platform: 'anthropic-console',
    title: 'Check and raise your Anthropic rate limits',
    applicableFindingTypes: ['llm-provider.rate_limit_headroom'],
    url: 'https://console.anthropic.com/settings/limits',
    consoleSteps: [
      'Open the Anthropic Console → Settings → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.',
      'Compare those limits against the headroom CrisisMode reported — the limit that runs out first is the one to act on.',
      'Make the app handle 429 responses by waiting for the number of seconds in the retry-after header instead of retrying immediately.',
      'To raise the limits, advance your usage tier by adding credits in Settings → Billing; for sustained higher limits, contact Anthropic sales from the same page.',
    ],
    cliEquivalent:
      'curl -s -D - -o /dev/null https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | grep -i anthropic-ratelimit',
    expectedAfter:
      'Rate-limit headroom stays above 20% during peak traffic and 429 responses stop appearing in application logs.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'anthropic-billing-credits',
    platform: 'anthropic-console',
    title: 'Restore Anthropic billing or credit balance',
    applicableFindingTypes: ['llm-provider.quota_billing'],
    url: 'https://console.anthropic.com/settings/billing',
    consoleSteps: [
      'Open the Anthropic Console → Settings → Billing and check the current credit balance.',
      'Confirm the workspace has a valid payment method attached.',
      'Buy credits, then enable auto-reload so the balance cannot reach zero mid-incident.',
      'Re-run `crisismode scan` to confirm the quota/billing check has cleared.',
    ],
    expectedAfter:
      'API calls stop failing with billing or credit errors, and the quota/billing check reports healthy.',
    verifiedOn: '2026-08-05',
  },
];
```

- [ ] **Step 4: Write the registry**

Create `src/framework/guidance/registry.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static registry of remediation guides, indexed by the finding types they
 * answer. Pure data plus lookup — no I/O, no clock, no network. Validation
 * (unique ids, resolvable finding types, freshness) is enforced by tests, not
 * at runtime, so a malformed guide breaks the build rather than a recovery.
 */

import type { RemediationGuide } from '../../types/remediation-guide.js';
import { anthropicGuides } from './guides/anthropic.js';

export const REMEDIATION_GUIDES: readonly RemediationGuide[] = [
  ...anthropicGuides,
];

const BY_ID = new Map<string, RemediationGuide>(REMEDIATION_GUIDES.map((g) => [g.id, g]));

const BY_FINDING_TYPE = ((): Map<string, RemediationGuide[]> => {
  const index = new Map<string, RemediationGuide[]>();
  for (const guide of REMEDIATION_GUIDES) {
    for (const findingType of guide.applicableFindingTypes) {
      const bucket = index.get(findingType);
      if (bucket) bucket.push(guide);
      else index.set(findingType, [guide]);
    }
  }
  return index;
})();

/**
 * Which platforms' guides may attach.
 *
 * `platforms: undefined` — the caller does not know the platform (a plain
 * postgresql target could be Supabase, Neon, or self-hosted): attach every
 * match. `platforms: []` — the caller knows the platform and the registry has
 * no guides for it (Google, OpenRouter, Pinecone): attach nothing, rather than
 * handing the user another vendor's console steps.
 */
export interface GuidanceScope {
  platforms?: readonly string[] | undefined;
}

function inScope(guide: RemediationGuide, scope?: GuidanceScope): boolean {
  if (scope?.platforms === undefined) return true;
  return scope.platforms.includes(guide.platform);
}

/** Guides answering one finding type (readiness rule id or agent checkId). */
export function guidesForFindingType(findingType: string, scope?: GuidanceScope): RemediationGuide[] {
  return (BY_FINDING_TYPE.get(findingType) ?? []).filter((g) => inScope(g, scope));
}

/** Guides answering any of several finding types, deduped, registry order preserved. */
export function guidesForFindingTypes(
  findingTypes: readonly string[],
  scope?: GuidanceScope,
): RemediationGuide[] {
  const seen = new Set<string>();
  const matched: RemediationGuide[] = [];
  for (const findingType of findingTypes) {
    for (const guide of BY_FINDING_TYPE.get(findingType) ?? []) {
      if (seen.has(guide.id) || !inScope(guide, scope)) continue;
      seen.add(guide.id);
      matched.push(guide);
    }
  }
  return matched;
}

export function getGuideById(id: string): RemediationGuide | undefined {
  return BY_ID.get(id);
}

/**
 * Replace `<token>` placeholders with caller-supplied values, returning a new
 * guide. Guides are static data shared across targets, so the concrete
 * instance/security-group/port values are substituted at render time rather
 * than baked in. Unknown tokens are left visible on purpose — a literal
 * `<app-security-group-id>` is honest guidance; an empty string is not.
 */
export function applyGuideVariables(
  guide: RemediationGuide,
  vars: Record<string, string>,
): RemediationGuide {
  const substitute = (text: string): string => {
    let out = text;
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`<${key}>`).join(value);
    }
    return out;
  };

  return {
    ...guide,
    title: substitute(guide.title),
    consoleSteps: guide.consoleSteps.map(substitute),
    ...(guide.cliEquivalent !== undefined ? { cliEquivalent: substitute(guide.cliEquivalent) } : {}),
    expectedAfter: substitute(guide.expectedAfter),
    ...(guide.caution !== undefined ? { caution: substitute(guide.caution) } : {}),
  };
}
```

- [ ] **Step 5: Write the platform resolver**

Create `src/framework/guidance/platforms.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Which guide platforms a target may show.
 *
 * A checkId like 'llm-provider.key_valid' is provider-agnostic — both the
 * Anthropic and the OpenAI rotate-key guides answer it — so an unfiltered
 * lookup would tell an Anthropic user to rotate an OpenAI key. PR 3 derives
 * one target per detected provider, so the target itself is what disambiguates.
 *
 * Returning `undefined` (unknown platform) and `[]` (known platform, no
 * guides) are different answers on purpose: see GuidanceScope in registry.ts.
 */

/** Matched against the target name, most specific first. */
const LLM_PROVIDER_PLATFORMS: Array<{ match: RegExp; platform: string }> = [
  { match: /anthropic|claude/i, platform: 'anthropic-console' },
  { match: /openai|gpt/i, platform: 'openai-platform' },
];

export function platformsForTarget(kind: string, targetName: string): readonly string[] | undefined {
  if (kind === 'llm-provider') {
    for (const entry of LLM_PROVIDER_PLATFORMS) {
      if (entry.match.test(targetName)) return [entry.platform];
    }
    // Google and OpenRouter have no guides yet — show none, never a competitor's.
    return [];
  }
  if (kind === 'vector-store') return [];
  if (kind === 'aws-rds') return ['aws-rds'];
  // Everything else (a plain postgresql target, disk, dns, …) genuinely does
  // not name a platform: show every guide the finding type matches.
  return undefined;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS (all tests in the file). The `not.toContain('openai-rotate-key')` assertion passes trivially today — Task 3 adds the OpenAI guides that make it load-bearing.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/framework/guidance/registry.ts src/framework/guidance/platforms.ts src/framework/guidance/guides/anthropic.ts src/__tests__/guidance-registry.test.ts
git commit -m "feat(guidance): add remediation guide registry with Anthropic console guides"
```

---

## Task 3: Guide content for OpenAI, Supabase, and Neon

**Files:**
- Create: `src/framework/guidance/guides/openai.ts`
- Create: `src/framework/guidance/guides/supabase.ts`
- Create: `src/framework/guidance/guides/neon.ts`
- Modify: `src/framework/guidance/registry.ts`
- Modify: `src/__tests__/guidance-registry.test.ts`

**Interfaces:**
- Consumes: `RemediationGuide`; `REMEDIATION_GUIDES`, `guidesForFindingType` from Task 2.
- Produces: `openaiGuides`, `supabaseGuides`, `neonGuides` (each `RemediationGuide[]`), all folded into `REMEDIATION_GUIDES`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/guidance-registry.test.ts`:

```ts
describe('guidance registry — content coverage', () => {
  const expectedIdsByPlatform: Record<string, string[]> = {
    'anthropic-console': ['anthropic-rotate-key', 'anthropic-rate-limits', 'anthropic-billing-credits'],
    'openai-platform': ['openai-rotate-key', 'openai-usage-limits', 'openai-billing'],
    supabase: [
      'supabase-pooler-mode',
      'supabase-connection-limits',
      'supabase-upgrade-compute',
      'supabase-pgvector-index',
    ],
    neon: ['neon-pooled-connection', 'neon-compute-size'],
  };

  for (const [platform, ids] of Object.entries(expectedIdsByPlatform)) {
    it(`${platform} guides are registered`, () => {
      const registered = REMEDIATION_GUIDES.filter((g) => g.platform === platform).map((g) => g.id);
      for (const id of ids) expect(registered).toContain(id);
    });
  }

  it('serverless pooling findings reach both Supabase and Neon guides', () => {
    const ids = guidesForFindingType('serverless-pooling').map((g) => g.id);
    expect(ids).toContain('supabase-pooler-mode');
    expect(ids).toContain('neon-pooled-connection');
  });

  it('the pgvector index guide answers both vector readiness rules', () => {
    expect(guidesForFindingType('vector-index-missing').map((g) => g.id)).toContain('supabase-pgvector-index');
    expect(guidesForFindingType('ivfflat-lists-mismatch').map((g) => g.id)).toContain('supabase-pgvector-index');
  });

  it('OpenAI quota findings reach a billing guide', () => {
    expect(guidesForFindingType('llm-provider.quota_billing').map((g) => g.id)).toContain('openai-billing');
  });

  it('an Anthropic-scoped finding never surfaces OpenAI steps, and vice versa', () => {
    const anthropic = guidesForFindingTypes(
      ['llm-provider.key_valid', 'llm-provider.quota_billing', 'llm-provider.rate_limit_headroom'],
      { platforms: platformsForTarget('llm-provider', 'anthropic') },
    );
    expect(anthropic.every((g) => g.platform === 'anthropic-console')).toBe(true);
    expect(anthropic.length).toBeGreaterThan(0);

    const openai = guidesForFindingTypes(
      ['llm-provider.key_valid', 'llm-provider.quota_billing'],
      { platforms: platformsForTarget('llm-provider', 'openai') },
    );
    expect(openai.every((g) => g.platform === 'openai-platform')).toBe(true);
    expect(openai.map((g) => g.id)).not.toContain('anthropic-rotate-key');
  });

  it('a provider with no guides gets nothing rather than another vendor\'s console', () => {
    const google = guidesForFindingTypes(
      ['llm-provider.key_valid'],
      { platforms: platformsForTarget('llm-provider', 'google') },
    );
    expect(google).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: FAIL — `expected [ ... ] to contain 'openai-rotate-key'`.

- [ ] **Step 3: Write the OpenAI content**

Create `src/framework/guidance/guides/openai.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

export const openaiGuides: RemediationGuide[] = [
  {
    id: 'openai-rotate-key',
    platform: 'openai-platform',
    title: 'Rotate your OpenAI API key',
    applicableFindingTypes: ['llm-provider.key_valid'],
    url: 'https://platform.openai.com/api-keys',
    consoleSteps: [
      'Open the OpenAI platform API keys page, and check the organization and project selector at the top matches the one your app bills to.',
      'Choose Create new secret key, scope it to the project your app uses, and name it after the app and environment.',
      'Copy the key immediately — the platform shows the full value only once.',
      'Set OPENAI_API_KEY to the new value everywhere the app runs (hosting provider environment variables, local .env, CI secrets), then redeploy.',
      'Return to the API keys page and revoke the old key only after the new one is live.',
    ],
    cliEquivalent: 'curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"',
    expectedAfter: 'The key check passes on the next `crisismode scan`, and API calls stop returning 401.',
    caution:
      'Revoking a key takes effect immediately — anything still using it starts failing. Deploy the new key everywhere first.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'openai-usage-limits',
    platform: 'openai-platform',
    title: 'Check OpenAI usage tier and rate limits',
    applicableFindingTypes: ['llm-provider.rate_limit_headroom', 'llm-provider.quota_billing'],
    url: 'https://platform.openai.com/settings/organization/limits',
    consoleSteps: [
      'Open Settings → Organization → Limits to see your usage tier and the per-model requests-per-minute and tokens-per-minute limits.',
      'Distinguish the two 429 causes: an `insufficient_quota` error means the organization is out of credit (see the billing guide), while a plain rate-limit 429 means you are sending too fast.',
      'Make the app wait for the retry-after header on 429 responses rather than retrying immediately.',
      'Raise the monthly budget or usage limit on the same page if the ceiling is a budget cap rather than a tier limit.',
    ],
    cliEquivalent:
      'curl -s -D - -o /dev/null https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | grep -i x-ratelimit',
    expectedAfter: 'Rate-limit headroom stays above 20% during peak traffic and 429 responses stop.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'openai-billing',
    platform: 'openai-platform',
    title: 'Restore OpenAI billing or credit balance',
    applicableFindingTypes: ['llm-provider.quota_billing'],
    url: 'https://platform.openai.com/settings/organization/billing/overview',
    consoleSteps: [
      'Open Settings → Organization → Billing → Overview and check the credit balance and payment method.',
      'Add to the credit balance, then enable auto-recharge so the balance cannot reach zero mid-incident.',
      'Check that the project your key belongs to has not hit its own budget limit under Settings → Project → Limits.',
      'Re-run `crisismode scan` to confirm the quota/billing check has cleared.',
    ],
    expectedAfter: 'Calls stop failing with `insufficient_quota`, and the quota/billing check reports healthy.',
    verifiedOn: '2026-08-05',
  },
];
```

- [ ] **Step 4: Write the Supabase content**

Create `src/framework/guidance/guides/supabase.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

export const supabaseGuides: RemediationGuide[] = [
  {
    id: 'supabase-pooler-mode',
    platform: 'supabase',
    title: 'Use the Supabase transaction pooler for serverless functions',
    applicableFindingTypes: ['serverless-pooling'],
    url: 'https://supabase.com/dashboard/project/_/settings/database',
    consoleSteps: [
      'Open the Supabase dashboard → your project → Project Settings → Database → Connection string.',
      'Pick the Transaction pooler connection string (port 6543) for serverless or edge deployments, where every invocation opens its own connection.',
      'Keep the Session pooler or direct connection (port 5432) for long-lived servers and for migrations.',
      'Set DATABASE_URL to the transaction-pooler URI in the serverless deployment and redeploy.',
      'If your Postgres driver uses prepared statements by default, disable them for the pooled connection (for example `?pgbouncer=true` or the driver\'s prepared-statement flag).',
    ],
    expectedAfter:
      'DATABASE_URL points at the pooler host on port 6543, and `crisismode readiness` no longer flags serverless-pooling.',
    caution:
      'Transaction mode does not support session-level features (LISTEN/NOTIFY, session-scoped prepared statements, advisory locks held across statements). Run migrations over the direct connection.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-connection-limits',
    platform: 'supabase',
    title: 'Fit your app inside the Supabase connection cap',
    applicableFindingTypes: ['connection-limit-tier', 'connection-headroom'],
    url: 'https://supabase.com/docs/guides/platform/compute-and-disk',
    consoleSteps: [
      'Open the Supabase dashboard → Project Settings → Database → Connection pooling to see the pool size and maximum client connections for your compute size.',
      'Compare that ceiling against the connection count CrisisMode reported — count every running instance, not just one.',
      'Lower the per-instance pool size in the app so (instances × pool size) stays under the cap with room to spare.',
      'Move serverless traffic to the transaction pooler so short invocations share connections instead of each holding one.',
      'If the cap is genuinely too small for the workload, upgrade compute (see the compute upgrade guide).',
    ],
    expectedAfter: 'Peak connection count stays below the cap, and connection-headroom reports ready.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-upgrade-compute',
    platform: 'supabase',
    title: 'Upgrade Supabase compute for a higher connection limit',
    applicableFindingTypes: ['connection-limit-tier'],
    url: 'https://supabase.com/dashboard/project/_/settings/compute-and-disk',
    consoleSteps: [
      'Open the Supabase dashboard → Project Settings → Compute and Disk.',
      'Read the current compute size and the connection limits documented for each size.',
      'Select the next compute size up and confirm the change.',
      'Wait for the restart to finish, then re-run `crisismode readiness` to confirm the new headroom.',
    ],
    expectedAfter: 'The reported maximum connections rises to the new compute size\'s limit.',
    caution:
      'Changing compute size restarts the database — connections drop for seconds to minutes. Larger compute bills at a higher hourly rate.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-pgvector-index',
    platform: 'supabase',
    title: 'Add an approximate vector index to your pgvector table',
    applicableFindingTypes: ['vector-index-missing', 'ivfflat-lists-mismatch'],
    url: 'https://supabase.com/docs/guides/database/extensions/pgvector',
    consoleSteps: [
      'Open the Supabase dashboard → SQL Editor.',
      'Confirm the table and vector column named in the readiness finding.',
      'Create an HNSW index whose operator class matches the distance function your queries use, e.g. `CREATE INDEX CONCURRENTLY ON items USING hnsw (embedding vector_cosine_ops);`.',
      'For an existing ivfflat index the report flagged, either recreate it with `lists` close to sqrt(row count) or replace it with an HNSW index.',
      'Run `EXPLAIN ANALYZE` on a representative similarity query and confirm it now uses an index scan.',
    ],
    expectedAfter:
      'EXPLAIN ANALYZE shows an index scan instead of a sequential scan, and the vector readiness rule reports ready.',
    caution:
      'Building the index on a large table takes time and IO; CONCURRENTLY avoids blocking writes but takes longer. If the operator class does not match the distance operator the query uses (vector_cosine_ops / vector_l2_ops / vector_ip_ops), the planner ignores the index.',
    verifiedOn: '2026-08-05',
  },
];
```

- [ ] **Step 5: Write the Neon content**

Create `src/framework/guidance/guides/neon.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

export const neonGuides: RemediationGuide[] = [
  {
    id: 'neon-pooled-connection',
    platform: 'neon',
    title: 'Switch Neon to the pooled connection endpoint',
    applicableFindingTypes: ['serverless-pooling'],
    url: 'https://neon.com/docs/connect/connection-pooling',
    consoleSteps: [
      'Open the Neon console → your project → Dashboard → Connect (Connection Details).',
      'Enable the connection pooling option — the host in the connection string gains a `-pooler` suffix.',
      'Set DATABASE_URL to the pooled connection string in the serverless deployment and redeploy.',
      'Keep the unpooled (direct) connection string for migrations and for anything that needs a session-scoped feature.',
    ],
    expectedAfter:
      'DATABASE_URL\'s host ends in `-pooler`, and `crisismode readiness` no longer flags serverless-pooling.',
    caution:
      'The pooled endpoint runs PgBouncer in transaction mode: session-level features and some prepared-statement modes are unavailable. Run migrations over the direct endpoint.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'neon-compute-size',
    platform: 'neon',
    title: 'Raise Neon compute size to lift the connection limit',
    applicableFindingTypes: ['connection-limit-tier', 'connection-headroom'],
    url: 'https://neon.com/docs/introduction/autoscaling',
    consoleSteps: [
      'Open the Neon console → your project → Settings → Compute.',
      'Read the autoscaling minimum and maximum compute units — Postgres max_connections scales with compute size, so a small minimum caps connections even when traffic is low.',
      'Raise the minimum (and, if needed, the maximum) compute units, then save.',
      'If the workload is bursty and serverless, prefer the pooled endpoint over larger compute — it is cheaper for the same connection count.',
      'Re-run `crisismode readiness` to confirm the new headroom.',
    ],
    expectedAfter: 'The reported maximum connections rises, and connection-headroom reports ready.',
    caution:
      'Compute bills by the hour: the autoscaling minimum sets your floor cost and the maximum sets the ceiling.',
    verifiedOn: '2026-08-05',
  },
];
```

- [ ] **Step 6: Register the new content**

In `src/framework/guidance/registry.ts`, extend the imports and the aggregate list:

```ts
import { anthropicGuides } from './guides/anthropic.js';
import { neonGuides } from './guides/neon.js';
import { openaiGuides } from './guides/openai.js';
import { supabaseGuides } from './guides/supabase.js';

export const REMEDIATION_GUIDES: readonly RemediationGuide[] = [
  ...anthropicGuides,
  ...openaiGuides,
  ...supabaseGuides,
  ...neonGuides,
];
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/framework/guidance/guides/openai.ts src/framework/guidance/guides/supabase.ts src/framework/guidance/guides/neon.ts src/framework/guidance/registry.ts src/__tests__/guidance-registry.test.ts
git commit -m "feat(guidance): add OpenAI, Supabase, and Neon console guides"
```

---

## Task 4: Freshness policy test

**Files:**
- Modify: `src/__tests__/guidance-registry.test.ts`

**Interfaces:**
- Consumes: `REMEDIATION_GUIDES` from Task 2.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the freshness test**

This one is not red-then-green: the guides written in Tasks 2–3 are already fresh, so the test passes on arrival. Step 3 is what proves it can actually fail — do not skip it.

Append to `src/__tests__/guidance-registry.test.ts`:

```ts
describe('guidance freshness', () => {
  /**
   * Console paths rot silently. This test is the nudge: when a guide's path
   * has not been human-verified in 12 months, the build fails and someone
   * re-walks it. Output shows the date regardless — this is a contributor
   * policy, not a runtime behavior.
   */
  const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

  it('every guide was verified within the last 12 months', () => {
    const now = Date.now();
    for (const guide of REMEDIATION_GUIDES) {
      const verifiedAt = Date.parse(guide.verifiedOn);
      const ageDays = Math.floor((now - verifiedAt) / (24 * 60 * 60 * 1000));
      expect(
        now - verifiedAt,
        `guide '${guide.id}' was last verified on ${guide.verifiedOn} (${ageDays} days ago). `
          + 'Follow the console path, correct the steps if they changed, and update verifiedOn.',
      ).toBeLessThan(TWELVE_MONTHS_MS);
    }
  });

  it('no guide claims a verification date in the future', () => {
    const now = Date.now();
    for (const guide of REMEDIATION_GUIDES) {
      expect(
        Date.parse(guide.verifiedOn),
        `guide '${guide.id}' has a verifiedOn in the future (${guide.verifiedOn})`,
      ).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it passes for the right reason**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS — every guide carries `2026-08-05`, well inside 12 months.

- [ ] **Step 3: Verify the test actually fails when a guide goes stale**

Temporarily change `verifiedOn` in `src/framework/guidance/guides/anthropic.ts` for `anthropic-rotate-key` to `'2024-01-01'`.

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: FAIL with "guide 'anthropic-rotate-key' was last verified on 2024-01-01 (… days ago)".

Then revert the value to `'2026-08-05'` and re-run:

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/guidance-registry.test.ts
git commit -m "test(guidance): fail the build when a guide's verifiedOn is over 12 months old"
```

---

## Task 5: Anchoring enforcement — every finding type must resolve

**Files:**
- Create: `src/agent/aws-rds/check-ids.ts`
- Modify: `src/__tests__/guidance-registry.test.ts`

**Interfaces:**
- Consumes: `REMEDIATION_GUIDES`; `allRules` from `src/readiness/rules/index.ts`; `LLM_PROVIDER_CHECK_IDS` (PR 3) and `VECTOR_STORE_CHECK_IDS` (PR 4), each a keyed object in its agent's `check-ids.ts`, read via `Object.values(...)`.
- Produces, from `src/agent/aws-rds/check-ids.ts`:
  - `AWS_RDS_CHECK_IDS: { readonly storageFull: 'aws-rds.storage_full'; readonly connectionSaturation: 'aws-rds.connection_saturation'; readonly securityGroup: 'aws-rds.security_group'; readonly instanceStatus: 'aws-rds.instance_status' }`
  - `checkIdForRdsSource(source: string): string | undefined`

- [ ] **Step 1: Confirm the upstream checkId constants**

Both upstream agents follow the series-wide convention from Global Constraints: a keyed `as const` object in `src/agent/<agent>/check-ids.ts`, consumed with `Object.values(...)`. Verify the file location and the object shape before importing:

Run:
```bash
grep -n "export const LLM_PROVIDER_CHECK_IDS" -A 9 src/agent/llm-provider/check-ids.ts
grep -n "export const VECTOR_STORE_CHECK_IDS" -A 6 src/agent/vector-store/check-ids.ts
```

Expected from each: a `= {` opening (keyed object, **not** an array literal `= [`), one `<name>: '<agent>.<check>',` line per check, and a closing `} as const;`. The values are the strings this task's test anchors to. The same shape is what Step 4 below writes for `AWS_RDS_CHECK_IDS`, so all three read identically at the call site.

If a grep comes back empty or shows an array literal, the upstream PR has not finished adopting the convention. Import from wherever the constant actually is (`grep -rn "<NAME>_CHECK_IDS" src/agent/<agent>/`), note the deviation in your PR description, and move on — **do not** relocate or reshape another PR's constant as a rider on this one; that conflicts with an in-flight branch. `Object.values()` reads an array's elements too, so the Step 2 test compiles either way.

If the constant does not exist anywhere in that agent's directory, PR 3 or PR 4 is not merged and this plan's premise is broken. Stop and report that rather than stubbing the constant — a stub would make the enforcement test green while enforcing nothing.

- [ ] **Step 2: Write the failing test**

Append to `src/__tests__/guidance-registry.test.ts` (add the imports at the top of the file alongside the existing ones):

```ts
// Every agent's check ids live in its own check-ids.ts as a keyed object.
import { allRules } from '../readiness/rules/index.js';
import { AWS_RDS_CHECK_IDS } from '../agent/aws-rds/check-ids.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';

/**
 * The anchoring contract: a guide's applicableFindingTypes must name something
 * the codebase actually emits — a registered readiness rule id, or a checkId
 * constant exported by an agent. Renaming a rule or a check then breaks this
 * test, instead of silently orphaning its guidance at runtime.
 */
describe('guidance anchoring', () => {
  const knownFindingTypes = new Set<string>([
    ...allRules.map((rule) => rule.id),
    ...Object.values(AWS_RDS_CHECK_IDS),
    ...Object.values(LLM_PROVIDER_CHECK_IDS),
    ...Object.values(VECTOR_STORE_CHECK_IDS),
  ]);

  it('every applicableFindingTypes entry resolves to a rule id or a checkId', () => {
    for (const guide of REMEDIATION_GUIDES) {
      for (const findingType of guide.applicableFindingTypes) {
        expect(
          knownFindingTypes.has(findingType),
          `guide '${guide.id}' is keyed to '${findingType}', which is neither a registered readiness `
            + 'rule id nor an exported agent checkId. Either the guide is stale or the rule/check was renamed.',
        ).toBe(true);
      }
    }
  });

  it('each aws-rds checkId maps back from its diagnosis finding source', async () => {
    const { checkIdForRdsSource } = await import('../agent/aws-rds/check-ids.js');
    expect(checkIdForRdsSource('rds_storage')).toBe(AWS_RDS_CHECK_IDS.storageFull);
    expect(checkIdForRdsSource('rds_connection_saturation')).toBe(AWS_RDS_CHECK_IDS.connectionSaturation);
    expect(checkIdForRdsSource('rds_security_group')).toBe(AWS_RDS_CHECK_IDS.securityGroup);
    expect(checkIdForRdsSource('rds_instance_status')).toBe(AWS_RDS_CHECK_IDS.instanceStatus);
    expect(checkIdForRdsSource('rds_backup_config')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: FAIL — `Failed to resolve import "../agent/aws-rds/check-ids.js"`.

- [ ] **Step 4: Write the aws-rds checkId constants**

Create `src/agent/aws-rds/check-ids.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check identifiers for the aws-rds control-plane checks. Names track
 * the diagnosis finding `source` values one-to-one so a reader can move
 * between a finding and its guidance without a translation table.
 */
export const AWS_RDS_CHECK_IDS = {
  storageFull: 'aws-rds.storage_full',
  connectionSaturation: 'aws-rds.connection_saturation',
  securityGroup: 'aws-rds.security_group',
  instanceStatus: 'aws-rds.instance_status',
} as const;

const BY_SOURCE: Record<string, string> = {
  rds_storage: AWS_RDS_CHECK_IDS.storageFull,
  rds_connection_saturation: AWS_RDS_CHECK_IDS.connectionSaturation,
  rds_security_group: AWS_RDS_CHECK_IDS.securityGroup,
  rds_instance_status: AWS_RDS_CHECK_IDS.instanceStatus,
};

/**
 * The checkId for a control-plane finding source, or undefined for sources
 * with no guidance anchor (backup/snapshot/IAM findings are diagnosed but not
 * remediated through a console guide).
 */
export function checkIdForRdsSource(source: string): string | undefined {
  return BY_SOURCE[source];
}
```

Then add the convention's re-export line to `src/agent/aws-rds/backend.ts`, so this agent matches llm-provider and vector-store:

```ts
export { AWS_RDS_CHECK_IDS, checkIdForRdsSource } from './check-ids.js';
```

- [ ] **Step 5: Run the test — the guide anchors should now fail loudly**

Run: `pnpm vitest run src/__tests__/guidance-registry.test.ts`
Expected: PASS for the aws-rds mapping test. The anchoring test passes only if every finding type used in Tasks 2–3 is real. If it fails naming a specific finding type, fix the *guide* — do not widen `knownFindingTypes` to make it green. (`vector-index-missing` and `ivfflat-lists-mismatch` come from PR 4's rules; if they are missing from `allRules`, PR 4 is not merged and this plan's premise is broken — stop and report that rather than stubbing them.)

- [ ] **Step 6: Typecheck, lint, and run the whole suite**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/agent/aws-rds/check-ids.ts src/agent/aws-rds/backend.ts src/__tests__/guidance-registry.test.ts
git commit -m "feat(guidance): enforce that every guide anchors to a real rule id or checkId"
```

---

## Task 6: The shared pure renderer

**Files:**
- Create: `src/framework/guidance/render.ts`
- Create: `src/framework/guidance/attach.ts`
- Create: `src/__tests__/guidance-render.test.ts`

**Interfaces:**
- Consumes: `RemediationGuide`; `guidesForFindingTypes` from Task 2.
- Produces, from `src/framework/guidance/render.ts`:
  - `interface GuideRenderOptions { terse?: boolean | undefined }`
  - `renderGuideLines(guide: RemediationGuide, opts?: GuideRenderOptions): string[]`
  - `renderGuidesLines(guides: readonly RemediationGuide[], opts?: GuideRenderOptions): string[]`
  - `guideReference(guides: readonly RemediationGuide[]): string` — `''` when empty, else `guide:<id>[,<id>...]`
  - `formatGuideForPlan(guide: RemediationGuide): string`
- Produces, from `src/framework/guidance/attach.ts` (note the intersection return types — a bare `T` would make `.guides` inaccessible on an inline object literal and fail typecheck with TS2339):
  - `attachGuidesToScanFinding<T extends ScanFindingLike>(finding: T): T & { guides?: RemediationGuide[] | undefined }`
  - `attachGuidesByRuleId<T extends RuleFindingLike>(finding: T, scope?: GuidanceScope): T & { guides?: RemediationGuide[] | undefined }`
  - `attachGuidesToDiagnosis(diagnosis: DiagnosisResult, scope?: GuidanceScope): DiagnosisResult`
  - exported `interface ScanFindingLike` and `interface RuleFindingLike`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/guidance-render.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  renderGuideLines, renderGuidesLines, guideReference, formatGuideForPlan,
} from '../framework/guidance/render.js';
import { attachGuidesToScanFinding, attachGuidesByRuleId, attachGuidesToDiagnosis } from '../framework/guidance/attach.js';
import { getGuideById } from '../framework/guidance/registry.js';
import type { RemediationGuide } from '../types/remediation-guide.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

const guide: RemediationGuide = {
  id: 'test-guide',
  platform: 'test-console',
  title: 'Rotate the thing',
  applicableFindingTypes: ['llm-provider.key_valid'],
  url: 'https://console.example.com/keys',
  consoleSteps: ['Open the console.', 'Create a key.'],
  cliEquivalent: 'example keys create',
  expectedAfter: 'The key check passes.',
  caution: 'The old key stops working.',
  verifiedOn: '2026-08-05',
};

describe('renderGuideLines', () => {
  it('renders title, url, numbered steps, cli, expectation, caution, and freshness', () => {
    expect(renderGuideLines(guide)).toEqual([
      'How to fix it: Rotate the thing',
      '  Open: https://console.example.com/keys',
      '  1. Open the console.',
      '  2. Create a key.',
      '  CLI: example keys create',
      '  Expect: The key check passes.',
      '  Caution: The old key stops working.',
      '  (path verified 2026-08-05)',
    ]);
  });

  it('omits optional lines a guide does not carry', () => {
    const minimal: RemediationGuide = {
      id: 'minimal', platform: 'test-console', title: 'Do it',
      applicableFindingTypes: ['llm-provider.key_valid'],
      consoleSteps: ['Click.'], expectedAfter: 'Done.', verifiedOn: '2026-08-05',
    };
    expect(renderGuideLines(minimal)).toEqual([
      'How to fix it: Do it',
      '  1. Click.',
      '  Expect: Done.',
      '  (path verified 2026-08-05)',
    ]);
  });

  it('collapses to title and URL in terse mode', () => {
    expect(renderGuideLines(guide, { terse: true })).toEqual([
      'How to fix it: Rotate the thing — https://console.example.com/keys',
    ]);
  });

  it('separates multiple guides with a blank line', () => {
    const lines = renderGuidesLines([guide, guide]);
    expect(lines.filter((l) => l === '')).toHaveLength(1);
  });
});

describe('guideReference', () => {
  it('builds a pipe-mode reference token', () => {
    expect(guideReference([guide])).toBe('guide:test-guide');
    expect(guideReference([guide, { ...guide, id: 'other' }])).toBe('guide:test-guide,other');
  });

  it('is empty when there are no guides', () => {
    expect(guideReference([])).toBe('');
  });
});

describe('formatGuideForPlan', () => {
  it('renders the full guide as one newline-joined block', () => {
    const text = formatGuideForPlan(guide);
    expect(text.split('\n')[0]).toBe('How to fix it: Rotate the thing');
    expect(text).toContain('  1. Open the console.');
  });
});

describe('attachment', () => {
  it('attaches guides to a scan finding by its own checkId', () => {
    const finding = attachGuidesToScanFinding({ checkId: 'llm-provider.key_valid', signals: [] });
    expect(finding.guides?.map((g) => g.id)).toContain('anthropic-rotate-key');
  });

  it('attaches guides from a signal checkId when the finding has none', () => {
    const finding = attachGuidesToScanFinding({
      signals: [{ checkId: 'llm-provider.quota_billing' }, { checkId: undefined }],
    });
    expect(finding.guides?.map((g) => g.id)).toContain('anthropic-billing-credits');
  });

  it('leaves a finding untouched when nothing matches', () => {
    const finding = attachGuidesToScanFinding({ checkId: 'nothing.matches', signals: [] });
    expect(finding.guides).toBeUndefined();
  });

  it('attaches guides to a readiness finding by rule id', () => {
    const finding = attachGuidesByRuleId({ ruleId: 'serverless-pooling' });
    expect(finding.guides?.map((g) => g.id)).toContain('supabase-pooler-mode');
  });

  it('honors the finding\'s platform scope', () => {
    const scoped = attachGuidesToScanFinding({
      checkId: 'llm-provider.key_valid',
      signals: [],
      guidancePlatforms: ['anthropic-console'],
    });
    expect(scoped.guides?.map((g) => g.id)).toEqual(['anthropic-rotate-key']);

    const unguided = attachGuidesToScanFinding({
      checkId: 'llm-provider.key_valid',
      signals: [],
      guidancePlatforms: [],
    });
    expect(unguided.guides).toBeUndefined();
  });

  // re-enabled in Task 9 (the aws-rds guides it asserts on are written there)
  it.skip('attaches guides to diagnosis findings by checkId', () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'storage_full',
      confidence: 0.9,
      findings: [
        { source: 'rds_storage', observation: 'full', severity: 'critical', checkId: 'aws-rds.storage_full' },
        { source: 'rds_backup_config', observation: 'fine', severity: 'info' },
      ],
      diagnosticPlanNeeded: false,
    };
    const attached = attachGuidesToDiagnosis(diagnosis);
    expect(attached.findings[0]!.guides?.map((g) => g.id)).toContain('aws-rds-increase-storage');
    expect(attached.findings[1]!.guides).toBeUndefined();
  });

  it('does not mutate the guide in the registry when attaching', () => {
    const before = JSON.stringify(getGuideById('anthropic-rotate-key'));
    attachGuidesToScanFinding({ checkId: 'llm-provider.key_valid', signals: [] });
    expect(JSON.stringify(getGuideById('anthropic-rotate-key'))).toBe(before);
  });
});
```

The diagnosis-attachment test above is written as `it.skip` on purpose: the `aws-rds-increase-storage` guide it asserts on is written in Task 9, which re-enables it. Everything else in this file must pass now.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-render.test.ts`
Expected: FAIL — `Failed to resolve import "../framework/guidance/render.js"`.

- [ ] **Step 3: Write the renderer**

Create `src/framework/guidance/render.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The single place a RemediationGuide becomes text. Pure: no chalk, no
 * console, no output-mode awareness. `src/cli/output.ts` wraps these lines
 * with color and indentation for the terminal, and agents use
 * formatGuideForPlan() for suggestion-plan step text — so every surface shows
 * the same words in the same order.
 */

import type { RemediationGuide } from '../../types/remediation-guide.js';

export interface GuideRenderOptions {
  /** Collapse to a single title + URL line (mirrors the CLI's --terse). */
  terse?: boolean | undefined;
}

export function renderGuideLines(guide: RemediationGuide, opts: GuideRenderOptions = {}): string[] {
  if (opts.terse) {
    return [guide.url !== undefined
      ? `How to fix it: ${guide.title} — ${guide.url}`
      : `How to fix it: ${guide.title}`];
  }

  const lines: string[] = [`How to fix it: ${guide.title}`];
  if (guide.url !== undefined) lines.push(`  Open: ${guide.url}`);
  guide.consoleSteps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  if (guide.cliEquivalent !== undefined) lines.push(`  CLI: ${guide.cliEquivalent}`);
  lines.push(`  Expect: ${guide.expectedAfter}`);
  if (guide.caution !== undefined) lines.push(`  Caution: ${guide.caution}`);
  lines.push(`  (path verified ${guide.verifiedOn})`);
  return lines;
}

export function renderGuidesLines(
  guides: readonly RemediationGuide[],
  opts: GuideRenderOptions = {},
): string[] {
  const blocks = guides.map((g) => renderGuideLines(g, opts));
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) lines.push('');
    lines.push(...block);
  });
  return lines;
}

/** Pipe-mode reference token: `guide:<id>[,<id>...]`, or '' when there are none. */
export function guideReference(guides: readonly RemediationGuide[]): string {
  if (guides.length === 0) return '';
  return `guide:${guides.map((g) => g.id).join(',')}`;
}

/** Full guide as a single text block, for recovery-plan step detail. */
export function formatGuideForPlan(guide: RemediationGuide): string {
  return renderGuideLines(guide).join('\n');
}
```

- [ ] **Step 4: Write the attachment helpers**

Create `src/framework/guidance/attach.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Attach matching guides to findings. Structural generics keep this module
 * free of imports from src/cli/ and src/readiness/ — the guidance layer is a
 * leaf, and callers keep their own types.
 */

import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { RemediationGuide } from '../../types/remediation-guide.js';
import { applyGuideVariables, guidesForFindingTypes, type GuidanceScope } from './registry.js';

export interface ScanFindingLike {
  checkId?: string | undefined;
  /** Substitutions for this finding's own checkId's matched guide(s) — see HealthSignal.guideVars. */
  guideVars?: Record<string, string> | undefined;
  signals?: ReadonlyArray<{ checkId?: string | undefined; guideVars?: Record<string, string> | undefined }> | undefined;
  /** Platforms this finding's target may show guides for — see platformsForTarget(). */
  guidancePlatforms?: readonly string[] | undefined;
  guides?: RemediationGuide[] | undefined;
}

export interface RuleFindingLike {
  ruleId: string;
  guides?: RemediationGuide[] | undefined;
}

/** Attached findings are returned as an intersection so callers can read `.guides` off an inline literal. */
type WithGuides<T> = T & { guides?: RemediationGuide[] | undefined };

/**
 * Resolve guides for one checkId and apply that source's own guideVars, so a
 * guide's `<token>` placeholders never reach the caller unresolved. Each
 * (checkId, vars) pair is resolved independently — the finding's own checkId
 * carries the finding's guideVars, and each signal's checkId carries that
 * signal's own guideVars, since two signals on one finding can name the same
 * checkId for different targets with different substitutions.
 */
function resolveGuides(
  checkId: string,
  vars: Record<string, string> | undefined,
  scope: GuidanceScope | undefined,
): RemediationGuide[] {
  const guides = guidesForFindingTypes([checkId], scope);
  return vars === undefined ? guides : guides.map((g) => applyGuideVariables(g, vars));
}

/**
 * A scan finding covers a whole target, so its guidance anchors can come from
 * the finding's own checkId or from any of its signals' checkIds. The
 * platform scope rides on the finding itself (populated in scan.ts, where the
 * target is in hand) so this stays callable from the output layer. Variables
 * are resolved per-source (finding-level vs. each signal's own guideVars)
 * before the results are merged, deduping by guide id so a checkId shared by
 * the finding and one of its signals doesn't attach twice.
 */
export function attachGuidesToScanFinding<T extends ScanFindingLike>(finding: T): WithGuides<T> {
  const scope: GuidanceScope = { platforms: finding.guidancePlatforms };
  const seen = new Set<string>();
  const guides: RemediationGuide[] = [];
  const collect = (checkId: string | undefined, vars: Record<string, string> | undefined): void => {
    if (checkId === undefined) return;
    for (const guide of resolveGuides(checkId, vars, scope)) {
      if (seen.has(guide.id)) continue;
      seen.add(guide.id);
      guides.push(guide);
    }
  };
  collect(finding.checkId, finding.guideVars);
  for (const signal of finding.signals ?? []) collect(signal.checkId, signal.guideVars);
  return guides.length > 0 ? { ...finding, guides } : finding;
}

export function attachGuidesByRuleId<T extends RuleFindingLike>(
  finding: T,
  scope?: GuidanceScope,
): WithGuides<T> {
  const guides = guidesForFindingTypes([finding.ruleId], scope);
  return guides.length > 0 ? { ...finding, guides } : finding;
}

export function attachGuidesToDiagnosis(
  diagnosis: DiagnosisResult,
  scope?: GuidanceScope,
): DiagnosisResult {
  return {
    ...diagnosis,
    findings: diagnosis.findings.map((finding) => {
      if (finding.checkId === undefined) return finding;
      const guides = resolveGuides(finding.checkId, finding.guideVars, scope);
      return guides.length > 0 ? { ...finding, guides } : finding;
    }),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/guidance-render.test.ts`
Expected: PASS (with the one aws-rds attachment test skipped until Task 9).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/framework/guidance/render.ts src/framework/guidance/attach.ts src/__tests__/guidance-render.test.ts
git commit -m "feat(guidance): add the shared guide renderer and finding attachment helpers"
```

---

## Task 7: Wire guidance into scan and diagnose output

**Files:**
- Modify: `src/cli/output.ts` (`ScanFinding` at ~437-448; `printDiagnosis` at ~164-203; `printScanSummary` at ~470-546; `printFindingGroup` at ~548-563)
- Modify: `src/cli/commands/scan.ts` (`checkTargetHealth`'s finding construction, ~224-232)
- Modify: `src/cli/commands/diagnose.ts` (the `printDiagnosis` call, ~line 120)
- Create: `src/__tests__/guidance-output.test.ts`

**Interfaces:**
- Consumes: `renderGuidesLines`, `guideReference` (Task 6); `attachGuidesToScanFinding`, `attachGuidesToDiagnosis` (Task 6); `platformsForTarget` (Task 2).
- Produces: `printRemediationGuides(guides: readonly RemediationGuide[] | undefined, indent?: string): void` exported from `src/cli/output.ts`; `ScanFinding` gains `guides?: RemediationGuide[] | undefined`, `guidancePlatforms?: readonly string[] | undefined`, `guideVars?: Record<string, string> | undefined`, and `signals[].guideVars?: Record<string, string> | undefined`; `printDiagnosis` gains an optional third parameter `scope?: GuidanceScope`.
- **Already present from PR 3 — verify, do not re-add:** `ScanFinding.checkId?: string`, `ScanFinding.signals[].checkId?: string`, and the `checkId` spread in `checkTargetHealth`'s `health.signals.map(...)`. Run `grep -n "checkId" src/cli/output.ts src/cli/commands/scan.ts` before editing either file.
- **`guideVars` is not optional plumbing — without it, `attachGuidesToScanFinding`/`attachGuidesToDiagnosis` (Task 6) can only offer the raw guide with its `<instance>`-style placeholders still literal.** `HealthSignal.guideVars` and `DiagnosisFinding.guideVars` (Task 1) are the source; this step's job is carrying them the one extra hop from `health.signals[]` into `ScanFinding.signals[]`, the same way the existing `checkId` spread does.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/guidance-output.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, setOutputOptions, printScanSummary, printDiagnosis } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

function scanResultWithKeyFinding(): ScanResult {
  return {
    score: 40,
    findings: [{
      id: 'LLM-001',
      service: 'llm-provider (anthropic)',
      status: 'unhealthy',
      summary: 'Anthropic API key is not valid',
      confidence: 0.95,
      escalationLevel: 2,
      checkId: 'llm-provider.key_valid',
      guidancePlatforms: ['anthropic-console'],
      signals: [{ status: 'critical', detail: '401 authentication_error', source: 'llm_key_valid' }],
    }],
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 120,
  };
}

describe('scan output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('human mode renders the numbered guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key');
    expect(text).toContain('1. Open the Anthropic Console');
    expect(text).toContain('https://console.anthropic.com/settings/keys');
    expect(text).toContain('(path verified 2026-08-05)');
  });

  it('--terse collapses the guide to title and URL', () => {
    configure({ mode: 'human', noColor: true });
    setOutputOptions({ terse: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key — https://console.anthropic.com/settings/keys');
    expect(text).not.toContain('1. Open the Anthropic Console');
  });

  it('pipe mode adds a guide:<id> reference column instead of the block', () => {
    configure({ mode: 'pipe', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const fields = lines.find((l) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    // Scoped to anthropic-console, so the OpenAI rotate-key guide must not appear.
    expect(fields[6]).toBe('guide:anthropic-rotate-key');
    expect(lines.join('\n')).not.toContain('How to fix it');
  });

  it('pipe mode keeps the column present but empty when a finding has no guides', () => {
    configure({ mode: 'pipe', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    const fields = logSpy.mock.calls.map((c) => String(c[0]))
      .find((l) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    expect(fields[6]).toBe('');
  });

  it('machine mode emits full guide objects under guides', () => {
    configure({ json: true, noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.type).toBe('scan');
    const guide = parsed.findings[0].guides[0];
    expect(guide.id).toBe('anthropic-rotate-key');
    expect(guide.consoleSteps.length).toBeGreaterThan(1);
    expect(guide.verifiedOn).toBe('2026-08-05');
  });

  it('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const result: ScanResult = {
      score: 55,
      findings: [{
        id: 'RDS-001',
        service: 'aws-rds (prod-db-01)',
        status: 'unhealthy',
        summary: 'RDS storage is full on instance prod-db-01',
        confidence: 0.95,
        escalationLevel: 2,
        guidancePlatforms: ['aws-rds'],
        signals: [{
          status: 'critical',
          detail: 'allocated storage exhausted',
          source: 'rds_storage',
          checkId: 'aws-rds.storage_full',
          guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
        }],
      }],
      recentChanges: [],
      scannedAt: '2026-08-05T12:00:00.000Z',
      durationMs: 90,
    };
    printScanSummary(result);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });

  it('a finding with no matching checkId renders no guidance', () => {
    configure({ mode: 'human', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('How to fix it');
  });
});

describe('diagnose output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  const diagnosis: DiagnosisResult = {
    status: 'identified',
    scenario: 'quota_exhausted',
    confidence: 0.9,
    findings: [{
      source: 'llm_provider_quota',
      observation: 'Anthropic credit balance is exhausted',
      severity: 'critical',
      checkId: 'llm-provider.quota_billing',
    }],
    diagnosticPlanNeeded: false,
  };

  it('human mode renders the guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Restore Anthropic billing or credit balance');
    expect(text).not.toContain('OpenAI');
  });

  it('machine mode carries guides on the finding', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.diagnosis.findings[0].guides.map((g: { id: string }) => g.id)).toEqual(['anthropic-billing-credits']);
  });

  it('without a scope, every platform that answers the check is offered', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis);
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    const platforms = parsed.diagnosis.findings[0].guides.map((g: { platform: string }) => g.platform);
    expect(new Set(platforms)).toEqual(new Set(['anthropic-console', 'openai-platform']));
  });

  it('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const rdsDiagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'storage_full',
      confidence: 0.9,
      findings: [{
        source: 'rds_storage',
        observation: 'RDS storage is full on instance prod-db-01',
        severity: 'critical',
        checkId: 'aws-rds.storage_full',
        guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
      }],
      diagnosticPlanNeeded: false,
    };
    printDiagnosis(rdsDiagnosis, undefined, { platforms: ['aws-rds'] });
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts`
Expected: FAIL — TypeScript rejects `checkId` on `ScanFinding`, and no guidance is rendered.

- [ ] **Step 3: Extend the ScanFinding shape (additively)**

In `src/cli/output.ts`, add the imports to the existing top import block:

```ts
import { attachGuidesToScanFinding, attachGuidesToDiagnosis } from '../framework/guidance/attach.js';
import type { GuidanceScope } from '../framework/guidance/registry.js';
import { renderGuidesLines, guideReference } from '../framework/guidance/render.js';
import type { RemediationGuide } from '../types/remediation-guide.js';
```

**Do not retype the whole `ScanFinding` interface.** By this point it carries `bestEffort?: boolean` (PR 1), `possiblyObserverCaused?: boolean` (PR 2), and `checkId?: string` plus `signals[].checkId?: string` (PR 3) — a wholesale rewrite silently drops them. Append exactly four members (the last one goes inside the `signals` array element type, next to that array's `checkId?: string`):

```ts
  /** Platforms this finding's target may show guides for (see platformsForTarget). Undefined = platform unknown, show every match. */
  guidancePlatforms?: readonly string[] | undefined;
  /** Remediation guides matched to this finding (attached at render time). */
  guides?: RemediationGuide[] | undefined;
  /** Substitutions for this finding's own checkId's matched guide(s) — see HealthSignal.guideVars. */
  guideVars?: Record<string, string> | undefined;
```

```ts
  // Inside ScanFinding['signals'][number], alongside that element's existing checkId?: string:
  /** Substitutions for this signal's checkId's matched guide(s), applied before attachment. */
  guideVars?: Record<string, string> | undefined;
```

Then confirm PR 3's members are already there — `grep -n "checkId" src/cli/output.ts` must show both `ScanFinding.checkId?: string` and the `checkId?: string` inside the `signals` array type. Add them only if that grep comes back empty. `guideVars` is new to this PR on both `ScanFinding` and its `signals[]` element — always add it, at both levels, or `attachGuidesToScanFinding` (Task 6) has nothing to substitute with and every placeholder in an attached guide renders literally (e.g. `<instance>`).

- [ ] **Step 4: Add the shared CLI guidance printer**

In `src/cli/output.ts`, add below `printFindingGroup`:

```ts
/**
 * The one CLI path that prints remediation guidance. Machine mode carries
 * guides in the JSON payload; pipe mode carries a `guide:<id>` reference on
 * the finding row; only human mode prints the block, honoring --terse.
 */
export function printRemediationGuides(
  guides: readonly RemediationGuide[] | undefined,
  indent = '      ',
): void {
  if (!guides || guides.length === 0) return;
  if (outputOptions.mode !== 'human') return;
  for (const line of renderGuidesLines(guides, { terse: outputOptions.terse })) {
    console.log(line === '' ? '' : chalk.dim(indent + line));
  }
}
```

- [ ] **Step 5: Attach and render in the scan path**

In `printScanSummary`, attach guides before any branch, so machine, pipe, and human all see the same data:

```ts
export function printScanSummary(result: ScanResult): void {
  result = { ...result, findings: result.findings.map((f) => attachGuidesToScanFinding(f)) };

  if (outputOptions.mode === 'machine') {
    jsonOut('scan', { ...result });
    return;
  }

  if (outputOptions.mode === 'pipe') {
    // Tab-separated: score, scanned_at, duration_ms
    pipeOut(`scan\t${result.score}\t${result.scannedAt}\t${result.durationMs}`);
    for (const f of result.findings) {
      // Always emit the guide column, empty when there is none, so every
      // finding row has the same field count for cut/awk consumers.
      pipeOut(`finding\t${f.id}\t${f.service}\t${f.status}\t${f.confidence}\t${f.summary}\t${guideReference(f.guides ?? [])}`);
    }
    return;
  }
  // ... rest unchanged
```

This extends the pipe row contract, which PR 3 deliberately left alone. It is spec-mandated here ("pipe mode: `guide:<id>` reference column"), and it is additive in the safe direction: the column goes **last**, so existing field indices are unchanged, and the existing assertion in `src/__tests__/cli-output.test.ts` (`expect(...).toContain('finding\tREDIS-001')`) still passes with a trailing empty field.

and render the block in `printFindingGroup`, after the existing explanation lines:

```ts
function printFindingGroup(findings: ScanFinding[]): void {
  for (const f of findings) {
    const statusIcon = healthStatusIcon(f.status);
    console.log(
      chalk.dim('  ') +
      chalk.cyan(f.id.padEnd(12)) +
      statusIcon + ' ' +
      f.service +
      chalk.dim(` — ${f.summary}`),
    );
    if (!outputOptions.terse && f.explanation) {
      console.log(chalk.dim(`      ${f.explanation}`));
      if (f.learnMoreUrl) console.log(chalk.dim(`      Learn more: ${f.learnMoreUrl}`));
    }
    printRemediationGuides(f.guides);
  }
}
```

- [ ] **Step 6: Attach and render in the diagnose path**

In `printDiagnosis`, attach right after the existing enrichment, and print guides under each finding:

```ts
export function printDiagnosis(
  diagnosis: DiagnosisResult,
  ctx?: ExplanationContext,
  scope?: GuidanceScope,
): void {
  diagnosis = attachGuidesToDiagnosis(enrichDiagnosis(diagnosis, ctx), scope);
  if (outputOptions.mode === 'machine') {
    jsonOut('diagnosis', { diagnosis });
    return;
  }
  // ... unchanged through the findings loop, where the last statement becomes:
  for (const finding of diagnosis.findings) {
    const sevColor = findingSeverityColor(finding.severity);
    console.log(sevColor(`    [${finding.severity.toUpperCase()}] `) + chalk.dim(`${finding.source}: ${finding.observation}`));
    if (finding.severity !== 'info' && finding.explanation) {
      console.log(chalk.dim(`        ${finding.explanation}`));
      if (finding.learnMoreUrl) {
        console.log(chalk.dim(`        Learn more: ${finding.learnMoreUrl}`));
      }
    }
    printRemediationGuides(finding.guides, '        ');
  }
  console.log('');
}
```

- [ ] **Step 7: Scope each scan finding to its target's platform**

First verify PR 3's signal mapping is in place:

Run: `grep -n "s.checkId" src/cli/commands/scan.ts`

Expected: the `...(s.checkId !== undefined ? { checkId: s.checkId } : {})` spread inside `checkTargetHealth`'s `health.signals.map(...)`. **That line is PR 3's — leave it alone.** (If the grep is empty, add it; it is what carries check ids from health signals into scan findings.)

Next to that spread, add the matching one for `guideVars` — this one is new to this PR, so it will not already be there:

```ts
          ...(s.guideVars !== undefined ? { guideVars: s.guideVars } : {}),
```

Without this, a signal's `HealthSignal.guideVars` (Task 1, populated by aws-rds in Task 9) never reaches the `ScanFinding` that `attachGuidesToScanFinding` (Task 6) reads — the guide would attach by checkId but keep its placeholders literal.

Then add the platform scope, which is this PR's part. `checkTargetHealth` is where the `TargetConfig` is in hand, so this is the one place that can resolve it. Add the import to the top import block:

```ts
import { platformsForTarget } from '../../framework/guidance/platforms.js';
```

and add one member to the `finding` object in the success return (alongside `service`, `status`, `summary`, …), plus the same member in the `catch` return so an errored target does not inherit unscoped guidance:

```ts
        ...(platformsForTarget(target.kind, target.name) !== undefined
          ? { guidancePlatforms: platformsForTarget(target.kind, target.name) }
          : {}),
```

- [ ] **Step 7b: Pass the scope into diagnose**

In `src/cli/commands/diagnose.ts`, add the import to the top import block:

```ts
import { platformsForTarget } from '../../framework/guidance/platforms.js';
```

and pass the scope at the `printDiagnosis` call (currently `printDiagnosis(diagnosis, explanationCtx);`):

```ts
    printDiagnosis(diagnosis, explanationCtx, { platforms: platformsForTarget(target.kind, target.name) });
```

Other `printDiagnosis` callers (`src/live.ts`, the demo) pass no scope and keep today's unfiltered behavior — correct, because they do not know the platform either.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts src/__tests__/cli-output.test.ts src/__tests__/cli-snapshots.test.ts`
Expected: PASS. If a snapshot in `cli-snapshots.test.ts` changed, inspect the diff first — the only acceptable change is added guidance lines for findings that carry a `checkId`. Update snapshots with `pnpm vitest run src/__tests__/cli-snapshots.test.ts -u` only after confirming that.

- [ ] **Step 9: Typecheck, lint, full suite**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add src/cli/output.ts src/cli/commands/scan.ts src/cli/commands/diagnose.ts src/__tests__/guidance-output.test.ts src/__tests__/__snapshots__
git commit -m "feat(guidance): render remediation guides in scan and diagnose output"
```

---

## Task 8: Wire guidance into the readiness report

**Files:**
- Modify: `src/readiness/types.ts` (`ReadinessFinding`)
- Modify: `src/cli/commands/readiness.ts` (`renderReadinessReport`, `runReadinessCommand`)
- Modify: `src/__tests__/guidance-output.test.ts`

**Interfaces:**
- Consumes: `attachGuidesByRuleId` (Task 6); `renderGuidesLines` (Task 6).
- Produces: `ReadinessFinding.guides?: RemediationGuide[] | undefined`; `renderReadinessReport(report: ReadinessReport, opts?: { terse?: boolean | undefined }): string[]` (new optional second parameter — existing single-argument callers keep working).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/guidance-output.test.ts`:

Add these to the file's top import block alongside the imports from Task 7:

```ts
import { renderReadinessReport } from '../cli/commands/readiness.js';
import { attachGuidesByRuleId } from '../framework/guidance/attach.js';
import type { ReadinessReport } from '../readiness/types.js';

describe('readiness output — guidance', () => {
  const report: ReadinessReport = {
    verdict: 'at-risk',
    score: 60,
    evaluated: 1,
    unknown: 0,
    findings: [{
      ruleId: 'serverless-pooling',
      title: 'Serverless connection pooling',
      status: 'at_risk',
      evidence: ['DATABASE_URL points at port 5432 (direct connection)'],
      explanation: 'Each serverless invocation opens its own connection; the database runs out long before traffic does.',
      fix: 'Route serverless traffic through a transaction pooler.',
      learnMoreUrl: 'https://vercel.com/guides/connection-pooling-with-serverless-functions',
    }],
  };

  it('renders the matching platform guides under an at-risk finding', () => {
    const lines = renderReadinessReport(report).join('\n');
    expect(lines).toContain('How to fix it: Use the Supabase transaction pooler for serverless functions');
    expect(lines).toContain('How to fix it: Switch Neon to the pooled connection endpoint');
    expect(lines).toContain('(path verified 2026-08-05)');
  });

  it('collapses guides to title and URL when terse', () => {
    const lines = renderReadinessReport(report, { terse: true }).join('\n');
    expect(lines).toContain('How to fix it: Use the Supabase transaction pooler for serverless functions — https://supabase.com/dashboard/project/_/settings/database');
    expect(lines).not.toContain('1. Open the Supabase dashboard');
  });

  it('renders no guidance for a ready finding', () => {
    const ready: ReadinessReport = {
      ...report,
      findings: [{ ...report.findings[0]!, status: 'ready' }],
    };
    expect(renderReadinessReport(ready).join('\n')).not.toContain('How to fix it');
  });

  it('renders no guidance for a rule with no guides', () => {
    const other: ReadinessReport = {
      ...report,
      findings: [{ ...report.findings[0]!, ruleId: 'long-transactions' }],
    };
    expect(renderReadinessReport(other).join('\n')).not.toContain('How to fix it');
  });

  it('attaches full guide objects for --json consumers', () => {
    const attached = { ...report, findings: report.findings.map((f) => attachGuidesByRuleId(f)) };
    expect(attached.findings[0]!.guides?.map((g) => g.id)).toEqual(['supabase-pooler-mode', 'neon-pooled-connection']);
    expect(attached.findings[0]!.guides?.[0]?.consoleSteps.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts`
Expected: FAIL — `expected '…' to contain 'How to fix it: Use the Supabase transaction pooler…'`.

- [ ] **Step 3: Add the carrier field to ReadinessFinding**

In `src/readiness/types.ts`, add the import to the top import block and the field to the interface:

```ts
import type { RemediationGuide } from '../types/remediation-guide.js';
```

```ts
export interface ReadinessFinding {
  ruleId: string;
  title: string;
  status: ReadinessStatus;
  /** 0-1 remaining capacity for headroom-style rules */
  headroom?: number | undefined;
  /** Raw observations backing the status — shown verbatim to the user */
  evidence: string[];
  /** Plain-English what/why for a reader with no ops background */
  explanation: string;
  /** Concrete next action */
  fix: string;
  learnMoreUrl: string;
  /** Required when status is 'unknown': why the rule could not evaluate */
  reason?: string | undefined;
  /** Remediation guides matched to this rule id (attached at render time). */
  guides?: RemediationGuide[] | undefined;
}
```

- [ ] **Step 4: Attach and render in the readiness command**

In `src/cli/commands/readiness.ts`, add these to the top import block:

```ts
import { attachGuidesByRuleId } from '../../framework/guidance/attach.js';
import { renderGuidesLines } from '../../framework/guidance/render.js';
import { outputOptions } from '../output.js';
```

Change the renderer to attach guides itself (so every caller — the command, tests, and any future consumer — gets the same lines) and to render them only for findings that are actually at risk, mirroring where `explanation`/`fix` already print:

```ts
export function renderReadinessReport(
  report: ReadinessReport,
  opts: { terse?: boolean | undefined } = {},
): string[] {
  const lines: string[] = [];
  lines.push(`Scale readiness: ${report.verdict} (score ${report.score}/100)`);
  lines.push(`${report.evaluated} rules evaluated, ${report.unknown} could not run`);
  lines.push('');
  for (const raw of report.findings) {
    const f = attachGuidesByRuleId(raw);
    lines.push(`${STATUS_ICON[f.status] ?? '·'} ${f.title} [${f.status}]`);
    for (const e of f.evidence) lines.push(`    ${e}`);
    if (f.status === 'unknown' && f.reason) lines.push(`    could not run: ${f.reason}`);
    if (f.status === 'at_risk' || f.status === 'blocking') {
      lines.push(`    ${f.explanation}`);
      lines.push(`    Fix: ${f.fix}`);
      lines.push(`    Learn more: ${f.learnMoreUrl}`);
      for (const line of renderGuidesLines(f.guides ?? [], { terse: opts.terse })) {
        lines.push(line === '' ? '' : `    ${line}`);
      }
    }
  }
  // ... ceilings/weak-link block unchanged
  return lines;
}
```

and in `runReadinessCommand`, attach before the machine-mode branch so `--json` carries the guide objects too, and pass `terse` through:

```ts
export async function runReadinessCommand(): Promise<void> {
  const raw = await runReadiness();
  const report: ReadinessReport = { ...raw, findings: raw.findings.map((f) => attachGuidesByRuleId(f)) };
  if (getOutputMode() === 'machine') {
    jsonOut('readiness', report);
    return;
  }
  printBanner();
  for (const line of renderReadinessReport(report, { terse: outputOptions.terse })) printInfo(line);
}
```

(`attachGuidesByRuleId` is idempotent — re-attaching an already-attached finding produces the same guides — so calling it in both places is safe.)

No `GuidanceScope` is passed here, on purpose: a readiness run sees a Postgres connection, not a vendor. `serverless-pooling` therefore offers both the Supabase and the Neon path and lets the reader pick the one they use — which is why the test above asserts both. That is the `platforms: undefined` case from the registry's scope contract, not an oversight.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts src/__tests__/readiness-cli.test.ts src/__tests__/readiness-report.test.ts`
Expected: PASS. `readiness-cli.test.ts` is the existing coverage for `renderReadinessReport` — if one of its assertions now sees extra guidance lines, confirm the added lines are guidance for an at-risk finding before adjusting the assertion.

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/readiness/types.ts src/cli/commands/readiness.ts src/__tests__/guidance-output.test.ts
git commit -m "feat(guidance): attach console guides to readiness findings"
```

---

## Task 9: Migrate the aws-rds inline console strings

**Files:**
- Create: `src/framework/guidance/guides/aws-rds.ts`
- Modify: `src/framework/guidance/registry.ts`
- Modify: `src/agent/aws-rds/agent.ts` (`controlPlaneSignals` ~287-293; `controlPlaneFindings` ~421-426; `buildControlPlaneSuggestionPlan` ~793-930)
- Modify: `src/__tests__/aws-rds-agent-control-plane.test.ts`
- Modify: `src/__tests__/guidance-render.test.ts` (re-enable the skipped test from Task 6)

**Interfaces:**
- Consumes: `AWS_RDS_CHECK_IDS`, `checkIdForRdsSource` (Task 5); `getGuideById`, `applyGuideVariables` (Task 2); `formatGuideForPlan` (Task 6).
- Produces: `awsRdsGuides: RemediationGuide[]` with ids `aws-rds-increase-storage`, `aws-rds-connection-saturation`, `aws-rds-open-security-group`, `aws-rds-instance-not-available`; `message.guideIds` **and** `message.guideVars` populated on every control-plane suggestion (Task 10's `printPlan` re-renders from those two, never from `detail`); a shared `controlPlaneGuideVars(source, instance, data)` helper whose output also populates `HealthSignal.guideVars` and `DiagnosisFinding.guideVars` on `controlPlaneSignals`/`controlPlaneFindings`, so scan and diagnose resolve the same `<instance>`/`<target-storage-gb>`/`<security-group-id>`/`<db-port>` placeholders the recover path already did.

**The strings being migrated** (verbatim from `src/agent/aws-rds/agent.ts`, so you can check nothing is lost):

1. Storage (lines 847-851):
   > `RDS storage is full on instance ${instance}. Increase allocated storage: RDS console → Databases → ${instance} → Modify → Allocated storage. CLI equivalent: aws rds modify-db-instance --db-instance-identifier ${instance} --allocated-storage ${targetGb} --apply-immediately.`
2. Connection saturation (lines 856-862):
   > `Database connections on instance ${instance} are approaching the limit. Consider connection pooling (RDS Proxy) or a larger instance class: RDS console → Databases → ${instance} → Modify → DB instance class. CLI equivalent: aws rds modify-db-instance --db-instance-identifier ${instance} --db-instance-class <larger-class> --apply-immediately. Note: applying a class change reboots the instance immediately — schedule during low traffic, or omit --apply-immediately to wait for the next maintenance window.`
3. Security group (lines 870-875):
   > `The security group blocks all inbound connections to instance ${instance}. Open the DB port to your app's security group: EC2 console → Security Groups → ${sgId} → Inbound rules. CLI equivalent: aws ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port ${port} --source-group <app-security-group-id>.`
4. Instance unavailable (lines 889-899), whose three branches are:
   > stopped: `Start the instance: RDS console → Databases → ${instance} → Actions → Start. CLI equivalent: aws rds start-db-instance --db-instance-identifier ${instance}.`
   > rebooting/maintenance: `The instance is currently '${status}' — wait and monitor; no action is needed unless it fails to return to 'available'.`
   > otherwise: `Review recent events and contact AWS support if the instance does not return to 'available'.`
   > wrapped by: `RDS instance status is '${status}' on instance ${instance}. Check the status reason and recent events: RDS console → Databases → ${instance}. CLI equivalent: aws rds describe-db-instances --db-instance-identifier ${instance}. <guidance>`

The four guides carry this content with the observation sentence moved to the notification's `summary`/lead line and the three status branches expressed as conditional steps in one guide. The only additions are `expectedAfter` (required by the type) and one safety caution on the security-group guide.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/guidance-render.test.ts`, remove the `.skip` from the `attaches guides to diagnosis findings by checkId` test added in Task 6.

Then replace the two suggestion-plan tests in `src/__tests__/aws-rds-agent-control-plane.test.ts` (currently at lines 176-197) with:

```ts
  it('plans stay at suggestion level and carry the storage guide with its console path', async () => {
    const { agent, context } = makeAgent('storage_full');
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);

    const notifications = plan.steps.filter((s) => s.type === 'human_notification');
    const storage = notifications.find((s) => s.message.guideIds?.includes('aws-rds-increase-storage'));
    expect(storage, 'storage suggestion must reference the aws-rds-increase-storage guide').toBeDefined();

    const detail = storage!.message.detail;
    expect(detail).toContain('RDS console'); // console path present
    expect(detail).toContain('aws rds modify-db-instance'); // CLI equivalent present
    expect(detail).toContain('prod-db-01'); // placeholders resolved to the real instance
    expect(detail).not.toContain('<instance>');

    // guideVars lets any renderer rebuild the same text from the registry.
    expect(storage!.message.guideVars).toMatchObject({ instance: 'prod-db-01' });
    expect(storage!.message.guideVars?.['target-storage-gb']).toBeDefined();
  });

  it('control-plane diagnosis findings carry their checkId', async () => {
    const { agent, context } = makeAgent('storage_full');
    const diagnosis = await agent.diagnose(context);
    const storage = diagnosis.findings.find((f) => f.source === 'rds_storage');
    expect(storage?.checkId).toBe('aws-rds.storage_full');
    const backup = diagnosis.findings.find((f) => f.source === 'rds_backup_config');
    expect(backup?.checkId).toBeUndefined();
  });

  it('control-plane health signals carry their checkId', async () => {
    const { agent, context } = makeAgent('connection_saturation');
    const health = await agent.assessHealth(context);
    const signal = health.signals.find((s) => s.source === 'rds_connection_saturation');
    expect(signal?.checkId).toBe('aws-rds.connection_saturation');
  });

  it('instance_unavailable (e.g. a stopped instance) still yields a suggestion plan, not an empty one', async () => {
    const { agent, context } = makeAgent('instance_stopped');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBe('instance_unavailable');

    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    const notifications = plan.steps.filter((s) => s.type === 'human_notification');
    expect(notifications.length).toBeGreaterThan(0);
    const status = notifications.find((s) => s.message.guideIds?.includes('aws-rds-instance-not-available'));
    expect(status).toBeDefined();
    expect(status!.message.detail.toLowerCase()).toContain('stopped');
    expect(status!.message.detail).toContain('aws rds start-db-instance');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/aws-rds-agent-control-plane.test.ts src/__tests__/guidance-render.test.ts`
Expected: FAIL — `message.guideIds` is undefined, `checkId` is undefined, and `aws-rds-increase-storage` is not in the registry.

- [ ] **Step 3: Write the aws-rds guide content**

Create `src/framework/guidance/guides/aws-rds.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { AWS_RDS_CHECK_IDS } from '../../../agent/aws-rds/check-ids.js';
import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * The aws-rds console paths that used to be inline prose in agent.ts. Content
 * is the same guidance, restructured; `<instance>`, `<target-storage-gb>`,
 * `<security-group-id>` and `<db-port>` are substituted per-target at render
 * time via applyGuideVariables().
 */
export const awsRdsGuides: RemediationGuide[] = [
  {
    id: 'aws-rds-increase-storage',
    platform: 'aws-rds',
    title: 'Increase allocated storage on RDS instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.storageFull],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance>.',
      'Choose Modify → Allocated storage and raise it to <target-storage-gb> GiB.',
      'Choose Apply immediately to take effect now, or leave it for the next maintenance window.',
    ],
    cliEquivalent:
      'aws rds modify-db-instance --db-instance-identifier <instance> --allocated-storage <target-storage-gb> --apply-immediately',
    expectedAfter: 'Free storage rises above the threshold and the instance returns to available.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-connection-saturation',
    platform: 'aws-rds',
    title: 'Reduce connection saturation on RDS instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.connectionSaturation],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance>.',
      'Either put connection pooling in front of the database (RDS Proxy), or choose Modify → DB instance class and select a larger class.',
    ],
    cliEquivalent:
      'aws rds modify-db-instance --db-instance-identifier <instance> --db-instance-class <larger-class> --apply-immediately',
    expectedAfter: 'Connection count settles well below the instance limit.',
    caution:
      'Applying a class change reboots the instance immediately — schedule during low traffic, or omit --apply-immediately to wait for the next maintenance window.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-open-security-group',
    platform: 'aws-rds',
    title: 'Open RDS security group ingress on instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.securityGroup],
    url: 'https://console.aws.amazon.com/ec2/',
    consoleSteps: [
      'Open the EC2 console → Security Groups → <security-group-id>.',
      'Choose Inbound rules → Edit inbound rules, and allow TCP port <db-port> with your application\'s security group as the source.',
    ],
    cliEquivalent:
      'aws ec2 authorize-security-group-ingress --group-id <security-group-id> --protocol tcp --port <db-port> --source-group <app-security-group-id>',
    expectedAfter: 'The application can open connections to the database again.',
    caution:
      'Use the application\'s security group as the source. Opening the database port to 0.0.0.0/0 exposes it to the internet.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-instance-not-available',
    platform: 'aws-rds',
    title: 'Bring RDS instance <instance> back to available',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.instanceStatus],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance> and read the current status and status reason.',
      'Check Logs & events → Recent events for what changed.',
      'If the status is \'stopped\', choose Actions → Start.',
      'If the status is \'rebooting\' or maintenance is in progress, wait and monitor — no action is needed unless it fails to return to \'available\'.',
      'Otherwise, review recent events and contact AWS support if the instance does not return to \'available\'.',
    ],
    cliEquivalent:
      'aws rds describe-db-instances --db-instance-identifier <instance> (then, if stopped: aws rds start-db-instance --db-instance-identifier <instance>)',
    expectedAfter: 'Instance status returns to \'available\' and clients can connect.',
    verifiedOn: '2026-08-05',
  },
];
```

Register it in `src/framework/guidance/registry.ts`:

```ts
import { awsRdsGuides } from './guides/aws-rds.js';

export const REMEDIATION_GUIDES: readonly RemediationGuide[] = [
  ...anthropicGuides,
  ...openaiGuides,
  ...supabaseGuides,
  ...neonGuides,
  ...awsRdsGuides,
];
```

- [ ] **Step 4: Tag aws-rds signals and findings with their checkId and guideVars**

**Careful — `rds_instance_status` is emitted twice.** `assessHealth` builds a base instance-status signal inline at `agent.ts:317` (from `config.status`, the backup-config path), and `gatherControlPlaneItems` produces a second one that arrives via `controlPlaneSignals`. Only the control-plane copy carries the guidance anchor, and only the two mappings named below get edited. Do not "helpfully" tag the base signal at line 317 — that would attach RDS console guidance to a healthy backup-config reading.

In `src/agent/aws-rds/agent.ts`, add the import:

```ts
import { checkIdForRdsSource } from './check-ids.js';
```

**Both `controlPlaneSignals` (feeds scan) and `controlPlaneFindings` (feeds diagnose) need the exact same per-target variables `buildControlPlaneSuggestionPlan` computes for the recover path in Step 5** — otherwise scan and diagnose can only attach the raw guide with its `<instance>`-style placeholders unresolved, while recover shows the real values. Rather than compute `vars` three times (and risk the three computations drifting), add one pure helper above `controlPlaneSignals`/`controlPlaneFindings` that all three call sites share:

```ts
/**
 * The guide placeholder substitutions for one control-plane item, derived
 * from the same `source` and `data` used to build its signal/finding. Shared
 * by assessHealth's controlPlaneSignals, diagnose's controlPlaneFindings, and
 * plan's pushSuggestion call sites (Step 5) so scan, diagnose, and recover
 * render the exact same resolved values from one computation, not three.
 * Returns undefined for sources with no guide (checkIdForRdsSource already
 * returned undefined for those; this mirrors that).
 */
function controlPlaneGuideVars(
  source: string,
  instance: string,
  data: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  switch (source) {
    case 'rds_storage': {
      const currentGb = typeof data?.allocatedStorageGb === 'number' ? (data.allocatedStorageGb as number) : 20;
      return { instance, 'target-storage-gb': String(currentGb + 20) };
    }
    case 'rds_connection_saturation':
      return { instance };
    case 'rds_security_group': {
      const sgIds = data?.vpcSecurityGroupIds;
      const sgId = Array.isArray(sgIds) && sgIds.length > 0 ? String(sgIds[0]) : 'sg-unknown';
      const port = typeof data?.port === 'number' ? (data.port as number) : 5432;
      return { instance, 'security-group-id': sgId, 'db-port': String(port) };
    }
    case 'rds_instance_status':
      return { instance };
    default:
      return undefined;
  }
}
```

Change the `controlPlaneSignals` mapping (currently lines 287-293):

```ts
    const controlPlaneSignals: HealthSignal[] = controlPlaneItems.map((item) => {
      const checkId = checkIdForRdsSource(item.source);
      const guideVars = controlPlaneGuideVars(item.source, config.instanceId, item.data);
      return {
        source: item.source,
        status: item.isPermissionMissing ? 'unknown' : signalStatus(item.critical, item.warning),
        detail: item.message,
        observedAt,
        entityId: config.instanceId,
        ...(checkId !== undefined ? { checkId } : {}),
        ...(guideVars !== undefined ? { guideVars } : {}),
      };
    });
```

Change the `controlPlaneFindings` mapping (currently lines 421-426):

```ts
    const controlPlaneFindings: DiagnosisFinding[] = controlPlaneItems.map((item) => {
      const checkId = checkIdForRdsSource(item.source);
      const guideVars = controlPlaneGuideVars(item.source, config.instanceId, item.data);
      return {
        source: item.source,
        observation: item.message,
        severity: item.isPermissionMissing ? 'info' : item.critical ? 'critical' : item.warning ? 'warning' : 'info',
        ...(item.data ? { data: item.data } : {}),
        ...(checkId !== undefined ? { checkId } : {}),
        ...(guideVars !== undefined ? { guideVars } : {}),
      };
    });
```

- [ ] **Step 5: Build suggestion steps from guides**

In `src/agent/aws-rds/agent.ts`, add the imports:

```ts
import { formatGuideForPlan } from '../../framework/guidance/render.js';
import { applyGuideVariables, getGuideById } from '../../framework/guidance/registry.js';
```

Replace the `pushSuggestion` helper in `buildControlPlaneSuggestionPlan` (currently lines 823-838) so the how-to text comes from the guide and the step records which guide it came from:

```ts
    let stepSeq = 2;
    /**
     * Every control-plane suggestion is one guide plus the observation that
     * triggered it. The console path lives in the guidance registry, not
     * here — one source of truth, rendered the same way in the plan, in
     * `scan`, and in `--json`. `guideVars` records the substitutions so any
     * renderer can rebuild the same text from the registry without parsing
     * `detail`.
     */
    const pushSuggestion = (
      summary: string,
      observation: string,
      guideId: string,
      vars: Record<string, string>,
    ): void => {
      const guide = getGuideById(guideId);
      const detail = guide
        ? `${observation}\n${formatGuideForPlan(applyGuideVariables(guide, vars))}`
        : observation;
      steps.push({
        stepId: `step-${String(stepSeq).padStart(3, '0')}`,
        type: 'human_notification',
        name: summary,
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary,
          detail,
          contextReferences: ['current_rds_control_plane_state'],
          actionRequired: true,
          ...(guide ? { guideIds: [guide.id], guideVars: vars } : {}),
        },
        channel: 'auto',
      });
      stepSeq += 1;
    };
```

Then rewrite the four call sites (currently lines 840-900), keeping the surrounding conditions and data extraction exactly as they are, but computing `vars` via `controlPlaneGuideVars` (Step 4) instead of a fresh inline literal — the non-null assertion is safe because each branch's own `if` already gated on the finding whose `source` maps to a defined `controlPlaneGuideVars` case:

```ts
    const storageFinding = diagnosis.findings.find((f) => f.source === 'rds_storage');
    if (storageFinding && storageFinding.severity === 'critical') {
      pushSuggestion(
        `Increase allocated storage on RDS instance ${instance}`,
        `RDS storage is full on instance ${instance}.`,
        'aws-rds-increase-storage',
        controlPlaneGuideVars('rds_storage', instance, storageFinding.data)!,
      );
    }

    const saturationFinding = diagnosis.findings.find((f) => f.source === 'rds_connection_saturation');
    if (saturationFinding && (saturationFinding.severity === 'critical' || saturationFinding.severity === 'warning')) {
      pushSuggestion(
        `Reduce connection saturation on RDS instance ${instance}`,
        `Database connections on instance ${instance} are approaching the limit.`,
        'aws-rds-connection-saturation',
        controlPlaneGuideVars('rds_connection_saturation', instance, saturationFinding.data)!,
      );
    }

    const sgFinding = diagnosis.findings.find((f) => f.source === 'rds_security_group');
    if (sgFinding && sgFinding.severity === 'critical') {
      pushSuggestion(
        `Open RDS security group ingress on instance ${instance}`,
        `The security group blocks all inbound connections to instance ${instance}.`,
        'aws-rds-open-security-group',
        controlPlaneGuideVars('rds_security_group', instance, sgFinding.data)!,
      );
    }

    // The instance itself is unavailable (not the storage/saturation/sg
    // conditions above, each of which already explains *why* and takes
    // priority in diagnose()'s scenario selection). Reachable in practice
    // any time the live client reports a non-'available' status that isn't
    // 'storage-full' — e.g. stopped, failed, incompatible-parameters — even
    // though the simulator only exercises 'stopped' today.
    if (diagnosis.scenario === 'instance_unavailable' && instanceStatusFinding?.severity === 'critical') {
      const status =
        typeof instanceStatusFinding.data?.status === 'string'
          ? (instanceStatusFinding.data.status as string)
          : 'unknown';
      pushSuggestion(
        `RDS instance ${instance} is not available (status: ${status})`,
        `RDS instance status is '${status}' on instance ${instance}.`,
        'aws-rds-instance-not-available',
        controlPlaneGuideVars('rds_instance_status', instance, instanceStatusFinding.data)!,
      );
    }
```

The per-status `guidance` ternary is deleted: its three branches are now steps 3-5 of `aws-rds-instance-not-available`, which state the same advice conditionally rather than picking one branch. The status itself still appears in the step name and the observation line.

- [ ] **Step 6: Run the aws-rds and guidance tests**

Run: `pnpm vitest run src/__tests__/aws-rds-agent-control-plane.test.ts src/__tests__/guidance-render.test.ts src/__tests__/guidance-registry.test.ts src/__tests__/guidance-output.test.ts`
Expected: PASS — including the two aws-rds placeholder-substitution tests added to `guidance-output.test.ts` in Task 7, which only turn green once `controlPlaneSignals`/`controlPlaneFindings` above carry `guideVars`.

- [ ] **Step 7: Run every aws-rds and plan-shape test**

Run: `pnpm vitest run src/__tests__ -t "rds" && pnpm vitest run src/__tests__/generated-plans.test.ts src/__tests__/validator.test.ts`
Expected: PASS. If a plan-validation test objects to the new `guideIds` member, the SDK type from Task 1 was not rebuilt — run `pnpm --filter @crisismode/agent-sdk run build`.

- [ ] **Step 8: Typecheck, lint, full suite**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/framework/guidance/guides/aws-rds.ts src/framework/guidance/registry.ts src/agent/aws-rds/agent.ts src/__tests__/aws-rds-agent-control-plane.test.ts src/__tests__/guidance-render.test.ts
git commit -m "refactor(aws-rds): migrate inline console guidance to RemediationGuide"
```

---

## Task 10: Render guidance on the recover surface (`printPlan`)

**Files:**
- Modify: `src/cli/output.ts` (`printPlan`, ~230-266)
- Modify: `src/__tests__/guidance-output.test.ts`

**Interfaces:**
- Consumes: `getGuideById`, `applyGuideVariables` (Task 2); `printRemediationGuides` (Task 7); `message.guideIds` / `message.guideVars` (Tasks 1 and 9).
- Produces: `printPlan` renders a guidance block for every `human_notification` step that names guides. Rendering reads `guideIds` + `guideVars` through the registry — **never** `message.detail`, which is free-form prose no renderer should parse.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/guidance-output.test.ts`:

Add `printPlan` to the existing `../cli/output.js` import at the top of the file rather than adding a second import line, and add the plan type:

```ts
import type { RecoveryPlan } from '../types/recovery-plan.js';

function planWithGuidedSuggestion(): RecoveryPlan {
  return {
    metadata: {
      planId: 'plan-aws-rds-control-plane',
      agentName: 'aws-rds-recovery',
      agentVersion: '1.0.0',
      scenario: 'storage_full',
      generatedAt: '2026-08-05T12:00:00.000Z',
      estimatedDuration: 'PT5M',
      summary: 'Suggested remediation for RDS instance prod-db-01.',
    },
    impact: {
      affectedSystems: [],
      affectedServices: ['database-availability'],
      estimatedUserImpact: 'No user-facing impact.',
      dataLossRisk: 'none',
    },
    steps: [{
      stepId: 'step-002',
      type: 'human_notification',
      name: 'Increase allocated storage on RDS instance prod-db-01',
      recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
      message: {
        summary: 'Increase allocated storage on RDS instance prod-db-01',
        detail: 'RDS storage is full on instance prod-db-01.',
        actionRequired: true,
        guideIds: ['aws-rds-increase-storage'],
        guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
      },
      channel: 'auto',
    }],
    rollbackStrategy: { type: 'none', description: 'No mutations were performed by this plan.' },
  } as RecoveryPlan;
}

describe('recover output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('renders the guide for a suggestion step, resolved with its guideVars', () => {
    configure({ mode: 'human', noColor: true });
    printPlan(planWithGuidedSuggestion());
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Increase allocated storage on RDS instance prod-db-01');
    expect(text).toContain('Modify → Allocated storage and raise it to 40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });

  it('renders from the registry, not from message.detail prose', () => {
    configure({ mode: 'human', noColor: true });
    const plan = planWithGuidedSuggestion();
    const step = plan.steps[0]!;
    if (step.type === 'human_notification') step.message.detail = '';
    printPlan(plan);
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('aws rds modify-db-instance');
  });

  it('collapses to title and URL when terse', () => {
    configure({ mode: 'human', noColor: true });
    setOutputOptions({ terse: true });
    printPlan(planWithGuidedSuggestion());
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Increase allocated storage on RDS instance prod-db-01 — https://console.aws.amazon.com/rds/');
    expect(text).not.toContain('Modify → Allocated storage and raise it');
  });

  it('machine mode prints the plan as JSON with guideIds intact and no rendered block', () => {
    configure({ json: true, noColor: true });
    printPlan(planWithGuidedSuggestion());
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.plan.steps[0].message.guideIds).toEqual(['aws-rds-increase-storage']);
    expect(logSpy.mock.calls).toHaveLength(1);
  });

  it('a plan step with no guideIds renders no guidance', () => {
    configure({ mode: 'human', noColor: true });
    const plan = planWithGuidedSuggestion();
    if (plan.steps[0]!.type === 'human_notification') delete plan.steps[0]!.message.guideIds;
    printPlan(plan);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('How to fix it');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts`
Expected: FAIL — `expected '…' to contain 'How to fix it: Increase allocated storage…'` (printPlan prints only the step table today).

- [ ] **Step 3: Render guides in printPlan**

In `src/cli/output.ts`, add `getGuideById` and `applyGuideVariables` to the guidance imports in the top import block:

```ts
import { applyGuideVariables, getGuideById, type GuidanceScope } from '../framework/guidance/registry.js';
import type { RecoveryStep } from '../types/step-types.js';
```

(`output.ts` imports `RecoveryPlan` today but not `RecoveryStep`; `GuidanceScope` is already imported from Task 7 — merge, do not duplicate the import line.)

Add a helper next to `printRemediationGuides`:

```ts
/**
 * Guides a plan step points at, resolved with the substitutions the agent
 * recorded. Rendering from guideIds + guideVars (not from message.detail)
 * keeps one renderer in charge of the words: the step records *which* guide
 * and *what values*, never the formatting.
 */
function guidesForStep(step: RecoveryStep): RemediationGuide[] {
  if (step.type !== 'human_notification') return [];
  const ids = step.message.guideIds ?? [];
  const vars = step.message.guideVars ?? {};
  return ids
    .map((id) => getGuideById(id))
    .filter((g): g is RemediationGuide => g !== undefined)
    .map((g) => applyGuideVariables(g, vars));
}
```

and call it inside `printPlan`'s step loop, after the existing risk-framing block:

```ts
    const framing = outputOptions.mode === 'human' && !outputOptions.terse ? buildRiskFraming(s, plan.rollbackStrategy) : null;
    if (framing) {
      console.log(chalk.dim(`       what:  ${framing.does}`));
      console.log(chalk.yellow(`       risk:  `) + chalk.dim(framing.couldGoWrong));
      console.log(chalk.dim(`       undo:  ${framing.undo}`));
    }
    printRemediationGuides(guidesForStep(s), '       ');
```

`printRemediationGuides` already returns early for machine and pipe mode and honors `--terse`, so no mode handling is duplicated here. The machine-mode branch at the top of `printPlan` is untouched: `guideIds` and `guideVars` are already part of the serialized plan.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/__tests__/guidance-output.test.ts`
Expected: PASS.

- [ ] **Step 5: Check the plan-rendering neighbours**

Run: `pnpm vitest run src/__tests__/cli-snapshots.test.ts src/__tests__/generated-plans.test.ts`
Expected: PASS. A snapshot that now includes guidance lines for a suggestion step is the intended change — confirm the diff shows only added `How to fix it:` blocks before running with `-u`.

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/output.ts src/__tests__/guidance-output.test.ts src/__tests__/__snapshots__
git commit -m "feat(guidance): render guides for suggestion steps in recovery plans"
```

---

## Task 11: Document the freshness rule and the module

**Files:**
- Modify: `CONTRIBUTING.md` (new subsection under `## Code Standards`)
- Modify: `CLAUDE.md` (Key Files table, and the framework bullet list under "Key abstractions")

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Add the freshness rule to CONTRIBUTING.md**

Insert this subsection at the end of `## Code Standards` in `CONTRIBUTING.md`:

```markdown
### Remediation guides (`src/framework/guidance/`)

Guides are the "open this URL, click this, expect that" instructions CrisisMode
shows for fixes it must not perform itself (console actions on managed
platforms). They are static data — one `RemediationGuide` per fix, keyed to the
finding types it answers.

Rules for editing them:

- **`applicableFindingTypes` must name something the codebase emits** — a
  registered readiness rule id (`src/readiness/rules/index.ts`) or an agent
  `checkId` constant. `src/__tests__/guidance-registry.test.ts` fails the build
  otherwise, which is how a renamed rule gets caught instead of silently
  orphaning its guidance.
- **Changing a guide's steps means re-verifying the path.** Open the console,
  follow your own steps, then set `verifiedOn` to the date you did it. A test
  fails when any guide's `verifiedOn` is more than 12 months old, so stale
  paths surface on their own schedule rather than in someone's incident.
- **No account-specific deep links, no screenshots.** Top-level console URLs
  and click paths only — they survive UI changes better and work for every
  reader.
- **Use `<placeholder>` tokens** (`<instance>`, `<db-port>`) for anything
  target-specific; callers substitute them with `applyGuideVariables()`.
```

- [ ] **Step 2: Add the module to CLAUDE.md**

In `CLAUDE.md`, add a bullet to the "Key abstractions" list after the `OperatorSummary` entry:

```markdown
- **Remediation guidance** (`src/framework/guidance/`) — static `RemediationGuide` registry (console steps, CLI equivalent, expected outcome, `verifiedOn`) keyed to readiness rule ids and agent `checkId`s; rendered identically by scan, diagnose, readiness, and recover
```

and a row to the Key Files table after the `src/framework/escalation.ts` row:

```markdown
| `src/framework/guidance/registry.ts` | Remediation guide registry — console-step guidance keyed to finding types |
```

- [ ] **Step 3: Verify the docs match reality**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all clean. Re-read the two edited docs and confirm every path, command, and file name in them exists.

- [ ] **Step 4: Verify at the real CLI surface**

Run: `pnpm run build && node dist/cli/index.js readiness --json | head -40`

Expected: the readiness JSON carries `guides` arrays on any finding whose rule has guidance. Then run the human form and confirm the "How to fix it" block renders with numbered steps:

Run: `node dist/cli/index.js readiness`

If no local target produces a guided finding, run `node dist/cli/index.js scan --json` on a machine with `ANTHROPIC_API_KEY` set to an invalid value and confirm the key-validity finding carries `guides[0].id === 'anthropic-rotate-key'` and **no `openai-*` guide** (platform scoping working end to end).

Then exercise the recover surface, which renders through `printPlan`:

Run: `node dist/cli/index.js recover --target <an-aws-rds-target>` (dry-run is the default; it performs no mutations)

Expected: the storage/saturation/security-group suggestion step is followed by a "How to fix it" block with numbered console steps and the real instance id — no `<instance>` placeholders. Note in the PR description which surfaces you exercised.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md CLAUDE.md
git commit -m "docs(guidance): document the remediation guide freshness rule"
```

---

## Out of scope (deliberately)

- **Automating any guided action.** These stay Suggest-level; no `system_action` is added by this PR.
- **Deploy-platform guidance** (Vercel, Netlify, Railway) — no deploy-platform diagnosis exists to anchor it, and an unanchored guide fails Task 5's enforcement test by construction.
- **Vector-store console guides** (Pinecone, Upstash) — `vector-store.*` checkIds are in the anchoring set so guides can be added without further plumbing, but the spec's content table does not include them and no console path has been verified.
- **Guides for `llm-provider.key_present`, `llm-provider.model_deprecated`, and `llm-provider.provider_status`** — none of the three is in the spec's content table. (`key_present` in particular has no console path to offer: the fix is "set the environment variable where your app runs", which PR 3's finding already says in plain language.) The anchoring test does not require every checkId to have a guide, only that every guide has a real anchor.
