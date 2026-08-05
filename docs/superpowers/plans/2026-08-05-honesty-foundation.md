# Honesty Foundation (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CrisisMode's scan output stop implying live-validated coverage it does not have, and reframe cross-system correlation as investigation guidance rather than root-cause assertion.

**Architecture:** A new `src/framework/agent-maturity.ts` module collapses the manifest's five-value `metadata.plugin.maturity` into a two-value `AgentMaturity` that the honesty layer uses everywhere. `AgentRegistry` exposes a `kind → AgentMaturity` map; `runScan` threads it into the visibility report (which splits its watching bucket) and onto individual findings (which gain `bestEffort: true`). Separately, `root-cause-synthesis.ts` gets three in-file changes — cluster membership scoped to the agents a rule actually matched, a working one-agent-one-cluster de-dup, and a written rule-freeze contract — plus reworded rendering in `printSynthesis`.

**Tech Stack:** TypeScript 7 (strict, ESM/NodeNext), vitest, chalk, pnpm workspaces.

## Global Constraints

- **TypeScript strict mode, ESM with NodeNext resolution:** every relative import ends in `.js` (e.g. `import { agentMaturity } from '../framework/agent-maturity.js';`).
- **Named exports only** — no default exports anywhere.
- **`import type { ... }`** for type-only imports (enforced by `@typescript-eslint/consistent-type-imports`).
- **SPDX header on every new source file:**
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
  New test files in `src/__tests__/` use only the first line (`// SPDX-License-Identifier: Apache-2.0`), matching the existing files there.
- **Pinned cross-PR contracts** (later PRs in this series depend on these exact names and types):
  - `AgentMaturity = 'live_validated' | 'simulator_only'`, derived from `manifest.metadata.plugin.maturity`.
  - `buildVisibilityReport` gains a `maturityByKind: Map<string, AgentMaturity>` parameter.
  - `VisibilityEntry` gains a `maturity` field. **Deviation to write PRs 2-5 against: the field is OPTIONAL — `maturity?: AgentMaturity`.** `VisibilityEntry` is shared by the `watching`, `blocked`, and `invisible` buckets, and the latter two describe things no agent watches, so a required field would force a meaningless value on them. Consumers must read it as "anything other than `'live_validated'`, absent included, is best-effort."
  - An unregistered or unknown kind is **best-effort** — the honest default is the pessimistic one.
  - Simulator-agent findings carry `bestEffort: true` in machine output.
- **`buildHeadline` counts and the health score are UNCHANGED by this PR.** Simulator-only findings are real probe results; they keep counting in "checked", "unhealthy", and the score. Do not touch `buildHeadline` or `computeHealthScore`.
- **No new correlation rules, no new inference, no agent removed or gated.** Detection behavior is unchanged; only presentation and claims change.
- **Conventional Commits:** `feat(scan): ...`, `fix(synthesis): ...`, `docs(contributing): ...`.
- **Commands:** single test file `pnpm vitest run src/__tests__/<file>.test.ts`; full suite `pnpm test`; types `pnpm run typecheck`; lint `pnpm run lint`.
- The feature branch already exists. Do not create branches. Do not amend or rebase existing commits.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/framework/agent-maturity.ts` | The `AgentMaturity` type, derivation from a manifest, `kind → maturity` map building, and the three honest hint strings. No CLI or config imports. |
| `src/__tests__/agent-maturity.test.ts` | Unit + enforcement tests for the module and `AgentRegistry.maturityByKind()`. |
| `src/__tests__/best-effort-findings.test.ts` | Renderer + `markBestEffort` tests for `bestEffort` findings. |
| `src/__tests__/scan-run-best-effort.test.ts` | End-to-end `runScan` test (autodiscovery and check-plugin discovery stubbed) proving a simulator-kind finding really comes out `bestEffort: true`. |
| `src/__tests__/agent-command-maturity.test.ts` | `crisismode agent list` / `agent info` maturity column. |

**Modified files**

| File | Change |
|---|---|
| `src/config/agent-registry.ts` | New `maturityByKind()` method. |
| `src/cli/visibility.ts` | `VisibilityEntry.maturity`, new `maturityByKind` parameter, `liveValidatedWatching`/`bestEffortWatching` helpers. |
| `src/cli/output.ts` | `printVisibility` splits the watching bucket; `ScanFinding.bestEffort`; `printFindingGroup` suffix; `printSynthesis` reframe. |
| `src/cli/commands/scan.ts` | `markBestEffort` helper; wires the maturity map into findings and the visibility report. |
| `src/cli/ai-summary.ts` | Honest coverage sentence in the fallback; validated/best-effort split in the AI input. |
| `src/cli/commands/agent.ts` | Maturity column in `list`, maturity + hint in `info`. |
| `src/framework/root-cause-synthesis.ts` | Cluster scoping fix, de-dup fix, narrative reframe, `CORRELATION_RULE_NAMES`, freeze-policy header. |
| `CONTRIBUTING.md` | Correlation-rule freeze policy paragraph. |
| `src/__tests__/visibility.test.ts`, `visibility-render.test.ts`, `ai-summary.test.ts`, `root-cause-synthesis.test.ts` | New cases (and one adjusted existing case, called out in Task 9). |

---

### Task 1: Agent maturity module and registry map

**Files:**
- Create: `src/framework/agent-maturity.ts`
- Modify: `src/config/agent-registry.ts` (imports at top, new method after `supportedKinds()` at line 67-69)
- Test: `src/__tests__/agent-maturity.test.ts`

**Interfaces:**
- Consumes: `AgentManifest` from `../types/manifest.js` (`metadata.plugin.maturity` is a `PluginMaturity`: `'experimental' | 'simulator_only' | 'dry_run_only' | 'live_validated' | 'production_certified'`); `AgentRegistration` (`{ kind: string; name: string; manifest: AgentManifest; source?: 'builtin' | 'plugin'; createAgent(...) }`).
- Produces:
  - `type AgentMaturity = 'live_validated' | 'simulator_only'`
  - `interface MaturitySource { kind: string; manifest: AgentManifest }`
  - `function agentMaturity(manifest: AgentManifest): AgentMaturity`
  - `function buildMaturityByKind(sources: MaturitySource[]): Map<string, AgentMaturity>`
  - `function bestEffortHint(system: string): string`
  - `const BEST_EFFORT_GROUP_HINT: string`
  - `const BEST_EFFORT_FINDING_SUFFIX: string`
  - `AgentRegistry.prototype.maturityByKind(): Map<string, AgentMaturity>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/agent-maturity.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  agentMaturity,
  buildMaturityByKind,
  bestEffortHint,
  BEST_EFFORT_GROUP_HINT,
  BEST_EFFORT_FINDING_SUFFIX,
} from '../framework/agent-maturity.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { AgentRegistry } from '../config/agent-registry.js';
import type { AgentManifest } from '../types/manifest.js';
import type { PluginMaturity } from '../types/plugin.js';
import type { SiteConfig } from '../config/schema.js';

/** The kinds whose agents have actually been run against real infrastructure. */
const LIVE_VALIDATED_KINDS = ['backup', 'disk', 'dns', 'kubernetes', 'postgresql', 'tls'];

const ALL_PLUGIN_MATURITIES: PluginMaturity[] = [
  'experimental',
  'simulator_only',
  'dry_run_only',
  'live_validated',
  'production_certified',
];

function manifestWith(maturity: PluginMaturity): AgentManifest {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'AgentManifest',
    metadata: {
      name: 'test-agent',
      version: '1.0.0',
      description: 'test',
      authors: ['test'],
      license: 'Apache-2.0',
      tags: [],
      plugin: { id: 'test.domain-pack', kind: 'domain_pack', maturity },
    },
    spec: {
      targetSystems: [],
      triggerConditions: [],
      failureScenarios: [],
      executionContexts: [],
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: { maxRiskLevel: 'routine', dataLossPossible: false, serviceDisruptionPossible: false },
      humanInteraction: { requiresApproval: true, minimumApprovalRole: 'on_call_engineer', escalationPath: [] },
    },
  };
}

const emptyConfig: SiteConfig = {
  apiVersion: 'crisismode/v1',
  kind: 'SiteConfig',
  metadata: { name: 'test-site', environment: 'development' },
  webhook: { port: 3000 },
  execution: { mode: 'dry-run' },
  targets: [],
};

describe('agentMaturity', () => {
  it('treats only live_validated as live-validated', () => {
    expect(agentMaturity(manifestWith('live_validated'))).toBe('live_validated');
  });

  it.each(ALL_PLUGIN_MATURITIES.filter((m) => m !== 'live_validated'))(
    'treats %s as best-effort (simulator_only)',
    (maturity) => {
      expect(agentMaturity(manifestWith(maturity))).toBe('simulator_only');
    },
  );
});

describe('buildMaturityByKind', () => {
  it('maps each kind to its maturity', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
      { kind: 'kafka', manifest: manifestWith('simulator_only') },
    ]);
    expect(map.get('postgresql')).toBe('live_validated');
    expect(map.get('kafka')).toBe('simulator_only');
  });

  it('leaves an unregistered kind absent, so callers apply the best-effort default', () => {
    const map = buildMaturityByKind([{ kind: 'postgresql', manifest: manifestWith('live_validated') }]);
    expect(map.has('mongodb')).toBe(false);
  });

  it('downgrades a kind to best-effort when any agent registered for it is unvalidated', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
      { kind: 'postgresql', manifest: manifestWith('simulator_only') },
    ]);
    expect(map.get('postgresql')).toBe('simulator_only');
  });

  it('downgrades regardless of registration order', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('simulator_only') },
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
    ]);
    expect(map.get('postgresql')).toBe('simulator_only');
  });
});

describe('honesty hint copy', () => {
  it('names the system in the per-system hint', () => {
    expect(bestEffortHint('kafka')).toBe(
      'checks exist but have never been validated against a real kafka; treat findings as leads, not conclusions.',
    );
  });

  it('frames group and finding hints as leads, not conclusions', () => {
    expect(BEST_EFFORT_GROUP_HINT).toContain('leads, not conclusions');
    expect(BEST_EFFORT_FINDING_SUFFIX).toContain('lead, not a conclusion');
  });
});

