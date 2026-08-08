# Service Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Is it down for everyone, or just me?" for third-party dependencies — official status pages + direct probes, surfaced via `crisismode down`, scan (new `service-status` agent), and triage enrichment.

**Architecture:** A shared `src/framework/service-status/` module (catalog, Statuspage-v2 parser moved out of llm-provider, checker producing a 9-row combined verdict) consumed by three thin surfaces. Spec: `docs/superpowers/specs/2026-08-08-service-status-design.md` — read it before Task 1; it is authoritative on semantics.

**Tech Stack:** TypeScript strict / ESM NodeNext, raw `fetch` + `node:net`/`node:dns` (no new dependencies), vitest.

## Global Constraints

- TypeScript strict incl. `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; `.js` import extensions; named exports only; `import type` for type-only imports; SPDX two-line header on every new file (copy from any sibling).
- No new runtime dependencies (256Mi spoke target).
- All timing via `performance.now()`; never `Date.now()` for durations.
- Timeouts: `STATUS_TIMEOUT_MS = 1500`, `PROBE_TIMEOUT_MS = 1500` (scan budget is 2000ms); the `down` command may pass a per-service ceiling of `3500`. Fetches use `AbortSignal.timeout(...)`.
- Concurrency: services checked 5 at a time (`CHECK_CONCURRENCY = 5`); status fetch and probe for one service run in parallel. This bounds `checkServices` only. On the scan path each configured service becomes its own target and `src/cli/commands/scan.ts:395` runs all targets concurrently under `Promise.all`, so the pool does not bound scan — the binding constraint there is the per-target probe/status budget against `AGENT_TIMEOUT_MS = 2000` (`scan.ts:58,231-241`). One agent instance must check exactly one service; if it ever checks more than five, two pool rounds would exceed the scan budget and `scan.ts:233-240` would silently replace the assessment with a signal-less stub, dropping every checkId (the same trap `src/agent/llm-provider/registration.ts:52-56` avoids).
- **Pinned series rule:** every scenario string `plan()` can emit MUST be in the manifest's `failureScenarios` and covered by a real `validatePlan` test (import from `src/framework/validator.js`, one `it.each` case per scenario, plan built through the real agent + simulator).
- `evaluateCheck` fails CLOSED (`return false`) on unmatched statements in BOTH backends from day one, with the standard comment (copy from `src/agent/llm-provider/simulator.ts`).
- Honesty rules from the spec are binding: `status_unavailable` is never presented as an outage; raw domains labeled "reachability only"; OfflineGate short-circuits everything; `down_for_you` wording hedges ("likely your network, DNS, or config").
- **Plan-level refinements of the spec (deliberate, do not "fix" back):** (1) the probe is DNS resolve + plain TCP connect, reusing `triage-probes.ts`'s already-exported `probeTcpBounded` (see Task 3) — no TLS handshake (cert problems are the tls agent's job). (2) Agent targets use the single registered kind `service-status` with the service id carried in the target name/options — per-id dotted kinds would require static registrations for config-driven ids, which the registry cannot do; the Task 8 guide uses a concrete `platform: 'status-page'`, and universal visibility comes from `platformsForTarget` returning `undefined` for the `service-status` kind, which is already its default (see Task 8), so no platform-scoping is lost.
- Conventional commits; every commit ends with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run `pnpm run typecheck` and the task's test files before every commit. Do not run the full suite per task (the controller does).

---

### Task 1: Shared Statuspage module (extraction from llm-provider)

**Files:**
- Create: `src/framework/service-status/types.ts`
- Create: `src/framework/service-status/statuspage.ts`
- Modify: `src/agent/llm-provider/live-client.ts` (remove local `parseStatuspageIncidents` at ~line 194, import from the new module)
- Test: `src/__tests__/service-status-statuspage.test.ts`

**Interfaces:**
- Consumes: nothing new. The function being moved is `parseStatuspageIncidents(body: unknown): ProviderIncident[] | null` in `src/agent/llm-provider/live-client.ts:194-206` — read it first; its behavior (filter `resolved`/`postmortem`, map to `{title, impact, url?}`) must be preserved bit-for-bit.
- Produces: `StatusIncident`, `StatusPageAssessment`, `StatusAssessment`, `parseStatuspageIncidents()`, `parseStatuspageSummary()` — used by Tasks 2-9.

- [ ] **Step 1: Write the types**

```ts
// src/framework/service-status/types.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/** One unresolved incident from a provider's status page. */
export interface StatusIncident {
  title: string;
  impact: string;
  url?: string;
}

/** What the provider's own status source reports. NEVER conflated with reachability. */
export type StatusAssessment =
  | 'incident_reported'
  | 'degraded_reported'
  | 'operational'
  | 'status_unavailable'
  | 'no_status_source';

/** Parsed Statuspage-v2 summary. */
export interface StatusPageAssessment {
  assessment: Exclude<StatusAssessment, 'status_unavailable' | 'no_status_source'>;
  incidents: StatusIncident[];
  /** Statuspage overall indicator ('none' | 'minor' | 'major' | 'critical'), or 'unknown'. */
  indicator: string;
}

/** Reachability of the service from this machine. */
export type ProbeOutcome = 'reachable' | 'dns_failed' | 'connect_failed';

/** Combined plain-language verdict (spec's 9-row table + offline gate). */
export type ServiceVerdict =
  | 'confirmed_incident'
  | 'degraded_upstream'
  | 'healthy'
  | 'down_for_you'
  | 'healthy_unverified'
  | 'unreachable_unverified'
  | 'healthy_probe_only'
  | 'unreachable_probe_only'
  | 'offline_skipped';

export interface ServiceStatusReport {
  /** Catalog id, or the raw domain for unknown services. */
  id: string;
  label: string;
  source: 'catalog' | 'domain';
  host: string;
  port: number;
  statusAssessment: StatusAssessment;
  incidents: StatusIncident[];
  probe: ProbeOutcome | 'skipped';
  verdict: ServiceVerdict;
  /** Plain-language one-liner, spec wording. */
  detail: string;
  checkedAt: string;
  durationMs: number;
}
```

- [ ] **Step 2: Write the failing parser tests**

Use recorded fixtures (inline constants, not network): a `none`-indicator payload, a `minor` payload with one degraded component, a `major` payload with one unresolved incident, a payload with a `resolved` incident only, and garbage (`null`, `[]`, `{"incidents": "nope"}`).

```ts
// src/__tests__/service-status-statuspage.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { parseStatuspageIncidents, parseStatuspageSummary } from '../framework/service-status/statuspage.js';

