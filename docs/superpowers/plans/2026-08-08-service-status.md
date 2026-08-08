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
- Concurrency: services checked 5 at a time (`CHECK_CONCURRENCY = 5`); status fetch and probe for one service run in parallel.
- **Pinned series rule:** every scenario string `plan()` can emit MUST be in the manifest's `failureScenarios` and covered by a real `validatePlan` test (import from `src/framework/validator.js`, one `it.each` case per scenario, plan built through the real agent + simulator).
- `evaluateCheck` fails CLOSED (`return false`) on unmatched statements in BOTH backends from day one, with the standard comment (copy from `src/agent/llm-provider/simulator.ts`).
- Honesty rules from the spec are binding: `status_unavailable` is never presented as an outage; raw domains labeled "reachability only"; OfflineGate short-circuits everything; `down_for_you` wording hedges ("likely your network, DNS, or config").
- **Plan-level refinements of the spec (deliberate, do not "fix" back):** (1) the probe is DNS resolve + plain TCP connect — exact parity with `triage-probes.ts`'s `connectTcp`; no TLS handshake (cert problems are the tls agent's job). (2) Agent targets use the single registered kind `service-status` with the service id carried in the target name/options — per-id dotted kinds would require static registrations for config-driven ids, which the registry cannot do; the guide in Task 8 uses platform `undefined` (generic content), so no platform-scoping is lost.
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
- Consumes: nothing new. The function being moved is `parseStatuspageIncidents(body: unknown): ProviderIncident[] | null` in `src/agent/llm-provider/live-client.ts:193-206` — read it first; its behavior (filter `resolved`/`postmortem`, map to `{title, impact, url?}`) must be preserved bit-for-bit.
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
  // ...moved verbatim from src/agent/llm-provider/live-client.ts:193-206...
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