describe('maturity enforcement across built-in agents', () => {
  it('every registered agent manifest declares a maturity value', () => {
    for (const registration of builtinAgents) {
      expect(
        registration.manifest.metadata.plugin?.maturity,
        `agent '${registration.name}' declares no metadata.plugin.maturity`,
      ).toBeDefined();
      expect(ALL_PLUGIN_MATURITIES).toContain(registration.manifest.metadata.plugin.maturity);
    }
  });

  it('exactly the known-validated kinds are live-validated', () => {
    const map = buildMaturityByKind(
      builtinAgents.map((r) => ({ kind: r.kind, manifest: r.manifest })),
    );
    const live = [...map.entries()]
      .filter(([, maturity]) => maturity === 'live_validated')
      .map(([kind]) => kind)
      .sort();
    expect(live).toEqual(LIVE_VALIDATED_KINDS);
  });
});

describe('AgentRegistry.maturityByKind', () => {
  it('reports maturity for every registered kind', () => {
    const map = new AgentRegistry(emptyConfig).maturityByKind();
    expect(map.get('postgresql')).toBe('live_validated');
    expect(map.get('kafka')).toBe('simulator_only');
    expect(map.get('iac-drift')).toBe('simulator_only');
    expect(map.has('mongodb')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/agent-maturity.test.ts`
Expected: FAIL — `Failed to resolve import "../framework/agent-maturity.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/agent-maturity.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Agent maturity — the honesty layer's two-value view of a manifest's
 * `metadata.plugin.maturity`.
 *
 * CrisisMode registers many more agents than it has validated against real
 * infrastructure. Everything except an explicit `live_validated` manifest
 * value is reported to operators as best-effort: the checks exist and run,
 * but they have never been proven against a live system, so their findings
 * are leads rather than conclusions. Unknown and unregistered kinds get the
 * same treatment — the honest default is the pessimistic one.
 */

import type { AgentManifest } from '../types/manifest.js';

export type AgentMaturity = 'live_validated' | 'simulator_only';

/**
 * Minimal registration shape needed to derive maturity. Structural on
 * purpose: this module stays free of `src/config` imports so config can
 * depend on it and not the other way round.
 */
export interface MaturitySource {
  kind: string;
  manifest: AgentManifest;
}

/** One-line hint for the visibility report's best-effort bucket. */
export const BEST_EFFORT_GROUP_HINT =
  'checks exist but have never been validated against a real deployment; treat findings as leads, not conclusions.';

/** Suffix appended to a best-effort finding in human scan output. */
export const BEST_EFFORT_FINDING_SUFFIX =
  'best-effort: these checks have never been validated against real infrastructure — treat this as a lead, not a conclusion.';

/** Per-system hint, for surfaces that talk about one agent at a time (`agent info`). */
export function bestEffortHint(system: string): string {
  return `checks exist but have never been validated against a real ${system}; treat findings as leads, not conclusions.`;
}

/**
 * Collapse a manifest's five-value plugin maturity to the two values the
 * honesty layer reports. Optional chaining is deliberate: manifests loaded
 * from plugin JSON at runtime are not compile-time checked.
 */
export function agentMaturity(manifest: AgentManifest): AgentMaturity {
  return manifest.metadata.plugin?.maturity === 'live_validated' ? 'live_validated' : 'simulator_only';
}

/**
 * Build the kind → maturity map. A kind counts as live-validated only when
 * EVERY agent registered for it says so — with several agents per kind, the
 * one that actually runs is not known here, so claim the weaker of the two.
 */
export function buildMaturityByKind(sources: MaturitySource[]): Map<string, AgentMaturity> {
  const byKind = new Map<string, AgentMaturity>();
  for (const source of sources) {
    if (byKind.get(source.kind) === 'simulator_only') continue;
    byKind.set(source.kind, agentMaturity(source.manifest));
  }
  return byKind;
}
```

In `src/config/agent-registry.ts`, add to the import block (after the `semver` import at line 15):

```typescript
import { buildMaturityByKind } from '../framework/agent-maturity.js';
import type { AgentMaturity, MaturitySource } from '../framework/agent-maturity.js';
```

and add this method directly after `supportedKinds()` (which ends at line 69):

```typescript
  /**
   * Coarse maturity per registered kind, for the honesty layer. A kind is
   * 'live_validated' only when every agent registered for it declares that;
   * kinds with no registration are absent from the map, and callers treat
   * "absent" as best-effort.
   */
  maturityByKind(): Map<string, AgentMaturity> {
    const sources: MaturitySource[] = [];
    for (const [kind, registrations] of this.byKind) {
      for (const registration of registrations) {
        sources.push({ kind, manifest: registration.manifest });
      }
    }
    return buildMaturityByKind(sources);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/agent-maturity.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/framework/agent-maturity.ts src/config/agent-registry.ts src/__tests__/agent-maturity.test.ts
git commit -m "feat(honesty): derive coarse agent maturity from manifests"
```

---

### Task 2: Maturity in the visibility report

**Files:**
- Modify: `src/cli/visibility.ts` (interface at lines 12-16, `buildVisibilityReport` signature at lines 33-38, watching pushes at lines 46-62)
- Test: `src/__tests__/visibility.test.ts` (append cases inside the existing `describe('buildVisibilityReport', ...)`)

**Interfaces:**
- Consumes: `AgentMaturity` from `../framework/agent-maturity.js` (Task 1).
- Produces:
  - `VisibilityEntry` gains `maturity?: AgentMaturity` (set on `watching` entries; absent on `blocked`/`invisible`, which describe things no agent watches).
  - `buildVisibilityReport(profile: StackProfile, ranKinds: string[], configSource: string, extraBlocked?: VisibilityEntry[], maturityByKind?: Map<string, AgentMaturity>): VisibilityReport` — the new parameter is last and optional so the existing four-argument call sites keep compiling; omitting it makes every watched kind best-effort.
  - `function liveValidatedWatching(report: VisibilityReport): VisibilityEntry[]`
  - `function bestEffortWatching(report: VisibilityReport): VisibilityEntry[]`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/visibility.test.ts`, inside the existing `describe('buildVisibilityReport', ...)` block (before its closing `});`):

```typescript
  it('marks a watched kind live-validated when the maturity map says so', () => {
    const profile = profileWith({
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' }],
    });
    const report = buildVisibilityReport(
      profile,
      ['postgresql', 'kafka'],
      'env-fallback',
      undefined,
      new Map([['postgresql', 'live_validated'], ['kafka', 'simulator_only']]),
    );
    expect(report.watching.find((e) => e.label === 'postgresql')!.maturity).toBe('live_validated');
    expect(report.watching.find((e) => e.label === 'kafka')!.maturity).toBe('simulator_only');
  });

  it('defaults a kind with no maturity entry to best-effort', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['mongodb'], 'file', undefined, new Map());
    expect(report.watching.find((e) => e.label === 'mongodb')!.maturity).toBe('simulator_only');
  });

  it('defaults every watched kind to best-effort when no maturity map is given', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['postgresql', 'dns'], 'file');
    for (const entry of report.watching) {
      expect(entry.maturity).toBe('simulator_only');
    }
  });

  it('marks local-kind entries from the maturity map too', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(
      profile,
      ['dns', 'disk'],
      'none',
      undefined,
      new Map([['dns', 'live_validated'], ['disk', 'live_validated']]),
    );
    expect(report.watching.every((e) => e.maturity === 'live_validated')).toBe(true);
  });
```

And append a new top-level `describe` at the end of the file:

```typescript
describe('watching-bucket split helpers', () => {
  const report = {
    watching: [
      { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' as const },
      { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' as const },
      { label: 'mongodb', detail: 'detected automatically' },
    ],
    blocked: [],
    invisible: [],
  };

  it('counts only explicitly live-validated entries as validated', () => {
    expect(liveValidatedWatching(report).map((e) => e.label)).toEqual(['postgresql']);
  });

  it('treats a missing maturity as best-effort', () => {
    expect(bestEffortWatching(report).map((e) => e.label)).toEqual(['kafka', 'mongodb']);
  });
});
```

Extend the file's import at line 3 to:

```typescript
import { buildVisibilityReport, liveValidatedWatching, bestEffortWatching } from '../cli/visibility.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/visibility.test.ts`
Expected: FAIL at module load, before any case runs — the named import `liveValidatedWatching` does not exist yet (`SyntaxError: The requested module '../cli/visibility.js' does not provide an export named 'liveValidatedWatching'`), so the whole file fails collection.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/visibility.ts`, add the type import after the existing `StackProfile` import (line 10):

```typescript
import type { AgentMaturity } from '../framework/agent-maturity.js';
```

Replace the `VisibilityEntry` interface (lines 12-16) with:

```typescript
export interface VisibilityEntry {
  label: string;
  detail: string;
  hint?: string;
  /**
   * Coarse maturity of the agent watching this entry. Set on `watching`
   * entries only — `blocked` and `invisible` describe things no agent
   * watches. Anything other than 'live_validated' (including absent) is
   * rendered as best-effort.
   */
  maturity?: AgentMaturity;
}
```

Replace the signature (lines 33-38) with:

```typescript
export function buildVisibilityReport(
  profile: StackProfile,
  ranKinds: string[],
  configSource: string,
  extraBlocked?: VisibilityEntry[],
  maturityByKind?: Map<string, AgentMaturity>,
): VisibilityReport {
```

Inside the function, immediately after `const ran = new Set(ranKinds);` (line 44), add:

```typescript
  // An unregistered kind, or one whose agent declares anything short of
  // live_validated, is best-effort — the honest default.
  const maturityOf = (kind: string): AgentMaturity =>
    maturityByKind?.get(kind) ?? 'simulator_only';
```

Then set `maturity` on all three watching pushes (lines 48, 53, 58-61):

```typescript
  for (const kind of ranKinds) {
    if (LOCAL_KINDS.has(kind)) {
      watching.push({ label: kind, detail: 'local checks on this machine', maturity: maturityOf(kind) });
      continue;
    }
    const hint = presentHints.find((h) => h.inferredService === kind);
    if (hint) {
      watching.push({ label: kind, detail: `via ${hint.name}`, maturity: maturityOf(kind) });
      continue;
    }
    const derivedTarget = profile.derivedTargets.find((t) => t.kind === kind);
    const derivedNote = derivedTarget ? profile.derivedNotes[derivedTarget.name] : undefined;
    watching.push({
      label: kind,
      detail: derivedNote ?? (CONFIG_SOURCE_DETAIL[configSource] ?? 'configured'),
      maturity: maturityOf(kind),
    });
  }
```

Append the two helpers at the end of the file:

```typescript
/**
 * The watching entries CrisisMode can honestly claim as watched: only agents
 * validated against real infrastructure. Every coverage claim counts these
 * and nothing else.
 */
export function liveValidatedWatching(report: VisibilityReport): VisibilityEntry[] {
  return report.watching.filter((e) => e.maturity === 'live_validated');
}

/** The rest — anything not explicitly live-validated, including unknown kinds. */
export function bestEffortWatching(report: VisibilityReport): VisibilityEntry[] {
  return report.watching.filter((e) => e.maturity !== 'live_validated');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/visibility.test.ts`
Expected: PASS (all pre-existing cases plus the new ones).

- [ ] **Step 5: Commit**

```bash
git add src/cli/visibility.ts src/__tests__/visibility.test.ts
git commit -m "feat(visibility): carry agent maturity on watching entries"
```

---

### Task 3: Split the watching bucket in human output

**Files:**
- Modify: `src/cli/output.ts` (`printVisibility` at lines 570-589)
- Test: `src/__tests__/visibility-render.test.ts`

**Interfaces:**
- Consumes: `liveValidatedWatching`, `bestEffortWatching` from `./visibility.js` (Task 2); `BEST_EFFORT_GROUP_HINT` from `../framework/agent-maturity.js` (Task 1).
- Produces: `printVisibility` renders `watching` / `best-effort` / `found` / `invisible` line prefixes in human mode (each prefix is 17 characters wide, including its leading four-space indent, so the labels and the hint continuation line stay aligned), with one group hint line after the best-effort entries. Machine mode still emits the whole report via `jsonOut('visibility', { ...report })` including each entry's `maturity`; pipe and terse modes still print nothing.

- [ ] **Step 1: Write the failing test**

These cases are also the renderer-mapping enforcement the spec asks for: `AgentMaturity` has exactly two values, and the tests below pin the rendering of both plus the absent case, so a third value could not be added without a failing test here.

Replace the contents of `src/__tests__/visibility-render.test.ts` with:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printVisibility, setOutputOptions } from '../cli/output.js';
import type { VisibilityReport } from '../cli/visibility.js';

const report: VisibilityReport = {
  watching: [
    { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' },
    { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' },
  ],
  blocked: [{ label: 'AWS control plane', detail: 'AWS credentials detected — not supported yet', hint: 'Reachable AWS services are still checked.' }],
  invisible: [{ label: 'remote host internals', detail: 'cannot be seen from outside. Run a CrisisMode spoke on the host.' }],
};

describe('printVisibility', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    setOutputOptions({ mode: 'human', terse: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setOutputOptions({ mode: 'human', terse: false });
  });

  it('renders all buckets with details and hints', () => {
    printVisibility(report);
    const text = lines.join('\n');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('AWS credentials detected');
    expect(text).toContain('still checked');
    expect(text).toContain('spoke');
  });

  it('separates live-validated watching from best-effort watching', () => {
    printVisibility(report);
    const pgLine = lines.find((l) => l.includes('postgresql'))!;
    const kafkaLine = lines.find((l) => l.includes('kafka'))!;
    expect(pgLine).toContain('watching');
    expect(pgLine).not.toContain('best-effort');
    expect(kafkaLine).toContain('best-effort');
  });

  it('prints the honest hint once when anything is best-effort', () => {
    printVisibility(report);
    const hintLines = lines.filter((l) => l.includes('treat findings as leads, not conclusions'));
    expect(hintLines).toHaveLength(1);
  });

  it('prints no best-effort hint when every watched system is live-validated', () => {
    printVisibility({
      watching: [{ label: 'dns', detail: 'local checks on this machine', maturity: 'live_validated' }],
      blocked: [],
      invisible: [],
    });
    expect(lines.join('\n')).not.toContain('treat findings as leads');
  });

  it('treats an entry with no maturity as best-effort', () => {
    printVisibility({
      watching: [{ label: 'mongodb', detail: 'detected automatically' }],
      blocked: [],
      invisible: [],
    });
    expect(lines.find((l) => l.includes('mongodb'))).toContain('best-effort');
  });

  it('renders nothing in terse human mode', () => {
    setOutputOptions({ terse: true });
    printVisibility(report);
    expect(lines.join('\n')).not.toContain('DATABASE_URL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/visibility-render.test.ts`
Expected: FAIL — the kafka line reads `watching  kafka ...`, so `expect(kafkaLine).toContain('best-effort')` fails, as does the hint-count assertion.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/output.ts`, extend the existing visibility import (line 23) and add the maturity import next to it:

```typescript
import type { VisibilityReport } from './visibility.js';
import { liveValidatedWatching, bestEffortWatching } from './visibility.js';
import { BEST_EFFORT_GROUP_HINT } from '../framework/agent-maturity.js';
```

Replace `printVisibility` (lines 570-589) with:

```typescript
export function printVisibility(report: VisibilityReport): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('visibility', { ...report });
    return;
  }
  if (outputOptions.mode === 'pipe' || outputOptions.terse) return;

  console.log(chalk.bold('  What CrisisMode can see'));

  // Two watching buckets, never one number: only live-validated agents are
  // claimed as watched. Best-effort agents run the same checks but have
  // never been proven against real infrastructure.
  for (const e of liveValidatedWatching(report)) {
    console.log(chalk.green('    watching     ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
  }
  const bestEffort = bestEffortWatching(report);
  for (const e of bestEffort) {
    console.log(chalk.yellow('    best-effort  ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
  }
  if (bestEffort.length > 0) {
    console.log(chalk.dim(`                 ${BEST_EFFORT_GROUP_HINT}`));
  }

  for (const e of report.blocked) {
    console.log(chalk.yellow('    found        ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
    if (e.hint) console.log(chalk.dim(`                 ${e.hint}`));
  }
  for (const e of report.invisible) {
    console.log(chalk.dim(`    invisible    ${e.label} — ${e.detail}`));
  }
  console.log('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/visibility-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts src/__tests__/visibility-render.test.ts
git commit -m "feat(scan): split watching into live-validated and best-effort"
```

---

### Task 4: `bestEffort` on scan findings

**Files:**
- Modify: `src/cli/output.ts` (`ScanFinding` at lines 437-448, `printFindingGroup` at lines 548-563)
- Test: `src/__tests__/best-effort-findings.test.ts` (create)

**Interfaces:**
- Consumes: `BEST_EFFORT_FINDING_SUFFIX` from `../framework/agent-maturity.js` (Task 1).
- Produces: `ScanFinding` gains `bestEffort?: true`. Human output prints one dim suffix line per best-effort finding (suppressed by `--terse`, like explanations). Machine output carries the field through `printScanSummary`'s existing `jsonOut('scan', { ...result })`; pipe output is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/best-effort-findings.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, setOutputOptions, printScanSummary } from '../cli/output.js';
import type { ScanFinding, ScanResult } from '../cli/output.js';

function scanResultWith(findings: ScanFinding[]): ScanResult {
  return {
    score: 60,
    findings,
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 120,
  };
}

const validatedFinding: ScanFinding = {
  id: 'PG-001',
  service: 'postgresql (detected-postgresql)',
  status: 'unhealthy',
  summary: 'Replication lag at 45s',
  confidence: 0.9,
  escalationLevel: 2,
  signals: [{ status: 'critical', detail: 'lag 45s' }],
};

const bestEffortFinding: ScanFinding = {
  id: 'KAFKA-001',
  service: 'kafka (detected-kafka)',
  status: 'unhealthy',
  summary: 'Under-replicated partitions',
  confidence: 0.5,
  escalationLevel: 2,
  signals: [{ status: 'critical', detail: 'ISR shrunk' }],
  bestEffort: true,
};

describe('best-effort findings in human output', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    configure({ mode: 'human', noColor: true, json: false, verbose: false });
    setOutputOptions({ terse: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('caveats a best-effort finding', () => {
    printScanSummary(scanResultWith([bestEffortFinding]));
    expect(lines.join('\n')).toContain('treat this as a lead, not a conclusion');
  });

  it('does not caveat a live-validated finding', () => {
    printScanSummary(scanResultWith([validatedFinding]));
    expect(lines.join('\n')).not.toContain('treat this as a lead');
  });

  it('suppresses the caveat in terse mode', () => {
    setOutputOptions({ terse: true });
    printScanSummary(scanResultWith([bestEffortFinding]));
    expect(lines.join('\n')).not.toContain('treat this as a lead');
  });
});

describe('best-effort findings in machine output', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    configure({ json: true, noColor: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  it('emits bestEffort: true per finding', () => {
    printScanSummary(scanResultWith([validatedFinding, bestEffortFinding]));
    const parsed = JSON.parse(lines[0]!) as { findings: Array<{ id: string; bestEffort?: boolean }> };
    expect(parsed.findings.find((f) => f.id === 'KAFKA-001')!.bestEffort).toBe(true);
    expect(parsed.findings.find((f) => f.id === 'PG-001')!.bestEffort).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/best-effort-findings.test.ts`
Expected: FAIL — TypeScript rejects `bestEffort: true` on `ScanFinding` ("Object literal may only specify known properties"), and the human-output caveat assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/output.ts`, extend the maturity import added in Task 3:

```typescript
import { BEST_EFFORT_GROUP_HINT, BEST_EFFORT_FINDING_SUFFIX } from '../framework/agent-maturity.js';
```

Add the field to `ScanFinding` (after `learnMoreUrl?: string;` at line 447):

```typescript
  /**
   * True when the agent behind this finding has never been validated against
   * real infrastructure. The finding is still a real probe result — it counts
   * in the headline and score — but it is a lead, not a conclusion.
   */
  bestEffort?: true;
```

Extend `printFindingGroup` (lines 548-563) so the caveat prints after the explanation block:

```typescript
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
    if (!outputOptions.terse && f.bestEffort) {
      console.log(chalk.dim(`      ${BEST_EFFORT_FINDING_SUFFIX}`));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/best-effort-findings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts src/__tests__/best-effort-findings.test.ts
git commit -m "feat(scan): caveat findings from unvalidated agents"
```

---

### Task 5: Wire maturity through `runScan`

**Files:**
- Modify: `src/cli/commands/scan.ts` (imports at lines 29-42, agent-finding loop at lines 356-359, plugin-finding loop at lines 420-423, visibility call at line 446)
- Test: `src/__tests__/best-effort-findings.test.ts` (append a `describe` block)
- Test: `src/__tests__/scan-run-best-effort.test.ts` (create — the end-to-end `runScan` assertion behind acceptance criterion 1)

**Interfaces:**
- Consumes: `AgentRegistry.maturityByKind()` (Task 1); `buildVisibilityReport(..., maturityByKind)` (Task 2); `ScanFinding.bestEffort` (Task 4).
- Produces: `export function markBestEffort<T extends { bestEffort?: true }>(finding: T, kind: string, maturityByKind: Map<string, AgentMaturity>): T` — returns the finding unchanged for live-validated kinds, otherwise a copy with `bestEffort: true`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/best-effort-findings.test.ts`:

```typescript
describe('markBestEffort', () => {
  it('leaves a live-validated kind untouched', async () => {
    const { markBestEffort } = await import('../cli/commands/scan.js');
    const marked = markBestEffort(validatedFinding, 'postgresql', new Map([['postgresql', 'live_validated']]));
    expect(marked.bestEffort).toBeUndefined();
    expect(marked).toBe(validatedFinding);
  });

  it('marks a simulator-only kind', async () => {
    const { markBestEffort } = await import('../cli/commands/scan.js');
    const marked = markBestEffort(validatedFinding, 'kafka', new Map([['kafka', 'simulator_only']]));
    expect(marked.bestEffort).toBe(true);
  });

  it('marks an unregistered kind — external check plugins included', async () => {
    const { markBestEffort } = await import('../cli/commands/scan.js');
    expect(markBestEffort(validatedFinding, 'plugin', new Map()).bestEffort).toBe(true);
  });

  it('does not mutate the finding it was given', async () => {
    const { markBestEffort } = await import('../cli/commands/scan.js');
    markBestEffort(validatedFinding, 'kafka', new Map());
    expect(validatedFinding.bestEffort).toBeUndefined();
  });
});
```

No module mocks are needed for these cases. `src/cli/commands/scan.ts` reaches the Anthropic SDK only through `callClaude`, which loads it with a dynamic `await import('@anthropic-ai/sdk')` inside the function body (`src/framework/ai-client.ts:75`) — nothing in the graph imports it statically, which is why `src/__tests__/scan-evidence.test.ts` already imports `scan.js` unmocked.

Then create `src/__tests__/scan-run-best-effort.test.ts`, which drives the real `runScan` so acceptance criterion 1 rests on executed code rather than on reading the diff:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Autodiscovery reads the real filesystem and environment, and check-plugin
// discovery would find AND EXECUTE this repo's own ./checks/ plugins. Both
// are stubbed so the scan under test is exactly one kafka target. The stub
// objects are built inside the factories because vi.mock is hoisted above
// module-level consts.
vi.mock('../cli/autodiscovery.js', () => ({
  discoverStack: vi.fn(async () => ({
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
  })),
  printOnboardingMessage: vi.fn(),
}));
vi.mock('../framework/check-discovery.js', () => ({
  discoverCheckPlugins: vi.fn(async () => ({ plugins: [], warnings: [] })),
}));

import { runScan } from '../cli/commands/scan.js';

const CONFIG_YAML = [
  'apiVersion: crisismode/v1',
  'kind: SiteConfig',
  'metadata:',
  '  name: test-site',
  '  environment: development',
  'targets:',
  '  - name: test-kafka',
  '    kind: kafka',
  '    primary:',
  '      host: simulator',
  '      port: 9092',
  '',
].join('\n');

describe('runScan — end-to-end best-effort marking', () => {
  let tmpDir: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crisismode-scan-'));
    configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, CONFIG_YAML, 'utf-8');
    // Keep the plain-language summary on its offline fallback path.
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('marks a simulator-only agent findings best-effort and its visibility entry simulator_only', async () => {
    // kafka registers through createSimulatorRegistration, so this whole scan
    // runs in memory — no broker, no network. `category` narrows the run to
    // kafka, dropping the dns/disk local targets runScan always injects.
    const result = await runScan({ configPath, category: ['kafka'] });

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.service).toContain('kafka');
    expect(finding.bestEffort).toBe(true);

    const watching = result.visibility!.watching.find((e) => e.label === 'kafka');
    expect(watching).toBeDefined();
    expect(watching!.maturity).toBe('simulator_only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/best-effort-findings.test.ts src/__tests__/scan-run-best-effort.test.ts`
Expected: FAIL — `markBestEffort is not a function`, and `expected undefined to be true` for the end-to-end `finding.bestEffort`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/scan.ts`, add to the imports (next to the visibility import at line 29):

```typescript
import type { AgentMaturity } from '../../framework/agent-maturity.js';
```

Add the helper right after `watchedKinds` (which ends at line 489):

```typescript
/**
 * Flag a finding whose agent has never been validated against real
 * infrastructure. A kind with no registered agent — external check plugins,
 * unknown kinds — is best-effort too: the honest default is the pessimistic
 * one. This changes no count and no score; it only labels the claim.
 */
export function markBestEffort<T extends { bestEffort?: true }>(
  finding: T,
  kind: string,
  maturityByKind: Map<string, AgentMaturity>,
): T {
  if (maturityByKind.get(kind) === 'live_validated') return finding;
  return { ...finding, bestEffort: true };
}
```

In `runScan`, immediately after `const registry = new AgentRegistry({ ...config, targets });` (line 339):

```typescript
  const maturityByKind = registry.maturityByKind();
```

Replace the agent-finding loop (lines 357-359):

```typescript
  for (const { finding, kind } of agentResults) {
    findings.push(markBestEffort(
      enrichScanFinding({ id: findingId(kind, findingCounter++), ...finding }, explanationCtx),
      kind,
      maturityByKind,
    ));
  }
```

Replace the plugin-finding loop (lines 421-423):

```typescript
    for (const result of pluginResults) {
      findings.push(markBestEffort(
        enrichScanFinding({ id: findingId('plugin', pluginFindingCounter++), ...result }, explanationCtx),
        'plugin',
        maturityByKind,
      ));
    }
```

Replace the visibility call (line 446):

```typescript
  result.visibility = buildVisibilityReport(
    stackProfile,
    ranKinds,
    configSource,
    iamBlockedEntries(findings),
    maturityByKind,
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/best-effort-findings.test.ts src/__tests__/scan-run-best-effort.test.ts src/__tests__/scan.test.ts src/__tests__/scan-evidence.test.ts src/__tests__/scan-aws-visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/scan.ts src/__tests__/best-effort-findings.test.ts src/__tests__/scan-run-best-effort.test.ts
git commit -m "feat(scan): thread agent maturity into findings and visibility"
```

---

### Task 6: Honest coverage in the plain-language summary

**Files:**
- Modify: `src/cli/ai-summary.ts` (fallback calls at lines 47/52/59, `callAi` visibility text at lines 96-99, `buildFallbackSummary` and its doc comment at lines 115-139)
- Test: `src/__tests__/ai-summary.test.ts`

**Interfaces:**
- Consumes: `liveValidatedWatching`, `bestEffortWatching`, `VisibilityReport` from `./visibility.js` (Task 2).
- Produces: `buildFallbackSummary(summary: IncidentSummary, visibility?: VisibilityReport): PlainEnglishSummary` — the second parameter is optional, so existing one-argument calls keep working. `generatePlainEnglishSummary`'s signature is unchanged; it now forwards `visibility` to every fallback path.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/ai-summary.test.ts`:

```typescript
describe('AI summary — coverage honesty', () => {
  // Same save/restore convention as the other describes in this file: the
  // env var is process-global and vitest runs files in one process.
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  const mixedVisibility: VisibilityReport = {
    watching: [
      { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' },
      { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' },
      { label: 'redis', detail: 'via REDIS_URL', maturity: 'simulator_only' },
    ],
    blocked: [],
    invisible: [],
  };

  it('counts only live-validated systems in the coverage sentence', async () => {
    const { buildFallbackSummary } = await import('../cli/ai-summary.js');
    const result = buildFallbackSummary(makeIncidentSummary(), mixedVisibility);
    expect(result.text).toContain('1 of 3 watched systems have live-validated checks');
    expect(result.text).toContain('kafka, redis');
    expect(result.text).toContain('best-effort');
  });

  it('omits the coverage sentence when nothing is best-effort', async () => {
    const { buildFallbackSummary } = await import('../cli/ai-summary.js');
    const result = buildFallbackSummary(makeIncidentSummary(), {
      watching: [{ label: 'dns', detail: 'local checks on this machine', maturity: 'live_validated' }],
      blocked: [],
      invisible: [],
    });
    expect(result.text).not.toContain('best-effort');
    expect(result.text).toContain('Scanned 3 services.');
  });

  it('keeps working with no visibility report at all', async () => {
    const { buildFallbackSummary } = await import('../cli/ai-summary.js');
    expect(buildFallbackSummary(makeIncidentSummary()).text).toContain('Scanned 3 services.');
  });

  it('passes the visibility report through to the fallback when there is no API key', async () => {
    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    const result = await generatePlainEnglishSummary(makeIncidentSummary(), [], mixedVisibility);
    expect(result.source).toBe('fallback');
    expect(result.text).toContain('best-effort');
  });
});
```

Add the type import at the top of the file, after the `PlainEnglishSummary` import (line 8):

```typescript
import type { VisibilityReport } from '../cli/visibility.js';
```

Also add one case inside the existing `describe('AI summary — AI path with mocked SDK', ...)` block:

```typescript
  it('tells the model which systems are best-effort', async () => {
    const { generatePlainEnglishSummary } = await import('../cli/ai-summary.js');
    await generatePlainEnglishSummary(makeIncidentSummary(), [], {
      watching: [
        { label: 'postgresql', detail: 'via DATABASE_URL', maturity: 'live_validated' },
        { label: 'kafka', detail: 'detected automatically', maturity: 'simulator_only' },
      ],
      blocked: [],
      invisible: [],
    });

    const [callArgs] = mockCreate.mock.calls[0]!;
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).toContain('live-validated checks for postgresql');
    expect(userMessage).toContain('Best-effort checks');
    expect(userMessage).toContain('kafka');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/ai-summary.test.ts`
Expected: FAIL — `buildFallbackSummary` takes one argument (TS error on the second), and the AI-path message contains `Visibility: watching postgresql, kafka` rather than the split wording.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/ai-summary.ts`, extend the visibility import (line 21):

```typescript
import type { VisibilityReport } from './visibility.js';
import { liveValidatedWatching, bestEffortWatching } from './visibility.js';
```

Forward `visibility` in all three fallback returns inside `generatePlainEnglishSummary` (lines 47, 52, 59):

```typescript
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildFallbackSummary(summary, visibility);
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return buildFallbackSummary(summary, visibility);
  }

  try {
    return await callAi(summary, recentChanges, apiKey, visibility);
  } catch (err) {
    console.error('AI summary failed:', err instanceof Error ? err.message : err);
    return buildFallbackSummary(summary, visibility);
  }
```

Replace the `visibilityText` block in `callAi` (lines 96-99):

```typescript
  // The model is told which systems are actually validated, so it cannot
  // describe best-effort checks as if they were proven coverage.
  const visibilityText = visibility
    ? `\nVisibility: live-validated checks for ${liveValidatedWatching(visibility).map((e) => e.label).join(', ') || 'nothing'}. ` +
      `Best-effort checks (never validated against a real system — describe these findings as leads, not conclusions): ` +
      `${bestEffortWatching(visibility).map((e) => e.label).join(', ') || 'none'}. ` +
      `Known gaps: ${visibility.blocked.map((e) => e.detail).join('; ') || 'none'}.`
    : '';
```

Replace `buildFallbackSummary` (lines 115-139):

```typescript
/**
 * Build a fallback summary from structured data without AI.
 *
 * The service count is a finding count (every probe that ran), not a coverage
 * claim. The coverage claim is a separate sentence that counts only
 * live-validated systems — best-effort systems are named, never folded in.
 */
export function buildFallbackSummary(
  summary: IncidentSummary,
  visibility?: VisibilityReport,
): PlainEnglishSummary {
  const total = summary.critical.length + summary.warning.length + summary.healthy.length;
  const parts: string[] = [];

  parts.push(`Scanned ${total} services.`);

  const coverage = visibility ? coverageSentence(visibility) : null;
  if (coverage) parts.push(coverage);

  if (summary.critical.length > 0) {
    const names = summary.critical.map((f) => f.service).join(', ');
    parts.push(`${summary.critical.length} need attention: ${names}.`);
  } else if (summary.warning.length > 0) {
    const names = summary.warning.map((f) => f.service).join(', ');
    parts.push(`${summary.warning.length} recovering: ${names}.`);
  } else {
    parts.push('All services are healthy.');
  }

  if (summary.nextSteps.length > 0) {
    parts.push(`Next: ${summary.nextSteps[0]}`);
  }

  return { text: parts.join(' '), source: 'fallback' };
}

/**
 * The coverage claim. Returns null when every watched system is
 * live-validated — the plain count is unambiguous then, and an extra
 * sentence would just be noise.
 */
function coverageSentence(visibility: VisibilityReport): string | null {
  const bestEffort = bestEffortWatching(visibility);
  if (bestEffort.length === 0) return null;
  const live = liveValidatedWatching(visibility);
  const labels = bestEffort.map((e) => e.label).join(', ');
  const verb = bestEffort.length === 1 ? 'is' : 'are';
  return `${live.length} of ${visibility.watching.length} watched systems have live-validated checks; ` +
    `${labels} ${verb} best-effort, so treat those findings as leads.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/ai-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ai-summary.ts src/__tests__/ai-summary.test.ts
git commit -m "feat(scan): count only live-validated systems in coverage claims"
```

---

### Task 7: Maturity in `agent list` and `agent info`

**Files:**
- Modify: `src/cli/commands/agent.ts` (JSON entries at lines 42-59, table at lines 66-104, `runInfo` builtin JSON at lines 126-138, `runInfo` plugin JSON at lines 148-155, `printBuiltinInfo` at lines 167-179, `printPluginInfo` at lines 181-198)
- Test: `src/__tests__/agent-command-maturity.test.ts` (create)

**Interfaces:**
- Consumes: `agentMaturity`, `bestEffortHint` from `../../framework/agent-maturity.js` (Task 1); `builtinAgents` (each `{ kind, name, manifest }`); `discoverAgentPlugins(): Promise<{ plugins: DiscoveredAgentPlugin[]; warnings: Array<{ path: string; reason: string }> }>`.
- Produces: `agent list --json` entries gain `maturity: AgentMaturity`; the human table gains a `Maturity` column showing `live-validated` or `best-effort`. `agent info --json` gains `maturity` in **both** the builtin and the plugin branch; both human forms print a `Maturity:` line plus, for best-effort agents, a `Note:` line with `bestEffortHint(...)`. `AgentPluginManifest` (`src/framework/registry/types.ts`) declares no maturity field at all, so every plugin agent is reported `simulator_only`/`best-effort` — an external agent nobody has validated is exactly what the best-effort default is for.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/agent-command-maturity.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the test hermetic: no filesystem scan for plugin agents. One stub
// plugin so the plugin branches of list/info are exercised too. The literal
// is inline because vi.mock factories are hoisted above module-level consts.
vi.mock('../framework/registry/local.js', () => ({
  discoverAgentPlugins: vi.fn(async () => ({
    plugins: [
      {
        pluginDir: '/tmp/crisismode-agents/acme-mysql',
        source: 'project',
        manifest: {
          name: 'acme-mysql-recovery',
          version: '0.1.0',
          description: 'Community MySQL recovery agent',
          kind: 'agent',
          targetKinds: ['mysql'],
          riskProfile: { maxRiskLevel: 'elevated', dataLossPossible: false },
          crisismode: { minVersion: '0.1.0' },
        },
      },
    ],
    warnings: [],
  })),
}));

import { runAgent } from '../cli/commands/agent.js';

describe('crisismode agent list — maturity', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports maturity per agent in JSON mode', async () => {
    await runAgent({ subcommand: 'list', args: [], json: true });
    const entries = JSON.parse(lines.join('\n')) as Array<{ name: string; maturity: string }>;
    expect(entries.find((e) => e.name === 'postgresql-replication-recovery')!.maturity).toBe('live_validated');
    expect(entries.find((e) => e.name === 'kafka-recovery')!.maturity).toBe('simulator_only');
  });

  it('reports plugin agents as best-effort — nobody has validated them', async () => {
    await runAgent({ subcommand: 'list', args: [], json: true });
    const entries = JSON.parse(lines.join('\n')) as Array<{ name: string; maturity: string }>;
    expect(entries.find((e) => e.name === 'acme-mysql-recovery')!.maturity).toBe('simulator_only');
  });

  it('shows a maturity column in the human table', async () => {
    await runAgent({ subcommand: 'list', args: [] });
    const text = lines.join('\n');
    expect(text).toContain('Maturity');
    expect(lines.find((l) => l.includes('kafka-recovery'))).toContain('best-effort');
    expect(lines.find((l) => l.includes('postgresql-replication-recovery'))).toContain('live-validated');
    expect(lines.find((l) => l.includes('acme-mysql-recovery'))).toContain('best-effort');
  });
});

describe('crisismode agent info — maturity', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints the honest hint for a best-effort agent', async () => {
    await runAgent({ subcommand: 'info', args: ['kafka-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('best-effort');
    expect(text).toContain('never been validated against a real kafka');
  });

  it('prints no hint for a live-validated agent', async () => {
    await runAgent({ subcommand: 'info', args: ['postgresql-replication-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('live-validated');
    expect(text).not.toContain('never been validated');
  });

  it('includes maturity in JSON mode', async () => {
    await runAgent({ subcommand: 'info', args: ['kafka-recovery'], json: true });
    const parsed = JSON.parse(lines.join('\n')) as { maturity: string };
    expect(parsed.maturity).toBe('simulator_only');
  });

  it('shows maturity and the hint for a plugin agent too', async () => {
    await runAgent({ subcommand: 'info', args: ['acme-mysql-recovery'] });
    const text = lines.join('\n');
    expect(text).toContain('best-effort');
    expect(text).toContain('never been validated against a real mysql');
  });

  it('includes maturity in plugin JSON mode', async () => {
    await runAgent({ subcommand: 'info', args: ['acme-mysql-recovery'], json: true });
    const parsed = JSON.parse(lines.join('\n')) as { maturity: string; type: string };
    expect(parsed.type).toBe('plugin');
    expect(parsed.maturity).toBe('simulator_only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/agent-command-maturity.test.ts`
Expected: FAIL — `expected undefined to be 'live_validated'` (no `maturity` key in the JSON entries).

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/agent.ts`, add to the imports (after line 14):

```typescript
import { agentMaturity, bestEffortHint } from '../../framework/agent-maturity.js';
import type { AgentMaturity } from '../../framework/agent-maturity.js';
```

Add a helper next to `pad` at the bottom of the file:

```typescript
/** Human label for the roster. Plugin manifests carry no maturity — best-effort. */
function maturityLabel(maturity: AgentMaturity): string {
  return maturity === 'live_validated' ? 'live-validated' : 'best-effort';
}
```

In `runList`, add `maturity` to both JSON shapes (lines 43-58):

```typescript
    const entries = [
      ...builtinAgents.map((a) => ({
        name: a.name,
        type: 'builtin' as const,
        targetSystems: a.manifest.spec.targetSystems.map((t) => t.technology),
        riskLevel: a.manifest.spec.riskProfile.maxRiskLevel,
        maturity: agentMaturity(a.manifest),
        description: a.manifest.metadata.description,
        source: 'builtin',
      })),
      ...plugins.map((p) => ({
        name: p.manifest.name,
        type: 'plugin' as const,
        targetSystems: p.manifest.targetKinds,
        riskLevel: p.manifest.riskProfile?.maxRiskLevel ?? 'unknown',
        // Plugin manifests declare no maturity — best-effort by default.
        maturity: 'simulator_only' as AgentMaturity,
        description: p.manifest.description,
        source: p.source,
      })),
    ];
```

Add the column to the table (replacing lines 67-103):

```typescript
  const nameW = 38;
  const typeW = 10;
  const targetW = 24;
  const riskW = 10;
  const maturityW = 16;
  const sourceW = 14;
  console.log(
    pad('Name', nameW) +
      pad('Type', typeW) +
      pad('Targets', targetW) +
      pad('Risk', riskW) +
      pad('Maturity', maturityW) +
      pad('Source', sourceW),
  );
  console.log('-'.repeat(nameW + typeW + targetW + riskW + maturityW + sourceW));

  // Built-in agents
  for (const agent of builtinAgents) {
    const targets = agent.manifest.spec.targetSystems.map((t) => t.technology).join(', ');
    console.log(
      pad(agent.name, nameW) +
        pad('builtin', typeW) +
        pad(targets, targetW) +
        pad(agent.manifest.spec.riskProfile.maxRiskLevel, riskW) +
        pad(maturityLabel(agentMaturity(agent.manifest)), maturityW) +
        pad('builtin', sourceW),
    );
  }

  // Plugin agents
  for (const plugin of plugins) {
    const targets = plugin.manifest.targetKinds.join(', ');
    console.log(
      pad(plugin.manifest.name, nameW) +
        pad('plugin', typeW) +
        pad(targets, targetW) +
        pad(plugin.manifest.riskProfile?.maxRiskLevel ?? '-', riskW) +
        pad(maturityLabel('simulator_only'), maturityW) +
        pad(plugin.source, sourceW),
    );
  }
```

In `runInfo`'s builtin JSON branch, add `maturity` after `riskProfile` (line 134):

```typescript
        riskProfile: builtin.manifest.spec.riskProfile,
        maturity: agentMaturity(builtin.manifest),
```

In `printBuiltinInfo`, add the maturity lines after the `Risk level:` line (line 175):

```typescript
  const maturity = agentMaturity(m);
  console.log(`Maturity:      ${maturityLabel(maturity)}`);
  if (maturity !== 'live_validated') {
    console.log(`Note:          ${bestEffortHint(agent.kind)}`);
  }
```

In `runInfo`'s plugin JSON branch (lines 149-154), add `maturity` to the spread object:

```typescript
      console.log(JSON.stringify({
        ...plugin.manifest,
        type: 'plugin',
        // AgentPluginManifest declares no maturity — an unvalidated external
        // agent is exactly what the best-effort default exists for.
        maturity: 'simulator_only' as AgentMaturity,
        pluginDir: plugin.pluginDir,
        source: plugin.source,
      }, null, 2));
```

In `printPluginInfo`, add the same two lines after the `Data loss:` line (line 190):

```typescript
  console.log(`Maturity:      ${maturityLabel('simulator_only')}`);
  console.log(`Note:          ${bestEffortHint(m.targetKinds[0] ?? m.name)}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/agent-command-maturity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/agent.ts src/__tests__/agent-command-maturity.test.ts
git commit -m "feat(agent): show validation maturity in list and info"
```

---

### Task 8: Scope correlation clusters to the agents the rule matched

**This task IS spec §6's "confidence scoping" fix** — that is the whole of it, and no arithmetic changes. The spec says "rule confidence boosts apply only to the agents matched by the rule, not globally to the incident"; the existing formula is already scoped to kind-matched agents, so what leaks globally is *cluster membership*: an agent whose kind appears in `rule.agentKinds` but that reported none of the rule's signal types is still named in the cluster and dropped from `uncorrelated`. Scoping membership fixes exactly that. The denominator in `0.3 + (signalMatches / matchingAgents.length) * 0.3` deliberately stays the full kind-matched set — narrowing it to the surviving members would *raise* every scoped cluster's confidence, and this PR never inflates a claim.

**Files:**
- Modify: `src/framework/root-cause-synthesis.ts` (cluster-membership block at lines 301-330, `clusteredAgents` bookkeeping at line 364, `uncorrelated` at lines 382-384)
- Test: `src/__tests__/root-cause-synthesis.test.ts`

**Interfaces:**
- Consumes: existing `synthesizeByRules(evidence: AgentEvidence[]): SynthesisResult`.
- Produces: no signature change. `CorrelationCluster.agents` now lists only the evidence items that passed the rule's per-agent signal check; agents that merely share a *kind* with the rule stay in `uncorrelated`. The confidence arithmetic (`0.3 + signalMatches / matchingAgents.length * 0.3` plus boosts) is deliberately unchanged — narrowing the denominator would inflate confidence, and this PR never inflates.

- [ ] **Step 1: Write the failing test**

Add inside `describe('synthesizeByRules', ...)` in `src/__tests__/root-cause-synthesis.test.ts` (e.g. after the `'leaves unrelated agents uncorrelated'` case):

```typescript
    it('names only the agents whose signals matched the rule', () => {
      // redis is in database-backpressure's agentKinds, but its only signal
      // (deploy_change) is not one of the rule's signal types. Claiming redis
      // as part of the pattern — and dropping it from `uncorrelated` — is a
      // claim the evidence does not support.
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'latency', source: 'pg', detail: 'slow queries', severity: 'warning' }],
        }),
        makeEvidence('kafka', {
          signals: [{ type: 'timeout', source: 'kafka', detail: 'producer timeouts', severity: 'critical' }],
        }),
        makeEvidence('redis', {
          signals: [{ type: 'deploy_change', source: 'ci', detail: 'sidecar redeployed', severity: 'warning' }],
        }),
      ]);

      const cluster = result.clusters.find((c) => c.reasoning.includes('database-backpressure'));
      expect(cluster).toBeDefined();
      expect(cluster!.agents).toEqual(['postgresql', 'kafka']);
      expect(result.uncorrelated).toContain('redis');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts -t 'names only the agents whose signals matched'`
Expected: FAIL — `expected [ 'postgresql', 'kafka', 'redis' ] to deeply equal [ 'postgresql', 'kafka' ]`.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/root-cause-synthesis.ts`, replace the membership block (lines 301-330) so it starts from the agents that passed the signal check:

```typescript
    // Cluster membership is the agents the rule actually matched. An agent
    // whose kind merely appears in `rule.agentKinds`, but which reported none
    // of the rule's signal types, is not evidence for this pattern: naming it
    // in the cluster (and removing it from `uncorrelated`) asserts a link the
    // evidence does not support. The confidence arithmetic above is unchanged
    // — its denominator stays the full kind-matched set, so scoping the claim
    // never inflates the number attached to it.
    let clusterAgents = passedSignalAgents;

    if (rule.requireSharedEntityId) {
      // Pair only agents that themselves passed the per-agent signal check —
      // an evidence item that didn't match the rule's signal types shouldn't
      // be able to veto (or corroborate) a pairing between two agents that
      // did. Require the shared id to span at least two DISTINCT agent
      // kinds: two evidence items of the same kind sharing an id says
      // nothing about cross-system correlation, and a third same-kind
      // target with a different id must not be able to block the pairing
      // between the other two (the "third-target veto" bug).
      const idToAgents = new Map<string, AgentEvidence[]>();
      for (const agent of passedSignalAgents) {
        for (const id of agent.entityIds ?? []) {
          const group = idToAgents.get(id) ?? [];
          group.push(agent);
          idToAgents.set(id, group);
        }
      }
      const sharingAgents = new Set<AgentEvidence>();
      for (const group of idToAgents.values()) {
        if (new Set(group.map((a) => a.agentKind)).size >= 2) {
          for (const a of group) sharingAgents.add(a);
        }
      }
      if (sharingAgents.size === 0) continue;
      clusterAgents = passedSignalAgents.filter((a) => sharingAgents.has(a));
    }
```

Everything below (`const agentNames = clusterAgents.map(...)` onward) is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts src/__tests__/scan-evidence.test.ts`
Expected: PASS — including the pre-existing `iac-out-of-band-change` cases that assert `cluster.agents` equals `['iac-drift', 'aws-rds']`.

- [ ] **Step 5: Commit**

```bash
git add src/framework/root-cause-synthesis.ts src/__tests__/root-cause-synthesis.test.ts
git commit -m "fix(synthesis): scope clusters to the agents a rule actually matched"
```

---

### Task 9: One agent, one cluster — with an advisory exemption

**Files:**
- Modify: `src/framework/root-cause-synthesis.ts` (cluster construction at lines 332-365, dead `bestClusterPerAgent` block at lines 367-377, sort at line 380, `uncorrelated` at lines 382-384)
- Test: `src/__tests__/root-cause-synthesis.test.ts`

**Interfaces:**
- Consumes: the scoping change from Task 8.
- Produces: no signature change. `synthesizeByRules` now returns at most one **specific** cluster per agent kind: specific clusters are considered strongest-first, an agent already claimed by a stronger one is dropped from weaker ones, a cluster left with fewer than two agents is dropped entirely, and its `rootCause` and `investigationOrder` are re-rendered for the agents that remain. `observer-environment` is an **advisory overlay**: it is exempt from the contest, claims no agents, and rides along behind the specific clusters. Final ids are renumbered `cluster-0`, `cluster-1`, … over the combined list, and `uncorrelated` is derived from all surviving clusters.

**Why observer-environment is exempt.** It declares no `sharedPatterns`, so its 0.3 boost applies on signal agreement alone and it scores 0.9 on any two agents that report `connection` or `timeout` — above `network-partition` (0.6 without pattern evidence), `component-failure-cascade` (0.85) and `database-backpressure` (0.85). In a winner-take-all contest it would silence nearly every specific rule. It also answers a different question: "is the problem this machine?" rather than "which system broke?" Both answers are useful at once, and PR 2's deterministic scan-level triage takes presentation precedence over this rule anyway.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block in `src/__tests__/root-cause-synthesis.test.ts`, after the `iac-out-of-band-change` block:

```typescript
  describe('one agent, one cluster', () => {
    it('fires exactly one RDS rule on a mixed platform/reachability incident', () => {
      // aws-rds reports BOTH storage exhaustion and a connection-path
      // problem, so rds-platform-degraded and rds-reachability both match.
      // Reporting both as separate "root causes" for the same two agents
      // double-counts one incident.
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' }],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources on port 5432', severity: 'critical' },
          ],
        }),
      ]);

      const rdsClusters = result.clusters.filter((c) => c.agents.includes('aws-rds'));
      expect(rdsClusters).toHaveLength(1);
      // The stronger rule wins: rds-platform-degraded boosts 0.3 vs 0.25.
      expect(rdsClusters[0]!.reasoning).toContain('rds-platform-degraded');
      expect(result.clusters.filter((c) => c.reasoning.includes('rds-reachability'))).toHaveLength(0);
    });

    it('numbers surviving clusters contiguously', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' }],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources', severity: 'critical' },
          ],
        }),
      ]);
      expect(result.clusters.map((c) => c.id)).toEqual(
        result.clusters.map((_, i) => `cluster-${i}`),
      );
    });

    it('keeps the observer-environment advisory alongside the winning specific cluster', () => {
      // Both agents report connection + timeout AND flapping, so
      // network-partition scores 0.9 (0.3 base + 0.3 signal agreement + 0.3
      // pattern boost) and wins the specific contest over
      // component-failure-cascade (0.85). observer-environment also scores
      // 0.9, but it is an advisory overlay: it must survive without
      // suppressing the specific answer, and without claiming its agents.
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ]);

      const networkPartition = result.clusters.find((c) => c.reasoning.includes('network-partition'));
      const advisory = result.clusters.find((c) => c.reasoning.includes('observer-environment'));
      expect(networkPartition).toBeDefined();
      expect(advisory).toBeDefined();
      // The specific answer leads; the advisory rides along behind it.
      expect(result.clusters.indexOf(networkPartition!)).toBeLessThan(result.clusters.indexOf(advisory!));
      // The advisory claimed nothing, so the weaker specific rule still lost.
      expect(result.clusters.filter((c) => c.reasoning.includes('component-failure-cascade'))).toHaveLength(0);
    });

    it('claims each agent for at most one specific cluster', () => {
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ]);

      const seen = new Set<string>();
      for (const cluster of result.clusters) {
        // Advisory overlays deliberately re-name agents a specific cluster
        // already claimed — the uniqueness rule applies to specific rules.
        if (cluster.reasoning.includes('observer-environment')) continue;
        for (const agent of cluster.agents) {
          expect(seen.has(agent), `agent '${agent}' appears in more than one specific cluster`).toBe(false);
          seen.add(agent);
        }
      }
      // Rendered text must match the agents each cluster actually kept.
      for (const cluster of result.clusters) {
        for (const agent of cluster.investigationOrder) {
          expect(cluster.agents).toContain(agent);
        }
      }
    });
  });
```

**Also fix one pre-existing case in this file.** `'correlates network-partition across distributed systems'` (currently at line 111) asserts only that some cluster's `rootCause` contains `'network'` — which `observer-environment`'s template ("Local DNS/network problems on this host…") satisfies, so the case passes today without the `network-partition` rule ever winning. Its fixture supplies no `flapping` pattern, and `network-partition` declares `sharedPatterns: ['flapping']`, so the rule only reaches 0.6 and loses to `component-failure-cascade` at 0.85. Give it the pattern evidence the rule actually asks for and assert the rule by name:

```typescript
    it('correlates network-partition across distributed systems', () => {
      // network-partition declares sharedPatterns: ['flapping'], so its
      // confidence boost needs pattern evidence from two agents. Without it
      // the rule scores 0.6 and this incident is claimed by
      // component-failure-cascade instead — assert the rule by name so the
      // test cannot pass on another rule's similarly-worded template.
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const evidence: AgentEvidence[] = [
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ];

      const result = synthesizeByRules(evidence);
      const networkCluster = result.clusters.find((c) => c.reasoning.includes('network-partition'));
      expect(networkCluster).toBeDefined();
      expect(networkCluster!.agents).toContain('etcd');
      expect(networkCluster!.agents).toContain('kafka');
    });
```

No other pre-existing case needs changing. In particular `'correlates database-backpressure when DB and cache share latency signals'` keeps its fixture: `observer-environment` matches it at 0.9, but as an advisory it claims nothing, so `database-backpressure` (0.85) still survives.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts`
Expected: FAIL — `expected length 2 to be 1` for the mixed RDS incident (both RDS rules currently fire), and the rewritten `network-partition` case fails too, because today `component-failure-cascade`'s reasoning is what that fixture produces alongside it.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/root-cause-synthesis.ts`, inside `synthesizeByRules`:

Replace the declarations at lines 242-244:

```typescript
  // Clusters are built alongside the rule that produced them so the de-dup
  // pass below can re-render a cluster's text if it loses agents.
  const built: Array<{ cluster: CorrelationCluster; rule: CorrelationRule }> = [];
```

(Delete `const clusters: CorrelationCluster[] = []`, `const clusteredAgents = new Set<string>()`, and `let clusterIdx = 0` — the id is assigned after de-dup.)

Replace the `clusters.push({...})` call and the `clusteredAgents` loop (lines 354-364) with:

```typescript
    built.push({
      cluster: {
        id: 'pending',
        rootCause,
        confidence,
        agents: agentNames,
        reasoning: `Rule "${rule.name}": ${signalMatches} agents share signal types [${rule.sharedSignalTypes.join(', ')}]${patternMatches > 0 ? `, ${patternMatches} share patterns` : ''}${temporal ? ', temporally correlated' : ''}`,
        temporalCorrelation: temporal,
        investigationOrder,
      },
      rule,
    });
```

Replace the dead de-dup block, the sort, and the `uncorrelated` computation (lines 367-384) with:

```typescript
  /**
   * Advisory overlays are exempt from the winner-take-all pass below — see
   * the freeze-policy header. `observer-environment` answers a different
   * question than the specific rules ("is the problem this machine?" vs
   * "which system broke?"), so both answers are worth having at once. It
   * also declares no `sharedPatterns`, which means its 0.3 boost applies on
   * signal agreement alone: it scores 0.9 against any two agents reporting
   * connection/timeout, above every specific rule that lacks pattern
   * evidence. Letting it compete would make it the near-universal winner
   * and silence the specific answer.
   */
  const ADVISORY_RULE_NAMES = new Set(['observer-environment']);

  // De-duplicate the specific rules: an agent contributes to at most its
  // best-matching cluster. Rules overlap by design (two RDS rules can both
  // match one aws-rds target reporting two kinds of signal), and reporting
  // the same agents twice presents one incident as two. Strongest first —
  // ties keep rule declaration order, since the sort is stable — each agent
  // is claimed once, and a cluster left with fewer than two agents is
  // dropped: a "cluster" of one is not cross-system correlation. A cluster
  // that loses an agent gets its rootCause and investigationOrder
  // re-rendered so its text never names an agent it no longer contains.
  built.sort((a, b) => b.cluster.confidence - a.cluster.confidence);

  const specific: CorrelationCluster[] = [];
  const advisory: CorrelationCluster[] = [];
  const claimed = new Set<string>();

  for (const { cluster, rule } of built) {
    if (ADVISORY_RULE_NAMES.has(rule.name)) {
      advisory.push(cluster);
      continue;
    }
    const agents = cluster.agents.filter((a) => !claimed.has(a));
    if (agents.length < 2) continue;
    for (const a of agents) claimed.add(a);
    specific.push({
      ...cluster,
      agents,
      rootCause: rule.rootCauseTemplate.replace('{agents}', agents.join(', ')),
      investigationOrder: rule.investigationOrder.filter((a) => agents.includes(a)),
    });
  }

  // Specific clusters first, so the narrative leads with what broke and the
  // advisory rides along behind it. Ids are assigned last, over the
  // combined list, so they stay contiguous.
  const clusters: CorrelationCluster[] = [...specific, ...advisory].map((cluster, i) => ({
    ...cluster,
    id: `cluster-${i}`,
  }));

  // An agent named in ANY surviving cluster — advisory included — is not
  // uncorrelated.
  const clusteredAgents = new Set(clusters.flatMap((c) => c.agents));

  const uncorrelated = evidence
    .map((e) => e.agentKind)
    .filter((a) => !clusteredAgents.has(a));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts src/__tests__/scan-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/root-cause-synthesis.ts src/__tests__/root-cause-synthesis.test.ts
git commit -m "fix(synthesis): let an agent join only its best-matching cluster"
```

---

### Task 10: Reframe correlation output as an investigation hint

**Files:**
- Modify: `src/framework/root-cause-synthesis.ts` (`CorrelationCluster.confidence` doc comment at line 45 and the field at line 46, `buildNarrative` at lines 548-573), `src/cli/output.ts` (`printSynthesis` at lines 207-226)
- Test: `src/__tests__/root-cause-synthesis.test.ts`, `src/__tests__/cli-output.test.ts`

**Interfaces:**
- Consumes: `SynthesisResult` / `CorrelationCluster` (unchanged shapes; `confidence` is still a number and still orders clusters).
- Produces: `buildNarrative` opens with "Possible pattern match:" and no percentage. Human `printSynthesis` prints the heading `Possible pattern match` with the qualifier `investigation hint, not a diagnosis`, leads with `Investigate in this order:`, labels the template text `Pattern matched:`, and prints no numeric confidence. Machine mode is byte-for-byte unchanged (`jsonOut('synthesis', { synthesis: result })`, numbers included).

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/root-cause-synthesis.test.ts`, inside `describe('synthesizeByRules', ...)`:

```typescript
    it('frames the narrative as a possible pattern match, not a root cause', () => {
      const result = synthesizeByRules([
        makeEvidence('dns', {
          signals: [{ type: 'connection', source: 'dns', detail: 'resolver unreachable', severity: 'critical' }],
        }),
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg', detail: 'connect ECONNREFUSED', severity: 'critical' }],
        }),
      ]);
      expect(result.narrative).toContain('Possible pattern match');
      expect(result.narrative).toContain('Start by checking');
      expect(result.narrative).not.toContain('Primary root cause');
      expect(result.narrative).not.toMatch(/\d+% confidence/);
    });
```

Add a new top-level `describe` at the end of `src/__tests__/cli-output.test.ts`. It needs its own setup: the existing `printSynthesis` case lives inside `describe('CLI output — JSON mode', ...)`, whose `beforeEach` calls `configure({ json: true, ... })`, and machine mode short-circuits the human rendering this test is about.

```typescript
describe('CLI output — synthesis framing (human mode)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configure({ mode: 'human', noColor: true, json: false, verbose: false });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  it('frames a correlation as a hint, without a confidence number', () => {
    const synthesis: SynthesisResult = {
      clusters: [
        {
          id: 'cluster-0',
          rootCause: 'Database backpressure propagating through caching and messaging layers',
          confidence: 0.7,
          agents: ['postgresql', 'redis'],
          reasoning: 'Rule "database-backpressure": 2 agents share signal types [latency, timeout, connection]',
          temporalCorrelation: false,
          investigationOrder: ['postgresql', 'redis'],
        },
      ],
      uncorrelated: [],
      narrative: 'Possible pattern match: Database backpressure propagating through caching and messaging layers. Start by checking: postgresql → redis.',
      source: 'rules',
      synthesizedAt: new Date().toISOString(),
    };

    printSynthesis(synthesis);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Possible pattern match');
    expect(output).toContain('not a diagnosis');
    expect(output).toContain('Investigate in this order: postgresql -> redis');
    expect(output).not.toContain('root cause');
    expect(output).not.toContain('70%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts src/__tests__/cli-output.test.ts`
Expected: FAIL — narrative still reads `Primary root cause (90% confidence): ...`, and human output still prints `Likely shared root cause` with `(90% confidence)`.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/root-cause-synthesis.ts`, replace the `confidence` doc comment and its field inside `CorrelationCluster` (lines 45-46 — the single-line comment `/** Confidence that these agents share a common root cause (0-1) */` and the `confidence: number;` line under it; leave the `agents` comment on line 47 alone):

```typescript
  /**
   * Ordering weight for this cluster (0-1) — NOT a probability that the
   * pattern is the real cause. It ranks clusters against each other and
   * drives de-duplication; rendered output must never present it as odds.
   */
  confidence: number;
```

Replace `buildNarrative` (lines 548-573):

```typescript
function buildNarrative(
  clusters: CorrelationCluster[],
  uncorrelated: string[],
): string {
  if (clusters.length === 0 && uncorrelated.length === 0) {
    return 'No evidence to synthesize.';
  }

  const parts: string[] = [];

  if (clusters.length > 0) {
    // Investigation-path framing, not root-cause assertion: a rule match
    // means these signals have co-occurred in this shape before, nothing
    // more. The numeric confidence stays out of the prose — it orders
    // clusters, it does not measure how likely the pattern is.
    const top = clusters[0]!;
    parts.push(`Possible pattern match: ${top.rootCause}.`);
    parts.push(`Start by checking: ${top.investigationOrder.join(' → ')}.`);

    if (clusters.length > 1) {
      parts.push(`${clusters.length - 1} additional pattern match(es) detected.`);
    }
  }

  if (uncorrelated.length > 0) {
    parts.push(`No pattern matched for: ${uncorrelated.join(', ')}.`);
  }

  return parts.join(' ');
}
```

In `src/cli/output.ts`, replace `printSynthesis` (lines 207-226):

```typescript
export function printSynthesis(result: SynthesisResult): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('synthesis', { synthesis: result });
    return;
  }
  if (result.clusters.length === 0) return;

  // A correlation rule firing means these signals have co-occurred in this
  // shape before — it is a place to start looking, not a diagnosis. The
  // actionable content is the investigation order; the rule's own wording is
  // demoted to a labelled pattern description, and the numeric confidence
  // (an ordering weight, not odds) is not shown to humans at all.
  console.log(chalk.bold('  Possible pattern match') + chalk.dim(' — investigation hint, not a diagnosis'));
  console.log(chalk.dim(`  ${result.narrative}`));
  console.log('');
  for (const cluster of result.clusters) {
    console.log(
      chalk.cyan('    Investigate in this order: ')
      + chalk.white(cluster.investigationOrder.join(' -> ')),
    );
    console.log(chalk.dim(`    Pattern matched: ${cluster.rootCause}`));
  }
  console.log('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts src/__tests__/cli-output.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/root-cause-synthesis.ts src/cli/output.ts src/__tests__/root-cause-synthesis.test.ts src/__tests__/cli-output.test.ts
git commit -m "refactor(synthesis): render correlations as investigation hints"
```

---

### Task 11: Freeze the correlation-rule set

**Files:**
- Modify: `src/framework/root-cause-synthesis.ts` (file header at lines 4-15, export after `CORRELATION_RULES` ends at line 219), `CONTRIBUTING.md` (new section before `## Testing Requirements` at line 118; new bullet in `## What NOT to Do` at line 175)
- Test: `src/__tests__/root-cause-synthesis.test.ts`

**Interfaces:**
- Consumes: the existing `CORRELATION_RULES` array (11 rules).
- Produces: `export const CORRELATION_RULE_NAMES: readonly string[]` — the frozen roster, derived from `CORRELATION_RULES` so it cannot drift from the implementation.

- [ ] **Step 1: Write the failing test**

Add a new top-level `describe` at the end of `src/__tests__/root-cause-synthesis.test.ts`:

```typescript
describe('correlation rule freeze', () => {
  // The rule set is frozen: see the policy in the header of
  // src/framework/root-cause-synthesis.ts and in CONTRIBUTING.md. A new rule
  // requires a new agent class shipping with a concretely evidenced signal
  // pairing — no speculative incident templates. Changing this list without
  // updating both documents is the failure this test is here to catch.
  const FROZEN_RULES = [
    'deploy-cascade',
    'database-backpressure',
    'resource-exhaustion-cascade',
    'network-partition',
    'config-drift-cascade',
    'streaming-backpressure',
    'component-failure-cascade',
    'observer-environment',
    'rds-platform-degraded',
    'rds-reachability',
    'iac-out-of-band-change',
  ];

  it('contains exactly the frozen rules, in order', () => {
    expect([...CORRELATION_RULE_NAMES]).toEqual(FROZEN_RULES);
  });
});
```

Extend the file's import from `../framework/root-cause-synthesis.js` (lines 3-6) to include `CORRELATION_RULE_NAMES`:

```typescript
import {
  synthesizeByRules,
  synthesizeFromRoutingResults,
  CORRELATION_RULE_NAMES,
} from '../framework/root-cause-synthesis.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts -t 'correlation rule freeze'`
Expected: FAIL — `CORRELATION_RULE_NAMES` is not exported (`SyntaxError: The requested module does not provide an export named 'CORRELATION_RULE_NAMES'`).

- [ ] **Step 3: Write minimal implementation**

In `src/framework/root-cause-synthesis.ts`, replace the file header comment (lines 4-15) with:

```typescript
/**
 * Root cause synthesis — correlates signals across multiple agents and systems
 * to identify shared root causes that no single agent would detect alone.
 *
 * For example: a deploy causes both database connection exhaustion AND Redis
 * memory pressure → synthesiser links both to the deploy event rather than
 * treating them as independent incidents.
 *
 * Two modes:
 * - Rule-based correlation: fast, deterministic, no external calls
 * - AI-assisted synthesis: uses Claude to reason across multi-system evidence
 *
 * ── THE CORRELATION RULE SET IS FROZEN ──
 *
 * `CORRELATION_RULES` is closed. Do not add a rule unless BOTH hold:
 *
 *   1. A new agent class ships, and
 *   2. it brings a concretely evidenced signal pairing — an incident actually
 *      observed, with the two signals named, not a plausible-sounding story.
 *
 * No speculative incident templates. Real incidents are combinatorial: each
 * rule multiplies the cross-rule interaction surface, and every bug in this
 * file so far (pairwise `requiredTypesByKind`, evidence-reference keying of
 * the signal maps, the third-target veto, the dead per-agent de-dup) came
 * from rules interacting, not from a rule being individually wrong.
 *
 * What a match means: these signals have co-occurred in this shape before.
 * That is an investigation hint, not a diagnosis, and output layers must
 * render it that way. `CorrelationCluster.confidence` is an ordering weight,
 * never odds. `CORRELATION_RULE_NAMES` is enforced by a test; CONTRIBUTING.md
 * carries the same policy for contributors.
 *
 * ── ADVISORY OVERLAYS ──
 *
 * `ADVISORY_RULE_NAMES` (currently just `observer-environment`) lists rules
 * that answer "is the problem this machine?" rather than "which system
 * broke?". They are exempt from the one-agent-one-cluster de-dup: they claim
 * no agents and co-exist with the specific cluster. Adding a rule to that set
 * is as much a policy decision as adding a rule at all — an overlay is never
 * suppressed by a stronger cluster, so it must be one an operator always
 * wants to see.
 */
```

Append immediately after the `CORRELATION_RULES` array closes (line 219):

```typescript
/**
 * The frozen roster, derived from the rules themselves so the two can never
 * disagree. A test pins this list — changing it is a deliberate act that
 * requires updating the freeze policy above and in CONTRIBUTING.md.
 */
export const CORRELATION_RULE_NAMES: readonly string[] = CORRELATION_RULES.map((r) => r.name);
```

In `CONTRIBUTING.md`, insert this section immediately before `## Testing Requirements`:

```markdown
## Correlation Rules Are Frozen

`CORRELATION_RULES` in `src/framework/root-cause-synthesis.ts` is a closed set.
**Do not add a correlation rule** unless both of these are true:

1. A new agent class is shipping, and
2. it brings a concretely evidenced signal pairing -- an incident actually
   observed, with both signals named. Not a plausible-sounding story.

No speculative incident templates. Real incidents are combinatorial: every
rule multiplies the interaction surface between rules, and every bug this file
has had came from rules interacting rather than from a rule being individually
wrong.

A rule match means "these signals have co-occurred in this shape before" -- an
investigation hint, not a diagnosis. Output surfaces must render it that way,
and `CorrelationCluster.confidence` is an ordering weight, never a probability.
The same applies to `ADVISORY_RULE_NAMES`, the small set of overlay rules that
answer "is the problem this machine?" and are exempt from the
one-agent-one-cluster de-dup: adding to it is a policy decision, because an
overlay is never suppressed by a stronger cluster.
`CORRELATION_RULE_NAMES` is pinned by a test in
`src/__tests__/root-cause-synthesis.test.ts`; changing the rule set means
updating that test, this section, and the policy header in the source file.
```

And add one bullet to `## What NOT to Do`, after the `maxRiskLevel: 'critical'` bullet:

```markdown
- **Don't add correlation rules** -- the rule set is frozen; see [Correlation Rules Are Frozen](#correlation-rules-are-frozen)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/root-cause-synthesis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/root-cause-synthesis.ts CONTRIBUTING.md src/__tests__/root-cause-synthesis.test.ts
git commit -m "docs(synthesis): freeze the correlation rule set under a written policy"
```

---

### Task 12: Full verification and snapshot refresh

**Files:**
- Possibly modify: `src/__tests__/__snapshots__/cli-snapshots.test.ts.snap` (only if a snapshot legitimately changed)
- Test: the whole suite

**Interfaces:**
- Consumes: everything from Tasks 1-11.
- Produces: green typecheck, lint, and full test suite — the PR's acceptance gate.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (2323+). The `cli-snapshots` fixtures set no `bestEffort` and no `maturity`, so the scan JSON and pipe snapshots should be unchanged. If a snapshot did change, read the diff before accepting it: a changed scan-JSON snapshot means a field appeared that the fixture never set, which is a bug in Tasks 4-5, not a snapshot to bless. Only run `pnpm vitest run src/__tests__/cli-snapshots.test.ts -u` once you have confirmed the diff is an intended rendering change, and include the updated `.snap` in the commit.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors. (This builds `@crisismode/agent-sdk` first; that is expected.)

- [ ] **Step 3: Lint**

Run: `pnpm run lint`
Expected: no errors.

- [ ] **Step 4: Verify the acceptance criteria**

Confirm each — the first is covered by an executed test, the rest by inspection:
- `crisismode scan --json` distinguishes live-validated from best-effort watching entries (`VisibilityEntry.maturity`, Task 2) and simulator-agent findings carry `bestEffort: true` — asserted end-to-end against the real `runScan` by `src/__tests__/scan-run-best-effort.test.ts` (Task 5).
- The visibility watching count equals live-validated kinds only (`liveValidatedWatching`, Tasks 2-3, 6); `buildHeadline` and `computeHealthScore` are untouched — confirm with `git diff main -- src/cli/incident-summary.ts` (expect no output) and that `computeHealthScore` in `src/cli/commands/scan.ts` is unchanged in the diff.
- No output surface renders a correlation match as a definitive root cause (Task 10), and a mixed RDS incident fires exactly one RDS rule (Task 9).

- [ ] **Step 5: Commit (only if the snapshot changed)**

```bash
git add src/__tests__/__snapshots__/cli-snapshots.test.ts.snap
git commit -m "test(cli): refresh scan snapshots for honesty-layer output"
```

If nothing changed, skip the commit — `git status` should be clean.