const OPERATIONAL = {
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [{ name: 'API', status: 'operational' }],
  incidents: [],
};

const MINOR = {
  status: { indicator: 'minor', description: 'Partially Degraded Service' },
  components: [
    { name: 'API', status: 'operational' },
    { name: 'Webhooks', status: 'degraded_performance' },
  ],
  incidents: [],
};

const MAJOR_WITH_INCIDENT = {
  status: { indicator: 'major', description: 'Partial System Outage' },
  components: [{ name: 'API', status: 'partial_outage' }],
  incidents: [
    { name: 'Elevated API errors', impact: 'major', status: 'investigating', shortlink: 'https://stspg.io/x1' },
    { name: 'Old thing', impact: 'minor', status: 'resolved' },
  ],
};

describe('parseStatuspageIncidents (moved from llm-provider, behavior preserved)', () => {
  it('returns unresolved incidents only', () => {
    expect(parseStatuspageIncidents(MAJOR_WITH_INCIDENT)).toEqual([
      { title: 'Elevated API errors', impact: 'major', url: 'https://stspg.io/x1' },
    ]);
  });

  it('returns null for unparseable bodies', () => {
    expect(parseStatuspageIncidents(null)).toBeNull();
    expect(parseStatuspageIncidents({ incidents: 'nope' })).toBeNull();
  });
});