- [ ] **Step 5: Rewire llm-provider** — delete the local function from `live-client.ts`, add `import { parseStatuspageIncidents } from '../../framework/service-status/statuspage.js';`. `ProviderIncident` is structurally identical to `StatusIncident`; find where `ProviderIncident` is declared (grep `interface ProviderIncident`) and replace the declaration with `export type ProviderIncident = StatusIncident;` (re-export alias, keeping every existing import path working).

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
- Consumes: Task 1 types + parser, Task 2 catalog, `OfflineGate`/`defaultOfflineGate` from `src/agent/llm-provider/offline-gate.js` (import, do not copy), `connectTcp` pattern from `src/framework/triage-probes.ts:308-350` (read it; reimplement locally with the same semantics — triage-probes' function is module-private; do NOT export it from there, its file is frozen built-ins).
- Produces:

```ts
export interface ServiceTarget { id: string; host?: string; port?: number }
export interface CheckerDeps {
  fetchImpl?: typeof fetch;
  probeImpl?: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
  offlineGate?: OfflineGate;
  statusTimeoutMs?: number;   // default STATUS_TIMEOUT_MS = 1500
  probeTimeoutMs?: number;    // default PROBE_TIMEOUT_MS = 1500
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
- `checkServices` with 12 targets and an instrumented probe that records concurrent-in-flight count → max ≤ `CHECK_CONCURRENCY`.
- `down_for_you` detail contains "likely your network, DNS, or config" (honesty rule 5 as a test).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Key points:
  - `resolveTarget`: string → `resolveCatalogEntry()` first; hit → `{id: entry.id, entry}`; miss → treat as domain `{id: input, host: input, port: 443}`. Object form → `{id: host, host, port: port ?? 443}`.
  - Default probe: `dns.lookup(host)` (node:dns/promises) — failure → `'dns_failed'`; then `net.createConnection({host, port})` with a `performance.now()`-based timeout race, destroy socket on settle — mirror `triage-probes.ts` `connectTcp`'s event handling (connect/error/timeout) exactly.
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
- Produces: `export type ServiceConfigEntry = string | { host: string; port?: number };` and `services?: ServiceConfigEntry[]` on the site-config interface (find the top-level config interface in `schema.ts` — grep `interface.*Config` for the one the loader returns — and add the optional field there).

- [ ] **Step 1: Read `src/config/loader.ts`** end to end to find where other top-level sections are validated; follow that exact pattern (hand-rolled checks + plain-language error messages; zod is present but unused — do NOT introduce it).
- [ ] **Step 2: Failing tests** (drive the loader with inline YAML strings, following however existing loader tests build configs — grep `src/__tests__` for the loader's test file and mirror its harness):
  - valid: catalog id, alias, raw domain, `{host, port}` long form → parsed into the config object unchanged.
  - invalid: `https://stripe.com` (scheme), `foo/bar` (path), `has space`, `{host: 'x', port: 0}`, `{port: 443}` (missing host) → validation error whose message lists at least three valid catalog ids (assert `.toMatch(/github/)`).
- [ ] **Step 3: Implement validation**: strings must satisfy `resolveCatalogEntry(s) !== undefined || /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s)`; long form requires non-empty host matching the same regex and integer port 1-65535.
- [ ] **Step 4: Run → PASS; typecheck; commit** — `feat(config): services list for third-party dependency checks`

---

### Task 5: `crisismode down` command

**Files:**
- Create: `src/cli/commands/down.ts`
- Modify: `src/cli/index.ts` (register command + help), `src/cli/commands/completions.ts` or wherever the completions command enumerates subcommands (grep `triage` there and add `down` everywhere it appears)
- Test: `src/__tests__/down-command.test.ts`

**Interfaces:**
- Consumes: Task 3 checker (inject `CheckerDeps` for tests), Task 4 config (`services` list via however commands load site config — read `src/cli/commands/triage.ts` FIRST and mirror its structure: arg parsing, output-mode handling, exit-code contract, `--terse`).
- Produces: `runDownCommand(args: string[], deps?: CheckerDeps & { loadConfig?: ... }): Promise<number>` (returns exit code; `index.ts` passes it to `process.exitCode`).

- [ ] **Step 1: Failing tests** (inject fake checker deps; capture stdout the way `triage`'s command tests do — find and mirror them):
  - `down stripe` with fake reports → human output contains the verdict line and incident title; exit 1 for `confirmed_incident`.
  - all-healthy → exit 0. `healthy_unverified`/`healthy_probe_only` → exit 0.
  - `down_for_you` present → exit 1 AND output suggests `crisismode triage`.
  - bare `down` with no configured services → exit 0, output contains both usage forms (`crisismode down <service>` and `services:`), and is NOT an error.
  - bare `down` with configured services → checks exactly those.
  - unknown flag → exit 2.
  - `--json` → one JSON object per service (parse each line), each with `id`, `verdict`, `statusAssessment`, `probe`, `detail`.
  - pipe mode (non-TTY): tab-separated `id verdict statusAssessment probe detail`, no ANSI.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `deps.statusTimeoutMs`/`probeTimeoutMs` set to the interactive ceiling `3500` (constant `DOWN_TIMEOUT_MS = 3500`). Human output: severity emoji per verdict (reuse `src/cli/status-presentation.ts` mappings where they fit; do not invent new emoji conventions), verdict `detail` from the checker verbatim, incident titles indented beneath. `--terse` drops explanation lines, keeps verdicts.
- [ ] **Step 4: Run → PASS; typecheck; run the real CLI once** (`npx tsx src/cli/index.ts down --help` and `npx tsx src/cli/index.ts down github` — live network OK here, just confirm no crash either way).
- [ ] **Step 5: Commit** — `feat(cli): crisismode down — is it down for everyone, or just me?`

---

### Task 6: service-status agent

**Files:**
- Create: `src/agent/service-status/backend.ts`, `simulator.ts`, `live-client.ts`, `manifest.ts`, `agent.ts`, `registration.ts`
- Modify: `src/config/builtin-agents.ts` (register), plus wherever config-declared targets get assembled into scan targets (grep `services` won't exist yet — find how `targets:` entries in crisismode.yaml become scan targets, likely `src/cli/autodiscovery.ts` or the scan command's config assembly, and add: each configured service becomes one target of kind `service-status`, name = service id, options carrying the resolved `ServiceTarget`)
- Test: `src/__tests__/service-status-plan.test.ts`, `src/__tests__/service-status-agent.test.ts`; extend `src/__tests__/simulator-evaluate-check.test.ts` and `src/__tests__/live-client-evaluate-check.test.ts` with the new backends' unmatched-statement cases

**Interfaces:**
- Consumes: Tasks 1-4. Read `src/agent/llm-provider/` (agent shape, OfflineGate usage in `agent.ts:60-90`) and `src/agent/vector-store/` (simulator state pattern, `no_finding` mapping) before writing anything.
- Produces: `ServiceStatusBackend extends ExecutionBackend` with `queryServices(): Promise<ServiceStatusReport[]>`; manifest kind `service-status`, `maxRiskLevel: 'routine'`, `failureScenarios: ['dependency_incident', 'dependency_degraded', 'dependency_unreachable', 'no_finding']`; finding sources `service_status_page`, `service_reachability`.

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

Also assert: the healthy plan has `steps: []`; non-healthy plans contain NO `system_action` step (`plan.steps.every(s => s.type !== 'system_action')`) — the spec's suggestion-only guarantee as a test.

- [ ] **Step 3: Agent.** `assessHealth` from worst verdict (healthy → healthy; degraded_upstream/healthy_unverified → recovering; confirmed_incident/down_for_you/unreachable → unhealthy). `diagnose` findings per service from BOTH facts separately (one `service_status_page` finding, one `service_reachability` finding — the honesty split at the findings layer), scenario = worst across services (`incident > degraded > unreachable > healthy`). `plan`: healthy → `no_finding` no-op envelope (mirror aws-dynamodb's guard); otherwise `diagnosis_action` (re-capture reports) + `human_notification` whose summary names the worst service and states whose problem it is ("Stripe has a confirmed incident — this is not your bug"). OfflineGate short-circuit in `assessHealth`/`diagnose` exactly as llm-provider does.
- [ ] **Step 4: live-client** — constructor takes `ServiceTarget[]`; `queryServices()` = `checkServices(targets)`. Same `evaluateCheck` as simulator (fail-closed).
- [ ] **Step 5: registration + builtin-agents + target assembly** per Files above; scan visibility: confirm configured services appear in the "What CrisisMode can see" section (find where other agents feed visibility and mirror; raw domains get the "reachability only" annotation).
- [ ] **Step 6: Run all new/extended test files → PASS; typecheck.** Run a real `npx tsx src/cli/index.ts scan` with a scratch crisismode.yaml containing `services: [github]` and confirm the section renders (live network fine).
- [ ] **Step 7: Commit** — `feat(service-status): scan agent over configured third-party services`

---

### Task 7: Triage enrichment

**Files:**
- Modify: `src/cli/commands/triage.ts`
- Test: extend the existing triage command test file (find it: grep `triage` in `src/__tests__`)

- [ ] **Step 1: Failing tests**: with verdict `remote` and configured services, a fake checker returning one `incident_reported` service → output contains `GitHub's status page reports an incident:` plus the incident title; verdict line and exit code UNCHANGED (assert both against a no-services run). With verdict `local` → checker not called. All services operational → no extra lines. Checker deps injectable like the down command.
- [ ] **Step 2 Implement**: after verdict synthesis in the command (NOT in `src/framework/triage.ts` — it stays pure), when verdict `remote`/`mixed` and `services:` configured: `checkServices` with `probeImpl` overridden to a no-op returning `'reachable'` (spec: skip probes, status fetch only — triage already probed) and a shared 1500ms deadline. Append one line per non-operational service.
- [ ] **Step 3: Run → PASS; typecheck; commit** — `feat(triage): name the culprit — status-page enrichment for remote verdicts`

---

### Task 8: Remediation guide

**Files:**
- Create: `src/framework/guidance/guides/service-status.ts`; register in `src/framework/guidance/registry.ts`'s aggregate
- Test: existing enforcement suites (`guidance-registry.test.ts`) must stay green — they enforce anchoring + freshness automatically

- [ ] **Step 1: Write the guide**: id `dependency-incident-response`, `platform: undefined` is NOT allowed if the registry type requires platform — read `packages/agent-sdk/src/types/remediation-guide.ts` first; if platform is required, use a generic platform value the scoping treats as always-shown (check `guidesForFindingTypes` three-case semantics: guides whose `platform` is undefined show for all — the TYPE marks platform required or optional; follow what the type says and what the scoping code does, and if both force a choice add platform `'generic'` to `platformsForTarget`'s always-include path with a test). `applicableFindingTypes: ['service-status.dependency_incident', 'service-status.dependency_degraded']` — anchored to the agent's finding types so the enforcement test passes. Steps: check the provider's status page / subscribe to updates; don't ship debugging changes against an upstream outage; check your app's error handling for the failing dependency; note the incident-history URL. `verifiedOn: '2026-08-08'` (content is generic — no console path to walk; still enters the walkthrough checklist on next regeneration).
- [ ] **Step 2: Run guidance suites** (`npx vitest run src/__tests__/guidance-registry.test.ts src/__tests__/guidance-render.test.ts src/__tests__/guidance-output.test.ts`) → green, fixing anchoring until the enforcement tests accept it. Wire attachment for the agent's findings the same way aws-rds attaches (grep `attachGuides` call sites).
- [ ] **Step 3: Commit** — `feat(guidance): dependency-incident guide anchored to service-status findings`

---

### Task 9: Live catalog validation

**Files:**
- Create: `src/__tests__/service-status-live.test.ts` (env-gated)
- Modify: `src/framework/service-status/catalog.ts` (corrections from live results)

- [ ] **Step 1: Write the gated suite**: `describe.skipIf(!process.env.CRISISMODE_LIVE_TESTS)('catalog live validation', ...)` — for every catalog entry, fetch `statusUrl` (10s timeout, sequential is fine) and assert `parseStatuspageSummary` returns non-null; probe `probeHost:443` and assert not `dns_failed`.
- [ ] **Step 2: Run it LIVE**: `CRISISMODE_LIVE_TESTS=1 npx vitest run src/__tests__/service-status-live.test.ts`. For every failure: find the correct official status URL (the provider's status page footer usually links `/api/v2/summary.json`; verify with a direct fetch), correct the catalog, re-run. **An entry that cannot be verified is REMOVED, with a code comment naming what was tried** (spec honesty rule 4). Record the final pass list in your task report.
- [ ] **Step 3: Confirm the default suite still skips it** (`npx vitest run src/__tests__/service-status-live.test.ts` without the env var → skipped).
- [ ] **Step 4: Commit** — `test(service-status): live catalog validation (env-gated) + verified catalog corrections`

---

### Task 10: Docs

**Files:**
- Modify: `README.md` (`down` command + exit codes + `services:` config example, mirroring the triage section's format), `CLAUDE.md` (CLI table row for `down`; Key Files rows for `src/framework/service-status/` and `src/agent/service-status/`; agent list row)

- [ ] **Step 1: Write the docs** — copy the formats already used for triage (README) and existing agents (CLAUDE.md). The README example must be copy-pasteable: a `services:` block with one catalog id and one raw domain, and a `crisismode down stripe github` invocation with sample output.
- [ ] **Step 2: `pnpm run typecheck && pnpm run lint`** (lint covers markdown-adjacent files via repo config? — run it regardless; it is cheap).
- [ ] **Step 3: Commit** — `docs: crisismode down, services config, service-status agent`

---

## Self-review notes (already applied)

- Spec coverage: catalog (T2/T9), checker semantics + honesty rules as tests (T3), config (T4), down command + exit codes (T5), agent + pinned rule + fail-closed + visibility (T6), triage enrichment (T7), guide (T8), live validation + maturity honesty (T9), docs (T10). Statuspage extraction (T1). Maturity labels: set `live_validated` on the live-client's capability descriptor in T6 ONLY IF T9's live run passed — T9's implementer must flip it if validation was skipped or partial (add this check to T9 Step 2).
- Type consistency: `ServiceStatusReport`/`ServiceVerdict`/`StatusAssessment` defined once in T1, consumed by name everywhere; `ServiceTarget`/`CheckerDeps` defined in T3 and consumed by T5/T6/T7.
- Known judgment points left to implementers deliberately: exact config-loader harness (T4 Step 1 reads it first), target-assembly location (T6 Step 5 finds it), guide platform mechanics (T8 Step 1 reads the type first). Each names the file to read — not a placeholder, a directed read.