describe('parseStatuspageSummary', () => {
  it('classifies operational', () => {
    const parsed = parseStatuspageSummary(OPERATIONAL);
    expect(parsed).toEqual({ assessment: 'operational', incidents: [], indicator: 'none' });
  });

  it('classifies minor indicator / degraded component as degraded_reported', () => {
    expect(parseStatuspageSummary(MINOR)?.assessment).toBe('degraded_reported');
  });

  it('classifies unresolved incidents or major/critical indicator as incident_reported', () => {
    const parsed = parseStatuspageSummary(MAJOR_WITH_INCIDENT);
    expect(parsed?.assessment).toBe('incident_reported');
    expect(parsed?.incidents).toHaveLength(1);
  });

  it('returns null for garbage', () => {
    expect(parseStatuspageSummary([])).toBeNull();
    expect(parseStatuspageSummary(undefined)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify FAIL** — `npx vitest run src/__tests__/service-status-statuspage.test.ts` → module not found.

- [ ] **Step 4: Implement `statuspage.ts`**

Move `parseStatuspageIncidents` verbatim (return type becomes `StatusIncident[] | null`), then add:

```ts
// src/framework/service-status/statuspage.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { StatusIncident, StatusPageAssessment } from './types.js';

/** Statuspage v2 summary: unresolved entries in `incidents[]`. */
export function parseStatuspageIncidents(body: unknown): StatusIncident[] | null {
  // ...moved verbatim from src/agent/llm-provider/live-client.ts:194-206...
}

/**
 * Full Statuspage-v2 classification. `incident_reported` when unresolved
 * incidents exist or the overall indicator is major/critical;
 * `degraded_reported` when the indicator is minor or any component is not
 * operational; `operational` otherwise. Null when the body is not a
 * Statuspage summary.
 */
export function parseStatuspageSummary(body: unknown): StatusPageAssessment | null {
  const incidents = parseStatuspageIncidents(body);
  if (incidents === null) return null;
  const status = (body as { status?: { indicator?: unknown } }).status;
  const indicator = typeof status?.indicator === 'string' ? status.indicator : 'unknown';
  const componentsRaw = (body as { components?: unknown }).components;
  const nonOperational = Array.isArray(componentsRaw)
    ? componentsRaw.filter(
        (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
      ).filter((c) => typeof c.status === 'string' && c.status !== 'operational').length
    : 0;

  if (incidents.length > 0 || indicator === 'major' || indicator === 'critical') {
    return { assessment: 'incident_reported', incidents, indicator };
  }
  if (indicator === 'minor' || nonOperational > 0) {
    return { assessment: 'degraded_reported', incidents, indicator };
  }
  return { assessment: 'operational', incidents, indicator };
}
```

- [ ] **Step 5: Rewire llm-provider** — delete the local function from `live-client.ts`, add `import { parseStatuspageIncidents } from '../../framework/service-status/statuspage.js';`. `ProviderIncident` is structurally identical to `StatusIncident`; it is declared at `src/agent/llm-provider/backend.ts:73-77` (NOT in `live-client.ts` — `live-client.ts:35` only imports it). Replace the `backend.ts:73-77` declaration with `export type ProviderIncident = StatusIncident;` (importing `StatusIncident` from `../../framework/service-status/types.js`; agent→framework is fine), keeping every existing import path working. `parseGoogleCloudIncidents` (`live-client.ts:209`) keeps using the `ProviderIncident` alias unchanged.

- [ ] **Step 6: Run tests** — the new file passes AND the existing llm-provider suites stay green: `npx vitest run src/__tests__/service-status-statuspage.test.ts $(ls src/__tests__/llm-provider*.test.ts)` and `pnpm run typecheck`.

- [ ] **Step 7: Commit** — `refactor(service-status): extract Statuspage-v2 parsing into a shared module`

---

### Task 2: Catalog

**Files:**
- Create: `src/framework/service-status/catalog.ts`
- Test: `src/__tests__/service-status-catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CatalogEntry { id, label, probeHost, probePort, statusUrl, statusFormat: 'statuspage_v2' }`, `SERVICE_CATALOG: readonly CatalogEntry[]`, `resolveCatalogEntry(idOrAlias: string): CatalogEntry | undefined`, `CATALOG_ALIASES`.

- [ ] **Step 1: Failing tests**

```ts
// src/__tests__/service-status-catalog.test.ts (core assertions)
import { SERVICE_CATALOG, resolveCatalogEntry } from '../framework/service-status/catalog.js';

it('resolves ids case-insensitively and via aliases', () => {
  expect(resolveCatalogEntry('github')?.id).toBe('github');
  expect(resolveCatalogEntry('GitHub')?.id).toBe('github');
  expect(resolveCatalogEntry('flyio')?.id).toBe('fly');
  expect(resolveCatalogEntry('pscale')?.id).toBe('planetscale');
  expect(resolveCatalogEntry('api.myvendor.com')).toBeUndefined();
});

it('every entry is statuspage_v2 with an https status URL and port 443', () => {
  for (const e of SERVICE_CATALOG) {
    expect(e.statusFormat).toBe('statuspage_v2');
    expect(e.statusUrl).toMatch(/^https:\/\/.+\/api\/v2\/summary\.json$/);
    expect(e.probePort).toBe(443);
    expect(e.id).toMatch(/^[a-z0-9-]+$/);
  }
});

it('ids are unique and anthropic/openai are NOT in the catalog (llm-provider owns them)', () => {
  const ids = SERVICE_CATALOG.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(resolveCatalogEntry('anthropic')).toBeUndefined();
  expect(resolveCatalogEntry('openai')).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `catalog.ts`** with exactly the spec's 15 candidate entries (github, stripe, vercel, netlify, supabase, neon, cloudflare, npm, twilio, sendgrid, resend, render, fly, planetscale, upstash — probe hosts and status URLs from the spec table), `CATALOG_ALIASES: Record<string, string> = { flyio: 'fly', 'fly.io': 'fly', pscale: 'planetscale' }`, and `resolveCatalogEntry` lowercasing input, checking aliases then ids. Header comment: "Candidate URLs are verified against the live endpoints in Task 9; entries that fail live validation are corrected or removed there — do not add entries without live verification."

- [ ] **Step 4: Run → PASS; typecheck; commit** — `feat(service-status): curated service catalog with alias resolution`

---

### Task 3: Checker

**Files:**
- Create: `src/framework/service-status/checker.ts`
- Test: `src/__tests__/service-status-checker.test.ts`

**Interfaces:**
- Consumes: Task 1 types + parser, Task 2 catalog. Before the checker, move `src/agent/llm-provider/offline-gate.ts` to `src/framework/offline-gate.ts` (same extract-and-share move as Task 1's parser) — there is zero precedent for a `src/framework/*` module importing runtime code out of a specific agent's directory (every existing `framework/*` → `agent/*` import is a type-only import of `RecoveryAgent` from `agent/interface.js`: `engine.ts:11`, `graph-nodes.ts:11`, `graph-engine.ts:16`, `agent-test-harness.ts:12`). Leave `src/agent/llm-provider/offline-gate.ts` as a two-line re-export so `agent.ts:62` (constructor default) and the existing llm-provider tests keep working unchanged; the file's own docstring already calls it "the single seam between this agent and the triage module" — framework is where that seam belongs. Run the llm-provider suites after the move. The checker then consumes `OfflineGate`/`defaultOfflineGate` from `src/framework/offline-gate.js`.
  For the probe: import `probeTcpBounded` from `src/framework/triage-probes.js` — it is already exported (`triage-probes.ts:324`) and already shared with `network-profile.ts` (`network-profile.ts:30,157,165`) and its own tests (`network-profile.test.ts:12,98`); its docstring states this explicitly: "Shared with network-profile.ts (Task 13) so there is exactly one socket-probe implementation to keep bounded." Do NOT reimplement it — that would violate the series' own one-implementation rule (the same rule Task 1 enforces for the Statuspage parser). `connectTcp` (`triage-probes.ts:308-310`) is a three-line delegating method on the probes object; ignore it and call `probeTcpBounded` directly. Wrap it to map `ProbeResult` → `ProbeOutcome`: `reachable: true` → `'reachable'`, otherwise `'connect_failed'`. DNS resolution is a separate `dns.lookup()` in front of it, whose failure maps to `'dns_failed'`.
- Produces:

```ts
export interface ServiceTarget { id: string; host?: string; port?: number }
export interface CheckerDeps {
  fetchImpl?: typeof fetch;
  probeImpl?: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
  offlineGate?: OfflineGate;
  statusTimeoutMs?: number;   // default STATUS_TIMEOUT_MS = 1500
  probeTimeoutMs?: number;    // default PROBE_TIMEOUT_MS = 1500 — a TOTAL deadline across dns.lookup + connect (see Step 3)
}
export const CHECK_CONCURRENCY = 5;
export function resolveTarget(input: string | { host: string; port?: number }): ServiceTarget & { entry?: CatalogEntry };
export async function checkService(target: ServiceTarget, deps?: CheckerDeps): Promise<ServiceStatusReport>;
export async function checkServices(targets: ServiceTarget[], deps?: CheckerDeps): Promise<ServiceStatusReport[]>;
export function combineVerdict(status: StatusAssessment, probe: ProbeOutcome): ServiceVerdict;
export function verdictDetail(report: Pick<ServiceStatusReport, 'verdict' | 'label' | 'incidents' | 'source'>): string;
```

- [ ] **Step 1: Failing tests — the verdict table, exhaustively**

```ts
const TABLE: Array<[StatusAssessment, ProbeOutcome, ServiceVerdict]> = [
  ['incident_reported', 'reachable', 'confirmed_incident'],
  ['incident_reported', 'connect_failed', 'confirmed_incident'],
  ['degraded_reported', 'reachable', 'degraded_upstream'],
  ['degraded_reported', 'connect_failed', 'confirmed_incident'],
  ['degraded_reported', 'dns_failed', 'confirmed_incident'],
  ['operational', 'reachable', 'healthy'],
  ['operational', 'connect_failed', 'down_for_you'],
  ['operational', 'dns_failed', 'down_for_you'],
  ['status_unavailable', 'reachable', 'healthy_unverified'],
  ['status_unavailable', 'connect_failed', 'unreachable_unverified'],
  ['no_status_source', 'reachable', 'healthy_probe_only'],
  ['no_status_source', 'connect_failed', 'unreachable_probe_only'],
];
it.each(TABLE)('%s + %s -> %s', (s, p, v) => expect(combineVerdict(s, p)).toBe(v));
```

Plus behavioral tests, all with injected fakes (NO network):
- `checkService` with a fake `fetchImpl` returning the Task 1 MAJOR fixture and a fake probe returning `reachable` → full report: `verdict: 'confirmed_incident'`, incidents propagated, `detail` contains "down for everyone".
- fake fetch that **rejects** → `statusAssessment: 'status_unavailable'` and detail contains "status page couldn't be checked" — never the word "down for everyone" (honesty rule 1 as a test).
- target with no catalog entry → fetch NOT called (assert via spy), `statusAssessment: 'no_status_source'`, detail contains "reachability only".
- offlineGate returning non-null → every report `verdict: 'offline_skipped'`, probe `'skipped'`, fetch and probe never called.
- `checkServices` with 12 targets, using manually-resolved deferred promises (an array of `{promise, resolve}`, no `setTimeout`) as the instrumented probe: assert the in-flight count reaches **exactly 5** and never exceeds it while the remaining 7 are queued, then release them in order. (A fake probe that resolves immediately would yield an observed max of 1 and pass without the pool existing; a timer-based fake would be flaky — the assertion must be on the pool's structure, not wall-clock.)
- `down_for_you` detail contains "likely your network, DNS, or config" (honesty rule 5 as a test).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Key points:
  - `resolveTarget`: string → `resolveCatalogEntry()` first; hit → `{id: entry.id, entry}`; miss → treat as domain `{id: input, host: input, port: 443}`. Object form → `{id: host, host, port: port ?? 443}`.
  - Default probe: `dns.lookup(host)` (node:dns/promises) — failure → `'dns_failed'`; then `probeTcpBounded(host, port, label, remainingMs)` from `src/framework/triage-probes.js` (per Interfaces above). `probeTimeoutMs` is a TOTAL deadline across both phases, not 1500ms each (1500+1500 would blow the 2000ms scan budget) — record `performance.now()` before `dns.lookup`, compute `remainingMs = probeTimeoutMs - elapsed` after it resolves, and pass that (floored at some small minimum, e.g. 50ms) to `probeTcpBounded`.
  - Status fetch: only when a catalog entry exists; `fetchImpl(entry.statusUrl, { signal: AbortSignal.timeout(statusTimeoutMs), headers: { accept: 'application/json' } })`; non-2xx, reject, or `parseStatuspageSummary` null → `'status_unavailable'`.
  - Status fetch and probe run in `Promise.allSettled` pair per service; services through a simple pool of `CHECK_CONCURRENCY`.
  - `verdictDetail` — exact plain-language strings from the spec table (write them once here; the command and agent must NOT re-invent wording).
- [ ] **Step 4: Run → PASS; typecheck.**
- [ ] **Step 5: Commit** — `feat(service-status): two-fact checker with combined verdicts`

---

### Task 4: `services:` config

**Files:**
- Modify: `src/config/schema.ts` (add types), `src/config/loader.ts` (validation)
- Test: `src/__tests__/service-status-config.test.ts`

**Interfaces:**
- Produces: `export type ServiceConfigEntry = string | { host: string; port?: number };` and `services?: ServiceConfigEntry[]` added to `SiteConfig` (`src/config/schema.ts:125-155` — the top-level interface the loader returns).

- [ ] **Step 1: Read `src/config/loader.ts`** end to end. The top-level interface the loader returns is `SiteConfig` (`src/config/schema.ts:125-155`); add the optional `services?: ServiceConfigEntry[]` field there. The hand-rolled validation pattern to follow is `validateNetwork` (`loader.ts:137-153`), invoked from `loadConfigFile` at `loader.ts:130-132` — add the `services` validation immediately after that call (hand-rolled checks + plain-language error messages; zod is present but unused — do NOT introduce it).
- [ ] **Step 2: Failing tests** (drive the loader with inline YAML strings, following however existing loader tests build configs — grep `src/__tests__` for the loader's test file and mirror its harness):
  - valid: catalog id, alias, raw domain, `{host, port}` long form → parsed into the config object unchanged.
  - invalid: `https://stripe.com` (scheme), `foo/bar` (path), `has space`, `{host: 'x', port: 0}`, `{port: 443}` (missing host) → validation error whose message lists at least three valid catalog ids (assert `.toMatch(/github/)`).
  - **a config with only `services: [github]` and no `targets:` loads successfully** — `loader.ts:116-125` currently throws `'Config must define at least one target...'` when `config.targets` is empty, which is exactly the shape the Task 10 README example uses (see Step 3).
  - a config with neither `targets:` nor `services:` still errors, and the message names both keys.
- [ ] **Step 3: Implement validation**: strings must satisfy `resolveCatalogEntry(s) !== undefined || /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s)`; long form requires non-empty host matching the same regex and integer port 1-65535. Also relax the targets requirement at `loader.ts:116-125`: a config is valid when it declares at least one of `targets` or `services` (non-empty). Update the error message to name both keys, e.g. "Config must define at least one target or service. Add a `targets:` block or a `services:` list."
- [ ] **Step 4: Run → PASS; typecheck; commit** — `feat(config): services list for third-party dependency checks`

---

### Task 5: `crisismode down` command

**Files:**
- Create: `src/cli/commands/down.ts`
- Modify: `src/cli/index.ts` (add a `case 'down':` alongside the existing subcommand dispatch, and a `down` row in the `HELP` block, e.g. near `src/cli/index.ts:34`'s `crisismode triage` row), `src/cli/commands/completions.ts` (`triage` appears at lines 20, 48, 107, 156, 228 — five sites; add a `down` peer at each)
- Test: `src/__tests__/down-command.test.ts`

**Interfaces:**
- Consumes: Task 3 checker (inject `CheckerDeps` for tests), Task 4 config (`services` list via however commands load site config). `src/cli/commands/triage.ts` has NO arg parsing of its own — `TriageCommandOptions` is just `{ configPath?: string | undefined }` (`triage.ts:23-25`); all arg parsing lives in `src/cli/index.ts:82-105` (`parseArgs`), and the triage case (`index.ts:186-191`) passes only `configPath`. Mirror `triage.ts` for **output-mode branching** (`triage.ts:140-150`), **`--terse` handling** (`triage.ts:59`), and the **return-code + `process.exitCode` convention** (`triage.ts:152-154`, which sets `process.exitCode = code` itself AND returns it) — not for arg parsing. Since `down` needs its own positional services list and an unknown-flag check that `index.ts`'s global `parseArgs({ strict: false })` (`index.ts:103`) will NOT provide (unknown flags are silently accepted into `values`, never thrown — confirmed by `grep -rn "exitCode = 2\|process.exit(2)" src` returning nothing; no command in this CLI has ever exited 2), add a `case 'down':` to `index.ts` that passes `positionals.slice(1)` plus the raw `process.argv` slice so `runDownCommand` can detect unrecognised flags itself.
- Produces: `runDownCommand(args: string[], deps?: CheckerDeps & { loadConfig?: ... }): Promise<number>` (returns exit code; `index.ts` also sets `process.exitCode` from it, matching the `triage.ts:152-154` convention).

- [ ] **Step 1: Failing tests** (inject fake checker deps; capture stdout the way `triage`'s command tests do — find and mirror them):
  - `down stripe` with fake reports → human output contains the verdict line and incident title; exit 1 for `confirmed_incident`.
  - all-healthy → exit 0. `healthy_unverified`/`healthy_probe_only` → exit 0.
  - `down_for_you` present → exit 1 AND output suggests `crisismode triage`.
  - bare `down` with no configured services → exit 0, output contains both usage forms (`crisismode down <service>` and `services:`), and is NOT an error.
  - bare `down` with configured services → checks exactly those.
  - `down anthropic` / `down openai` → resolves through `getProviderSpec` from `src/agent/llm-provider/provider-table.js` (confirmed exported, with `statusUrl` fields for both providers) and uses that provider's `statusUrl` with the Task 1 Statuspage parser, rather than falling through to raw-domain handling (which would DNS-fail on a host literally named `anthropic`). This is spec line 66's "exactly one owner per provider's status endpoint" contract — Task 2's catalog deliberately excludes these ids, so without this the ids would be worse than unsupported.
  - unknown flag → exit 2. This is a new exit code for this CLI (nothing else emits it); `runDownCommand` must scan its own args for a leading `--`/`-` token outside its known set and return 2 itself — it does not come from the global parser. Document exit 0/1/2 in both the `down --help` text and the README table (Task 10).
  - `--json` → one JSON object per service (parse each line), each with `id`, `verdict`, `statusAssessment`, `probe`, `detail`.
  - pipe mode (non-TTY): tab-separated `id verdict statusAssessment probe detail`, no ANSI.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `deps.statusTimeoutMs`/`probeTimeoutMs` set to the interactive ceiling `3500` (constant `DOWN_TIMEOUT_MS = 3500`). Human output: define a local exhaustive `const VERDICT_ICON: Record<ServiceVerdict, string>` in `down.ts`, following the established per-command local-const convention (`src/cli/commands/readiness.ts:16`, `triage.ts:28-30`) — `src/cli/status-presentation.ts` has NO emoji anywhere, only chalk colour maps/accessors (`HEALTH_STATUS_COLOR`, `SIGNAL_STATUS_COLOR`, `FINDING_SEVERITY_COLOR`, `TRIAGE_VERDICT_COLOR` and their accessor functions). Reuse `healthStatusColor` (`status-presentation.ts:36`) for colour by mapping each verdict to a `HealthStatus`. Verdict `detail` from the checker verbatim, incident titles indented beneath. `--terse` drops explanation lines, keeps verdicts.
- [ ] **Step 4: Run → PASS; typecheck; run the real CLI once** (`npx tsx src/cli/index.ts down --help` and `npx tsx src/cli/index.ts down github` — live network OK here, just confirm no crash either way).
- [ ] **Step 5: Commit** — `feat(cli): crisismode down — is it down for everyone, or just me?`

---

### Task 6: service-status agent

**Files:**
- Create: `src/agent/service-status/check-ids.ts` (dependency-free, exporting `SERVICE_STATUS_CHECK_IDS = { statusPage: 'service-status.status_page', reachability: 'service-status.reachability' } as const` — copy the header comment style from `src/agent/vector-store/check-ids.ts:4-14`), `src/agent/service-status/backend.ts`, `simulator.ts`, `live-client.ts`, `manifest.ts`, `agent.ts`, `registration.ts`
- Create: `src/cli/service-targets.ts` — `serviceTargetsFromConfig(config: SiteConfig): TargetConfig[]`, the shared config→targets mapping (see Step 5)
- Modify: `src/config/builtin-agents.ts` (register); `src/cli/commands/scan.ts` — call `serviceTargetsFromConfig` alongside `mergeLocalTargets` in the target assembly (`scan.ts:313-336`), and add `'service-status': 'SVC'` to `KIND_PREFIX` (`scan.ts:61-86`, otherwise finding ids fall back to `kind.toUpperCase().slice(0,5)` and render as `SERVI-001`); `src/cli/runtime.ts` — call `serviceTargetsFromConfig` inside `loadConfigWithLocalTargets` (`runtime.ts:60-80`) so `watch` sees the same targets scan does (two independent config→targets paths exist today — scan assembles inline in `runScan`, watch goes through `loadConfigWithLocalTargets`; wiring only one leaves the other blind to `services:`, contradicting spec Goal 3's "`crisismode scan` / `watch`")
- Test: `src/__tests__/service-status-plan.test.ts`, `src/__tests__/service-status-agent.test.ts`, `src/__tests__/service-targets.test.ts` (unit-tests `serviceTargetsFromConfig` directly); extend `src/__tests__/simulator-evaluate-check.test.ts` and `src/__tests__/live-client-evaluate-check.test.ts` with the new backends' unmatched-statement cases

**Interfaces:**
- Consumes: Tasks 1-4. Read `src/agent/llm-provider/` (agent shape, OfflineGate usage — construction at `agent.ts:62`, the gate call at `agent.ts:89`) and `src/agent/vector-store/` (simulator state pattern, `no_finding` mapping — see Step 2's correction below) before writing anything.
- Produces: `ServiceStatusBackend extends ExecutionBackend` with `queryServices(): Promise<ServiceStatusReport[]>`; manifest kind `service-status`, `maxRiskLevel: 'routine'`, `failureScenarios: ['dependency_incident', 'dependency_degraded', 'dependency_unreachable', 'no_finding']`, and exactly one execution context — `{ name: 'service_status_read', type: 'api_call', privilege: 'read', target: 'service-status', allowedOperations: ['query_services'], capabilities: [] }`. `validatePlan`'s `checkExecutionContexts` (`validator.ts:54-65`) requires every step's `executionContext` to be declared here — the `diagnosis_action` step's `executionContext` must be `'service_status_read'`. The empty `capabilities: []` is what makes the spec's "no new capabilities to register" true (`checkManifestCapabilities`, `validator.ts:217-230`); it is the existing pattern in `ceph/etcd/flink/kafka/kubernetes` manifests. Finding `source` values `service_status_page` / `service_reachability` **and** `checkId` values from `SERVICE_STATUS_CHECK_IDS` — health signals and diagnosis findings must carry these as `checkId`; that is the entire attachment contract (see Task 8 finding 4: `attachGuidesToScanFinding`/`attachGuidesToDiagnosis` already run over every finding and resolve guides purely from `checkId`, never from `source` — no new wiring code is needed anywhere, only that these findings set `checkId`).

- [ ] **Step 1: Backend + simulator.** Simulator states: `healthy`, `incident`, `degraded`, `down_for_you`, `status_unavailable` — each returns one fixed `ServiceStatusReport` (label "Stripe (simulated)") whose fields follow the Task 3 verdict table. `evaluateCheck`: `service_verdict` (compare worst verdict string), `unreachable_service_count` (count of `down_for_you`/`unreachable_*` verdicts), fail-closed default with the standard comment. `transition()` throws on invalid state (copy the vector-store simulator's guard).
- [ ] **Step 2: Failing plan tests — the pinned rule, written FIRST**

```ts
// src/__tests__/service-status-plan.test.ts — same harness shape as aws-s3-plan.test.ts
const cases = [
  { state: 'incident', scenario: 'dependency_incident' },
  { state: 'degraded', scenario: 'dependency_degraded' },
  { state: 'down_for_you', scenario: 'dependency_unreachable' },
  { state: 'status_unavailable', scenario: 'dependency_unreachable' },
  { state: 'healthy', scenario: 'no_finding' },
];
// it.each: diagnose -> plan -> expect(plan.metadata.scenario).toBe(scenario)
// -> validatePlan(plan, agent.manifest) -> failures list empty, valid true
```

Also assert: the healthy plan has `steps: []` (following the **aws-dynamodb** no-op shape, `src/agent/aws-dynamodb/agent.ts:102-118`, NOT vector-store — vector-store's healthy plan always emits its `diagnosis_action` step first, `src/agent/vector-store/agent.ts:200-214`, so it has one step, not zero; this plan deliberately differs from that pattern). The `no_finding` envelope MUST set `rollbackStrategy` — `checkRollbackStrategy` (`validator.ts:161-167`) fails an empty-steps plan without one; copy the wording style from `src/agent/vector-store/agent.ts:258-262`. Non-healthy plans contain NO `system_action` step (`plan.steps.every(s => s.type !== 'system_action')`) — the spec's suggestion-only guarantee as a test.

- [ ] **Step 3: Agent.** `assessHealth` from worst verdict (healthy → healthy; degraded_upstream/healthy_unverified → recovering; confirmed_incident/down_for_you/unreachable → unhealthy). `diagnose` findings per service from BOTH facts separately (one `service_status_page` finding carrying `checkId: SERVICE_STATUS_CHECK_IDS.statusPage`, one `service_reachability` finding carrying `checkId: SERVICE_STATUS_CHECK_IDS.reachability` — the honesty split at the findings layer), scenario = worst across services (`incident > degraded > unreachable > healthy`). `plan`: healthy → `no_finding` no-op envelope per Step 2's correction; otherwise `diagnosis_action` (re-capture reports, `executionContext: 'service_status_read'`) + `human_notification` whose summary names the worst service and states whose problem it is ("Stripe has a confirmed incident — this is not your bug"). Do **not** set `message.guideIds` on the notification step — `validatePlan`'s `checkGuideIds` (`validator.ts:136-158`, invoked inside `validatePlan` at `validator.ts:298`) rejects any `guideIds` entry that doesn't resolve via `getGuideById`, and the guide is not registered until Task 8; if the aws-rds pattern (`aws-rds/agent.ts:927`, `guideIds: [guide.id]`) were followed here, Task 6's own pinned `validatePlan` tests would fail before Task 8 ever runs. Guidance reaches the user through the finding's `checkId`, not through the plan step. OfflineGate short-circuit in `assessHealth`/`diagnose` exactly as llm-provider does.
- [ ] **Step 4: live-client** — constructor takes `ServiceTarget[]`; `queryServices()` = `checkServices(targets)`. Same `evaluateCheck` as simulator (fail-closed).
- [ ] **Step 5: `src/cli/service-targets.ts` + registration + builtin-agents + target assembly.** `TargetConfig`/`ResolvedTarget` (`src/config/schema.ts:101-124,165-197`) only have typed per-kind fields (`aws`, `queue`, `configDrift`, `iac`, `llm`) and `resolveTarget` (`src/config/resolve.ts:15-29`) copies them field-by-field — a new field would silently vanish unless added there too, so do NOT add a schema field. Instead, `serviceTargetsFromConfig` synthesizes each configured service as `{ name: <service id>, kind: 'service-status', primary: { host: <probe host>, port: <port> } }` — no schema change needed. `primary` is **mandatory**: `src/config/live-registration.ts:38` treats `!target.primary || target.primary.host === 'simulator'` as a simulator target, and `resolve.ts:20`'s `target.primary ?? { host: 'aws', port: 0 }` fallback would otherwise silently stamp a bogus host. The live client re-resolves the catalog entry from `target.name` via `resolveCatalogEntry`. Call `serviceTargetsFromConfig` from both `runScan`'s assembly and `loadConfigWithLocalTargets` per Files above.
  Scan visibility: `buildVisibilityReport` (`src/cli/visibility.ts:41-74`) has no per-target granularity — it loops `for (const kind of ranKinds)` and pushes exactly one entry per **kind**, so all configured services collapse into a single `service-status` watching entry regardless of how many are configured. Build one watching entry whose `detail` enumerates the configured services and annotates raw domains, e.g. `watching stripe, github, api.myvendor.com (reachability only)` — construct that detail string where `ranKinds` is assembled in `runScan` and pass it through the same path `derivedNote` uses (`visibility.ts:70-74`). Do not attempt per-service visibility rows; that would require extending `buildVisibilityReport` itself, out of scope here.
- [ ] **Step 6: Run all new/extended test files → PASS; typecheck.** Run a real `npx tsx src/cli/index.ts scan` with a scratch crisismode.yaml containing `services: [github]` and confirm the section renders (live network fine).
- [ ] **Step 7: Commit** — `feat(service-status): scan agent over configured third-party services`

---

### Task 7: Triage enrichment

**Files:**
- Modify: `src/cli/commands/triage.ts`
- Test: extend the existing triage command test file (find it: grep `triage` in `src/__tests__`)

**Interfaces:**
- `TriageCommandOptions` (`triage.ts:23-25`) is currently just `{ configPath?: string | undefined }`, and `runTriageCommand` (`triage.ts:136`) has no injection seam — adding one is a public-signature change to an exported function with an existing caller (`src/cli/index.ts:186-191`) and existing tests. Extend `TriageCommandOptions` with `checkServices?: typeof checkServices` and `loadServices?: () => ServiceConfigEntry[]`; `runTriageCommand` defaults them to the real implementations. The test file is `src/__tests__/triage-cli.test.ts` — its harness is `vi.hoisted` (line 17), `vi.mock('../framework/triage.js')` (line 46), `vi.mock('../cli/autodiscovery.js')` (line 34), and `vi.spyOn(console, 'log')` (line 142); extend that harness, do not build a new one.

- [ ] **Step 1: Failing tests**: with verdict `remote` and configured services, a fake checker returning one `incident_reported` service → output contains `GitHub's status page reports an incident:` plus the incident title; verdict line and exit code UNCHANGED (assert both against a no-services run). With verdict `local` → checker not called. All services operational → no extra lines. Checker deps injectable via the new `TriageCommandOptions` fields above.
- [ ] **Step 2 Implement**: after verdict synthesis in the command (NOT in `src/framework/triage.ts` — it stays pure), when verdict `remote`/`mixed` and `services:` configured: `checkServices` with `probeImpl` overridden to a no-op returning `'reachable'` (spec: skip probes, status fetch only — triage already probed) and a shared 1500ms deadline. Append one line per non-operational service.
- [ ] **Step 3: Run → PASS; typecheck; commit** — `feat(triage): name the culprit — status-page enrichment for remote verdicts`

---

### Task 8: Remediation guide

**Files:**
- Create: `src/framework/guidance/guides/service-status.ts`; register in `src/framework/guidance/registry.ts`'s aggregate (`registry.ts:11-16` import list, `registry.ts:18-24` `REMEDIATION_GUIDES` spread)
- Modify: `src/__tests__/guidance-registry.test.ts` — import `SERVICE_STATUS_CHECK_IDS` from Task 6's `src/agent/service-status/check-ids.js` and spread `...Object.values(SERVICE_STATUS_CHECK_IDS)` into `knownFindingTypes` (`guidance-registry.test.ts:345-351`); without this the anchoring test (`guidance-registry.test.ts:353-363`) fails immediately, since `knownFindingTypes` is a hardcoded set built from `allRules` plus each agent's exported `*_CHECK_IDS`, not derived automatically.
- Test: existing enforcement suites (`guidance-registry.test.ts`) must stay green after the modification above — they enforce anchoring + freshness, but only once the new agent's ids are added to the known set; nothing does that automatically.

- [ ] **Step 1: Write the guide.** Create `src/framework/guidance/guides/service-status.ts` exporting `serviceStatusGuides: readonly RemediationGuide[]` with one guide:
  - `id: 'dependency-incident-response'`
  - `platform: 'status-page'` — `platform` is a **required non-empty string** on `RemediationGuide` (`packages/agent-sdk/src/types/remediation-guide.ts:15`, no `?`), asserted non-empty at `guidance-registry.test.ts:64` (`expect(g.platform.length, ...).toBeGreaterThan(0)`). `platform: undefined` is not an option for a guide — do not attempt it.
  - `applicableFindingTypes: [SERVICE_STATUS_CHECK_IDS.statusPage, SERVICE_STATUS_CHECK_IDS.reachability]` (from Task 6's `check-ids.ts`) — anchored to the agent's actual `checkId`s, not scenario names, so the anchoring test (above) passes and `attachGuidesToScanFinding`/`attachGuidesToDiagnosis` (`src/framework/guidance/attach.ts:69,94`) — which resolve guides purely from a finding's `checkId`, never from `source` — can find it. No attachment wiring is needed anywhere: `src/cli/output.ts:545` already runs every scan finding through `attachGuidesToScanFinding`, and `output.ts:188` does the same for diagnosis; the whole contract is that Task 6's findings set `checkId` to one of these values.
  - `consoleSteps`, `expectedAfter`, `url` per the spec's content list: check the provider's status page / subscribe to updates; don't ship debugging changes against an upstream outage; check your app's error handling for the failing dependency; note the incident-history URL.
  - `verifiedOn: '2026-08-08'` (passes both freshness tests at `guidance-registry.test.ts:305-336`; content is generic — no console path to walk, but it still enters the walkthrough checklist on next regeneration).

  **Do not touch `src/framework/guidance/platforms.ts`.** `platformsForTarget` already returns `undefined` for any kind it does not special-case (`platforms.ts:56-57`, the "everything else" fallback), and an `undefined` scope means "attach every match" (`inScope`, `registry.ts:53-56`) — so the guide is visible on `service-status` targets with zero changes there. This is where the plan's "universal visibility" refinement (Global Constraints) actually comes from — NOT from `platform: undefined` on the guide, which the type forbids. Add one regression test beside the existing postgres case (`guidance-registry.test.ts:163-165`): `expect(platformsForTarget('service-status', 'stripe')).toBeUndefined();` — this pins the fall-through so a later `service-status`-specific branch returning `[]` can't silently kill the guide.

  Register the guide: add `import { serviceStatusGuides } from './guides/service-status.js';` at `registry.ts:11-16` and spread it into `REMEDIATION_GUIDES` (`registry.ts:18-24`).

  Adding an entry to `expectedIdsByPlatform` (`guidance-registry.test.ts:242-253`) is optional; skip it.

- [ ] **Step 2: Run guidance suites** (`npx vitest run src/__tests__/guidance-registry.test.ts src/__tests__/guidance-render.test.ts src/__tests__/guidance-output.test.ts`) → green. No attachment call sites to wire — the generic `attachGuidesToScanFinding`/`attachGuidesToDiagnosis` path (see Step 1) already covers this guide once `knownFindingTypes` includes `SERVICE_STATUS_CHECK_IDS` (Files, above) and Task 6's findings carry the right `checkId`s.
- [ ] **Step 3: Commit** — `feat(guidance): dependency-incident guide anchored to service-status findings`

---

### Task 9: Live catalog validation

**Files:**
- Create: `src/__tests__/service-status-live.test.ts` (env-gated)
- Modify: `src/framework/service-status/catalog.ts` (corrections from live results)

- [ ] **Step 1: Write the gated suite**: `describe.skipIf(!process.env.CRISISMODE_LIVE_TESTS)('catalog live validation', ...)` — for every catalog entry, fetch `statusUrl` (10s timeout, sequential is fine) and assert `parseStatuspageSummary` returns non-null; probe `probeHost:443` and assert not `dns_failed`.
- [ ] **Step 2: Run it LIVE**: `CRISISMODE_LIVE_TESTS=1 npx vitest run src/__tests__/service-status-live.test.ts`. For every failure: find the correct official status URL (the provider's status page footer usually links `/api/v2/summary.json`; verify with a direct fetch), correct the catalog, re-run. **An entry that cannot be verified is REMOVED, with a code comment naming what was tried** (spec honesty rule 4). Record the final pass list in your task report. Entries most likely to fail verification, flagged in advance: `resend-status.com`, `neonstatus.com`, `status.flyio.net`, `www.planetscalestatus.com`, `status.upstash.com`.
- [ ] **Step 2b: Flip the maturity label if needed.** If any catalog entry was removed in Step 2, or the live run did not complete (skipped, partial, or errored out for a reason other than a bad URL), set the manifest's `metadata.plugin.maturity` to `simulator_only` in `src/agent/service-status/manifest.ts` and say so in the task report. `live_validated` (`src/framework/agent-maturity.ts:49`, `agentMaturity()`) is only permitted when every shipped catalog entry passed live validation in this run — Task 6's manifest must not default to `live_validated` speculatively.
- [ ] **Step 3: Confirm the default suite still skips it** (`npx vitest run src/__tests__/service-status-live.test.ts` without the env var → skipped).
- [ ] **Step 4: Commit** — `test(service-status): live catalog validation (env-gated) + verified catalog corrections`

---

### Task 10: Docs

**Files:**
- Modify: `README.md` (`down` command + exit codes + `services:` config example, mirroring the triage section's format), `CLAUDE.md` (CLI table row for `down`; Key Files rows for `src/framework/service-status/` and `src/agent/service-status/`; agent list row)

- [ ] **Step 1: Write the docs** — copy the formats already used for triage (README) and existing agents (CLAUDE.md). The README example must be copy-pasteable: a `services:` block with one catalog id and one raw domain (with no `targets:` block), and a `crisismode down stripe github` invocation with sample output. This is loadable as of Task 4's Step 3 fix (a config needs at least one of `targets`/`services`, not both) — do not add a dummy `targets:` block to make the example load.
- [ ] **Step 2: `pnpm run typecheck && pnpm run lint`.** ESLint's flat config here is JS/TS only, not markdown — run the commands anyway, they are cheap.
- [ ] **Step 3: Commit** — `docs: crisismode down, services config, service-status agent`

---

## Self-review notes (already applied)

- Spec coverage: catalog (T2/T9), checker semantics + honesty rules as tests (T3), config (T4), down command + exit codes (T5), agent + pinned rule + fail-closed + visibility (T6), triage enrichment (T7), guide (T8), live validation + maturity honesty (T9), docs (T10). Statuspage extraction (T1). Maturity labels: T9 Step 2b sets the manifest's `metadata.plugin.maturity` to `simulator_only` unless every shipped catalog entry passed T9's live run — T6 does not default it to `live_validated` speculatively.
- Type consistency: `ServiceStatusReport`/`ServiceVerdict`/`StatusAssessment` defined once in T1, consumed by name everywhere; `ServiceTarget`/`CheckerDeps` defined in T3 and consumed by T5/T6/T7; `SERVICE_STATUS_CHECK_IDS` defined once in T6 (`check-ids.ts`), consumed by T6's own findings, T8's guide, and T8's `guidance-registry.test.ts` edit.
- Judgment points that were previously left open are now resolved directly in the task text rather than deferred: the config→targets assembly is a named shared helper (T6 Step 5, `src/cli/service-targets.ts`, called from both scan and watch) instead of "find where"; the guide's platform/anchoring mechanics are fully specified (T8 Step 1) instead of conditioned on what the implementer finds when reading the type. The one remaining deliberate judgment point is T4 Step 1's instruction to read `loader.ts` end-to-end before adding the `services` validation, which is a directed read, not an open design choice.
