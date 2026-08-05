# Offline Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deterministic, dependency-free localization pass — "is it me, my network, or them?" — as a `crisismode triage` command and as step 0 of `crisismode scan`.

**Architecture:** A new framework module `src/framework/triage.ts` holds the layer model, pure layer builders, a pure verdict-synthesis function, and a `runTriage()` orchestrator that runs every probe behind an injectable `TriageProbes` interface with a hard per-probe timeout. A sibling `src/framework/triage-probes.ts` holds the only code that touches the real machine (Node built-ins: `node:os`, `node:dns/promises`, `node:net`, `node:child_process`, `node:fs`, global `fetch`). The CLI command `src/cli/commands/triage.ts` renders the report in human/pipe/machine modes and sets the exit code. Scan calls `runTriage()` as step 0 with 800ms probes and reframes unreachable-service findings through `src/cli/observer-reframe.ts`. After its layers run, triage writes its DNS/internet results into the cached `NetworkProfile` singleton so `ai-summary.ts` and `environment-guard.ts` see consistent state.

**Tech Stack:** TypeScript 7 (strict, ESM/NodeNext), Node built-ins only, vitest, chalk (already a dependency, used only through `src/cli/output.ts`).

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero new package.json dependencies.** Node built-ins only: `node:dns`/`node:dns/promises`, `node:net`, `node:os`, `node:fs`, `node:child_process` (fixed, argument-free route-table reads only), `node:util`, and global `fetch`. No user-influenced input may reach a subprocess.
- **TypeScript strict + ESM NodeNext:** every relative import ends in `.js` (e.g. `import { runTriage } from '../framework/triage.js'`). Type-only imports use `import type` (`verbatimModuleSyntax` is on).
- **`exactOptionalPropertyTypes: true`** — declare optional properties as `foo?: T | undefined`, and build objects with conditional spreads (`...(x !== undefined ? { x } : {})`) when the property must be absent.
- **`noUncheckedIndexedAccess: true`** — indexing an array yields `T | undefined`. Use `?.`, `??`, or (in tests only) `!`.
- **Named exports only.** No default exports (enforced by ESLint `no-restricted-syntax`).
- **Every new file starts with:**
  ```ts
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **Verdict type is pinned:** `export type TriageVerdict = 'local' | 'network' | 'remote' | 'mixed' | 'healthy';`
- **Module paths are pinned:** `src/framework/triage.ts`, `src/cli/commands/triage.ts`.
- **Exit codes are pinned:** `0` for `healthy` and `remote`; `1` for `local`, `network`, and `mixed`.
- **Timeouts:** default per-probe hard timeout **1000ms** (`DEFAULT_PROBE_TIMEOUT_MS`); scan's step 0 uses 800ms; the whole run is bounded by an explicit monotonic deadline of **5000ms** (`TRIAGE_DEADLINE_MS`), which is a tested property, not an aspiration.
- **Every probe must bound itself from the inside, through one shared helper.** An outer `Promise.race` cannot cancel work — a raced-out DNS query keeps the event loop alive after the report prints. All bounded execution goes through `runBounded()` in `src/framework/triage-probes.ts` (timeout + optional cancel + `try/finally`), used by triage's probes, `runTriage`'s outer backstop, and `network-profile.ts`. Two hand-maintained copies of this machinery is what let one path ship unbounded.
- **Escalation level for triage is Diagnose (level 2)** — triage makes read-only queries against live third-party endpoints.
- **Every probe failure is a data point, never a thrown error.** A probe that errors or times out records `unknown` for its layer. No probe writes anything anywhere.
- **Tests:** vitest. Single file: `pnpm vitest run src/__tests__/<file>.test.ts`. Full suite: `pnpm test`. Typecheck: `pnpm run typecheck`. Lint: `pnpm run lint`.
- **Commits:** Conventional Commits, scope `triage` (e.g. `feat(triage): add verdict synthesis`). Commit at the end of every task. Do **not** create branches — work on the current branch (`docs/reliability-first-specs`).
- **TDD:** failing test first, run it to watch it fail, minimal implementation, run it to watch it pass, commit.

## Deliberate Additions Beyond the Spec

Four things in this plan are not in `2026-08-05-offline-triage-design.md`. They are intentional, and a reviewer should read them as decisions rather than scope creep:

1. **The triage report cache** — `getTriageReport(): TriageReport | null`, `resetTriageReport()`, and `TriageOptions.cacheResults` (Task 8). This is a **pinned cross-PR contract**: PR 3's llm-provider agent and PR 5 read the verdict from inside `assessHealth()` to skip network checks when triage already blamed the observer, and they must not re-run probes to do it. Agreed with the PR 3 plan author; encoded there verbatim.
2. **The whole-run deadline** — `TRIAGE_DEADLINE_MS` (Task 7). The spec asserts "≤ ~5s" as an acceptance criterion but describes no mechanism; per-probe timeouts alone do not compose into a total bound.
3. **`ScanOptions.triageReport`** (Task 12) — an injection point so scan's step-0 wiring is testable without live network.
4. **Shared bounded-execution machinery** (Tasks 6 and 13) — the spec's `network-profile.ts` sharing clause, implemented rather than deferred. Sharing happens at the *bounded-execution* layer (`runBounded`, `probeTcpBounded`), **not** the resolution layer: `network-profile.ts`'s `probeDns` keeps using `lookup()`/getaddrinfo and triage's `boundedResolve` keeps using raw resolver queries, because they answer different questions (below).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/framework/triage.ts` (create) | Types, constants, pure layer builders, pure verdict synthesis, verdict explanation, `runTriage()` orchestration, `toNetworkProfile()` bridge. |
| `src/framework/triage-probes.ts` (create) | The only code that touches the real machine: observer-context detection, `nodeTriageProbes()` (interfaces, gateway route parsing, DNS, HTTP, TCP), and the shared bounded-execution primitives (`runBounded`, `probeTcpBounded`) that `triage.ts` and `network-profile.ts` both build on. |
| `src/framework/network-profile.ts` (modify) | Gains `setNetworkProfile()` (the write path triage uses), exports the previously private mode inference as `inferNetworkMode()`, and re-points its bounding and socket probes at the shared primitives — keeping its own `lookup()`-based DNS semantics (Task 13). |
| `src/cli/status-presentation.ts` (modify) | Gains `TRIAGE_VERDICT_COLOR` / `triageVerdictColor()`, keeping verdict → color in the codebase's single presentation-mapping source. |
| `src/cli/commands/triage.ts` (create) | `crisismode triage` — target resolution, human/pipe/machine rendering, exit code. |
| `src/cli/observer-reframe.ts` (create) | Decides which scan findings are observer-caused and builds the reframe. |
| `src/cli/output.ts` (modify) | `ScanFinding.possiblyObserverCaused`, `ScanResult.triage` / `ScanResult.observerReframe`, reframe rendering in `printScanSummary`, `printTriageContext()`. |
| `src/cli/commands/scan.ts` (modify) | Runs triage as step 0 and applies the reframe. |
| `src/cli/index.ts`, `src/cli/commands/completions.ts` (modify) | Command registration, help text, shell completions. |
| `README.md`, `CLAUDE.md` (modify) | Command tables, JSON output type, exit-code documentation. |

Test files: `src/__tests__/triage-verdict.test.ts`, `triage-layers.test.ts`, `triage-probes.test.ts`, `triage-run.test.ts`, `triage-cli.test.ts`, `observer-reframe.test.ts`.

---

### Task 1: Triage types and verdict synthesis

**Files:**
- Create: `src/framework/triage.ts`
- Test: `src/__tests__/triage-verdict.test.ts`

**Interfaces:**
- Consumes: `ProbeResult` from `@crisismode/agent-sdk` (`{ target: string; reachable: boolean; latencyMs: number; error?: string }`), `EscalationLevel` from `src/framework/escalation.ts`.
- Produces: every cross-task type — `TriageVerdict`, `TriageLayerName`, `TriageLayerStatus`, `TriageLayerCode`, `TriageLayerResult`, `ObserverContext`, `ObserverContextResult`, `TriageTarget`, `HttpProbeResult`, `InterfaceProbeResult`, `GatewayProbeResult`, `DnsProbeResult`, `TriageProbes`, `TriageReport` — plus the constants `DNS_TEST_HOST`, `PUBLIC_RESOLVERS`, `CAPTIVE_ENDPOINTS`, `INTERNET_PROBE_URLS`, `DEFAULT_PROBE_TIMEOUT_MS`, `SCAN_PROBE_TIMEOUT_MS`, `TRIAGE_DEADLINE_MS`, `TRIAGE_ESCALATION_LEVEL`, and the function `synthesizeVerdict(layers: TriageLayerResult[]): TriageVerdict`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/triage-verdict.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { synthesizeVerdict } from '../framework/triage.js';
import type { TriageLayerCode, TriageLayerName, TriageLayerResult, TriageLayerStatus } from '../framework/triage.js';

function layer(
  name: TriageLayerName,
  status: TriageLayerStatus,
  code?: TriageLayerCode,
): TriageLayerResult {
  return { layer: name, status, detail: `${name}:${status}`, code, durationMs: 1 };
}

const allPass: TriageLayerResult[] = [
  layer('interfaces', 'pass'),
  layer('gateway', 'pass'),
  layer('dns', 'pass'),
  layer('captive-portal', 'pass'),
  layer('internet', 'pass'),
  layer('targets', 'pass'),
];

function withLayer(base: TriageLayerResult[], replacement: TriageLayerResult): TriageLayerResult[] {
  return base.map((l) => (l.layer === replacement.layer ? replacement : l));
}

describe('synthesizeVerdict', () => {
  it('returns healthy when every layer passes', () => {
    expect(synthesizeVerdict(allPass)).toBe('healthy');
  });

  it('returns healthy when only the gateway is unknown', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('gateway', 'unknown', 'gateway-unknown')))).toBe('healthy');
  });

  it('returns local when no interface has an address', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('interfaces', 'fail', 'no-active-interface')))).toBe('local');
  });

  it('returns local when the system resolver is broken but public resolvers answer', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('dns', 'fail', 'resolver-broken')))).toBe('local');
  });

  it('returns network when no resolver answers', () => {
    const layers = withLayer(withLayer(allPass, layer('dns', 'fail', 'dns-unreachable')), layer('targets', 'fail', 'targets-unreachable'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns network for a captive portal', () => {
    const layers = withLayer(withLayer(allPass, layer('captive-portal', 'fail', 'captive-portal')), layer('targets', 'skipped'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns network when the internet layer fails with no reachable target', () => {
    const layers = withLayer(withLayer(allPass, layer('internet', 'fail', 'internet-unreachable')), layer('targets', 'skipped'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns mixed when a network layer fails but some target still answers', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('internet', 'fail', 'internet-unreachable')))).toBe('mixed');
  });

  it('returns remote when local and network layers pass but no target answers', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'fail', 'targets-unreachable')))).toBe('remote');
  });

  it('returns mixed when only some targets answer', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'fail', 'targets-partial')))).toBe('mixed');
  });

  it('returns mixed when a non-gateway layer could not be assessed', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('captive-portal', 'unknown')))).toBe('mixed');
  });

  it('returns healthy when targets were skipped and everything else passed', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'skipped')))).toBe('healthy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-verdict.test.ts`
Expected: FAIL — "Failed to resolve import ... src/framework/triage.ts".

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/triage.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Offline triage — "is it me, my network, or them?"
 *
 * When a stack is unreachable, the first question is not "what is wrong with
 * my services" but "is this my machine, my network, or the remote side?"
 * Triage answers that deterministically, with no internet and no LLM.
 *
 * Layers, each with a hard per-probe timeout:
 *   1. interfaces     — any non-loopback interface with an address?
 *   2. gateway        — default gateway address, context only (never probed,
 *                       never contributes to the verdict)
 *   3. dns            — system resolver, then public resolvers directly
 *   4. captive-portal — connectivity-check endpoints, per-endpoint expected
 *                       response (skipped in server environments)
 *   5. internet       — HTTPS HEAD to two well-known hosts
 *   6. targets        — TCP connect to discovered/configured targets
 *
 * Escalation level is Diagnose (2): triage makes read-only queries against
 * live third-party endpoints, which is more than Observe's no-interaction
 * contract. It never mutates anything.
 */

import type { ProbeResult } from '@crisismode/agent-sdk';
import type { EscalationLevel } from './escalation.js';

// ── Verdict and layer model ──

export type TriageVerdict = 'local' | 'network' | 'remote' | 'mixed' | 'healthy';

export type TriageLayerName =
  | 'interfaces'
  | 'gateway'
  | 'dns'
  | 'captive-portal'
  | 'internet'
  | 'targets';

export type TriageLayerStatus = 'pass' | 'fail' | 'skipped' | 'unknown';

/** Machine-stable reason code. Verdict synthesis reads only these, never prose. */
export type TriageLayerCode =
  | 'no-active-interface'
  | 'gateway-unknown'
  | 'resolver-broken'
  | 'dns-unreachable'
  | 'captive-portal'
  | 'internet-unreachable'
  | 'targets-unreachable'
  | 'targets-partial';

export interface TriageLayerResult {
  layer: TriageLayerName;
  status: TriageLayerStatus;
  /** One-line, operator-facing statement of what was observed. */
  detail: string;
  code?: TriageLayerCode | undefined;
  /** Plain-language next step. Present on failing layers. */
  nextStep?: string | undefined;
  /** Per-endpoint results, for layers that probe endpoints. */
  probes?: ProbeResult[] | undefined;
  durationMs: number;
}

// ── Observer context ──

export type ObserverContext = 'laptop' | 'server' | 'unknown';

export interface ObserverContextResult {
  context: ObserverContext;
  /** What the classification was based on. Best-effort, and says so. */
  evidence: string;
}

// ── Probe contracts (injectable for tests) ──

export interface TriageTarget {
  host: string;
  port: number;
  label: string;
}

export interface InterfaceProbeResult {
  /** Names of non-loopback interfaces that have an assigned address. */
  activeInterfaces: string[];
}

export interface GatewayProbeResult {
  /** Default gateway address, or null when it could not be determined. */
  address: string | null;
}

export interface DnsProbeResult {
  systemResolved: boolean;
  publicResolved: boolean;
  systemError?: string | undefined;
  publicError?: string | undefined;
}

export interface HttpProbeResult {
  /** HTTP status code, or null when the request never completed. */
  status: number | null;
  /** Response body, truncated to the first 256 characters. Empty for HEAD. */
  body: string;
  /** True when the response was a 3xx redirect. */
  redirected: boolean;
  latencyMs: number;
  error?: string | undefined;
}

export interface TriageProbes {
  listInterfaces(): Promise<InterfaceProbeResult>;
  findDefaultGateway(): Promise<GatewayProbeResult>;
  resolveDns(hostname: string): Promise<DnsProbeResult>;
  fetchUrl(url: string, method: 'GET' | 'HEAD'): Promise<HttpProbeResult>;
  connectTcp(host: string, port: number, label: string): Promise<ProbeResult>;
}

// ── Report ──

export interface TriageReport {
  verdict: TriageVerdict;
  /** Plain-language explanation of the verdict. */
  explanation: string;
  /** The single next step the operator should take. */
  nextStep: string;
  layers: TriageLayerResult[];
  observerContext: ObserverContext;
  observerContextEvidence: string;
  escalationLevel: EscalationLevel;
  checkedAt: string;
  durationMs: number;
}

// ── Constants ──

/** Same host network-profile.ts probes, so the two agree about DNS. */
export const DNS_TEST_HOST = 'api.anthropic.com';

export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'] as const;

export interface CaptiveEndpoint {
  url: string;
  expectedStatus: number;
  /** Substring the body must contain. An empty string means the body must be empty. */
  expectedBody: string;
}

/**
 * Per-endpoint expected responses. A bare "200 with a body" rule would
 * misclassify captive.apple.com, whose healthy response IS a 200 with a body.
 */
export const CAPTIVE_ENDPOINTS: readonly CaptiveEndpoint[] = [
  { url: 'http://connectivitycheck.gstatic.com/generate_204', expectedStatus: 204, expectedBody: '' },
  { url: 'http://captive.apple.com', expectedStatus: 200, expectedBody: 'Success' },
];

export const INTERNET_PROBE_URLS = ['https://api.anthropic.com', 'https://api.github.com'] as const;

/**
 * Per-probe hard timeout. Four probe stages (interfaces, gateway+DNS,
 * portal+internet, targets) run back to back, so this must stay at or below
 * TRIAGE_DEADLINE_MS / 4 for the deadline to be reachable without truncation.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/** Scan's step 0 runs tighter than the standalone command. */
export const SCAN_PROBE_TIMEOUT_MS = 800;

/**
 * Whole-run budget, measured from the first probe. Per-probe timeouts do not
 * compose into a total bound on their own, and the spec makes "≤ 5s offline"
 * an acceptance criterion — so the bound is explicit and tested.
 */
export const TRIAGE_DEADLINE_MS = 5_000;

/** Read-only queries against live systems. */
export const TRIAGE_ESCALATION_LEVEL: EscalationLevel = 2;

// ── Verdict synthesis (pure) ──

/**
 * Collapse layer results into one verdict.
 *
 * Precedence, highest first:
 *   1. no active interface            -> local
 *   2. system resolver broken         -> local
 *   3. dns/portal/internet failure    -> mixed when a target still answered,
 *                                        network otherwise
 *   4. some targets answered          -> mixed
 *   5. no target answered             -> remote
 *   6. any non-gateway layer unknown  -> mixed (we cannot claim healthy for a
 *                                        layer we could not assess)
 *   7. otherwise                      -> healthy
 *
 * The gateway layer is context only: it is reported but never changes the
 * verdict, because a gateway that does not answer an unprivileged probe is
 * not evidence of anything.
 */
export function synthesizeVerdict(layers: TriageLayerResult[]): TriageVerdict {
  const failed = new Set<TriageLayerCode>();
  for (const l of layers) {
    if (l.status === 'fail' && l.code !== undefined) failed.add(l.code);
  }

  if (failed.has('no-active-interface') || failed.has('resolver-broken')) return 'local';

  const targetsLayer = layers.find((l) => l.layer === 'targets');
  const someTargetAnswered =
    targetsLayer?.status === 'pass' || targetsLayer?.code === 'targets-partial';

  const networkFailed =
    failed.has('dns-unreachable') || failed.has('captive-portal') || failed.has('internet-unreachable');
  if (networkFailed) return someTargetAnswered ? 'mixed' : 'network';

  if (failed.has('targets-partial')) return 'mixed';
  if (failed.has('targets-unreachable')) return 'remote';

  if (layers.some((l) => l.layer !== 'gateway' && l.status === 'unknown')) return 'mixed';
  return 'healthy';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-verdict.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/__tests__/triage-verdict.test.ts
git commit -m "feat(triage): add triage layer model and verdict synthesis"
```

---

### Task 2: Verdict explanation and cause labels

**Files:**
- Modify: `src/framework/triage.ts` (append after `synthesizeVerdict`)
- Test: `src/__tests__/triage-verdict.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `TriageVerdict`, `TriageLayerResult`, `TriageLayerCode` (Task 1).
- Produces: `layerCauseLabel(code: TriageLayerCode): string`, `primaryFailureCode(layers: TriageLayerResult[]): TriageLayerCode | null`, `explainVerdict(verdict: TriageVerdict, layers: TriageLayerResult[]): TriageExplanation` where `TriageExplanation = { explanation: string; nextStep: string }`. `src/cli/observer-reframe.ts` (Task 11) uses `primaryFailureCode` + `layerCauseLabel`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-verdict.test.ts` (the `layer` helper defined at the top of the file is reused):

```ts
import { explainVerdict, layerCauseLabel, primaryFailureCode } from '../framework/triage.js';

describe('primaryFailureCode', () => {
  it('returns the first failing layer code in probe order', () => {
    const layers = [
      layer('interfaces', 'pass'),
      layer('dns', 'fail', 'dns-unreachable'),
      layer('internet', 'fail', 'internet-unreachable'),
    ];
    expect(primaryFailureCode(layers)).toBe('dns-unreachable');
  });

  it('ignores the gateway layer, which is context only', () => {
    const layers = [layer('gateway', 'fail', 'gateway-unknown'), layer('dns', 'fail', 'dns-unreachable')];
    expect(primaryFailureCode(layers)).toBe('dns-unreachable');
  });

  it('returns null when nothing failed', () => {
    expect(primaryFailureCode([layer('interfaces', 'pass')])).toBeNull();
  });
});

describe('explainVerdict', () => {
  it('names the local cause and offers a machine-level next step', () => {
    const layers = [layer('interfaces', 'pass'), { ...layer('dns', 'fail', 'resolver-broken'), nextStep: 'Fix this machine DNS settings.' }];
    const { explanation, nextStep } = explainVerdict('local', layers);
    expect(explanation).toContain('this machine');
    expect(explanation).toContain(layerCauseLabel('resolver-broken'));
    expect(nextStep).toBe('Fix this machine DNS settings.');
  });

  it('names the network cause', () => {
    const layers = [layer('captive-portal', 'fail', 'captive-portal')];
    const { explanation } = explainVerdict('network', layers);
    expect(explanation).toContain(layerCauseLabel('captive-portal'));
  });

  it('points remote verdicts at scan', () => {
    const { explanation, nextStep } = explainVerdict('remote', [layer('targets', 'fail', 'targets-unreachable')]);
    expect(explanation).toContain('did not answer');
    expect(nextStep).toContain('crisismode scan');
  });

  it('refuses to localize a mixed verdict', () => {
    const { explanation } = explainVerdict('mixed', [layer('captive-portal', 'unknown')]);
    expect(explanation).toContain('cannot');
  });

  it('says nothing is wrong for healthy', () => {
    const { explanation, nextStep } = explainVerdict('healthy', [layer('interfaces', 'pass')]);
    expect(explanation).toContain('look fine');
    expect(nextStep).toContain('crisismode scan');
  });

  it('has a label for every layer code', () => {
    const codes = [
      'no-active-interface', 'gateway-unknown', 'resolver-broken', 'dns-unreachable',
      'captive-portal', 'internet-unreachable', 'targets-unreachable', 'targets-partial',
    ] as const;
    for (const code of codes) {
      expect(layerCauseLabel(code).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-verdict.test.ts`
Expected: FAIL — `explainVerdict`, `layerCauseLabel`, `primaryFailureCode` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/triage.ts`:

```ts
// ── Verdict explanation (pure) ──

export interface TriageExplanation {
  explanation: string;
  nextStep: string;
}

const LAYER_CAUSE_LABEL: Record<TriageLayerCode, string> = {
  'no-active-interface': 'no active network interface on this machine',
  'gateway-unknown': 'the default gateway could not be determined',
  'resolver-broken': 'this machine\'s DNS resolver is not answering',
  'dns-unreachable': 'DNS is not resolving from this machine',
  'captive-portal': 'a captive portal (network sign-in page) is intercepting traffic',
  'internet-unreachable': 'this machine has no internet egress',
  'targets-unreachable': 'your services did not accept a connection',
  'targets-partial': 'some services answered and others did not',
};

/** Plain-language cause for a layer code. */
export function layerCauseLabel(code: TriageLayerCode): string {
  return LAYER_CAUSE_LABEL[code];
}

/**
 * The first failing layer's code in probe order — the cause we lead with.
 * The gateway layer is skipped: it is context, not evidence.
 */
export function primaryFailureCode(layers: TriageLayerResult[]): TriageLayerCode | null {
  for (const l of layers) {
    if (l.layer === 'gateway') continue;
    if (l.status === 'fail' && l.code !== undefined) return l.code;
  }
  return null;
}

export function explainVerdict(verdict: TriageVerdict, layers: TriageLayerResult[]): TriageExplanation {
  const code = primaryFailureCode(layers);
  const cause = code === null ? 'the failing layer could not be identified' : layerCauseLabel(code);
  const layerNextStep = code === null
    ? undefined
    : layers.find((l) => l.code === code)?.nextStep;

  switch (verdict) {
    case 'local':
      return {
        explanation: `Something on this machine is broken: ${cause}. Your services may be perfectly healthy.`,
        nextStep: layerNextStep
          ?? 'Check this machine\'s network settings (Wi-Fi, VPN, DNS configuration) before looking at your services.',
      };
    case 'network':
      return {
        explanation: `This machine looks fine, but the network it is on does not: ${cause}. Your services may be perfectly healthy.`,
        nextStep: layerNextStep
          ?? 'Fix the network path (router, Wi-Fi sign-in, VPN) before looking at your services.',
      };
    case 'remote':
      return {
        explanation: 'This machine and its network are fine — the services themselves did not answer.',
        nextStep: 'Run `crisismode scan` to diagnose the services.',
      };
    case 'mixed':
      return {
        explanation: 'Results conflict, so triage cannot say where the problem is. Read the per-layer lines below and treat failing layers as leads, not conclusions.',
        nextStep: 'Re-run `crisismode triage` in a few seconds; if the layers still disagree, investigate the failing layers individually.',
      };
    case 'healthy':
      return {
        explanation: 'This machine, its network, and everything triage could reach look fine.',
        nextStep: 'Nothing to fix here — if a service is failing, run `crisismode scan` to check the services themselves.',
      };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-verdict.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/__tests__/triage-verdict.test.ts
git commit -m "feat(triage): explain verdicts in plain language with cause labels"
```

---

### Task 3: Layer builders — interfaces, gateway, DNS

**Files:**
- Modify: `src/framework/triage.ts` (append)
- Test: `src/__tests__/triage-layers.test.ts`

**Interfaces:**
- Consumes: `TriageLayerResult`, `InterfaceProbeResult`, `GatewayProbeResult`, `DnsProbeResult`, `DNS_TEST_HOST`, `PUBLIC_RESOLVERS` (Task 1).
- Produces: `buildInterfaceLayer(result: InterfaceProbeResult, durationMs: number): TriageLayerResult`, `buildGatewayLayer(result: GatewayProbeResult, durationMs: number): TriageLayerResult`, `buildDnsLayer(result: DnsProbeResult, durationMs: number): TriageLayerResult`. Task 7 calls all three.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/triage-layers.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildDnsLayer, buildGatewayLayer, buildInterfaceLayer } from '../framework/triage.js';

describe('buildInterfaceLayer', () => {
  it('passes when a non-loopback interface has an address', () => {
    const layer = buildInterfaceLayer({ activeInterfaces: ['en0', 'utun3'] }, 4);
    expect(layer.status).toBe('pass');
    expect(layer.detail).toContain('en0');
    expect(layer.code).toBeUndefined();
    expect(layer.durationMs).toBe(4);
  });

  it('fails with no-active-interface when nothing is up', () => {
    const layer = buildInterfaceLayer({ activeInterfaces: [] }, 1);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('no-active-interface');
    expect(layer.nextStep).toContain('Wi-Fi');
  });
});

describe('buildGatewayLayer', () => {
  it('reports the gateway address as context', () => {
    const layer = buildGatewayLayer({ address: '192.168.1.1' }, 2);
    expect(layer.status).toBe('pass');
    expect(layer.detail).toContain('192.168.1.1');
  });

  it('records unknown rather than guessing when the route table is unreadable', () => {
    const layer = buildGatewayLayer({ address: null }, 2);
    expect(layer.status).toBe('unknown');
    expect(layer.code).toBe('gateway-unknown');
    expect(layer.detail).toContain('context only');
  });
});

describe('buildDnsLayer', () => {
  it('passes when the system resolver answers', () => {
    const layer = buildDnsLayer({ systemResolved: true, publicResolved: true }, 12);
    expect(layer.status).toBe('pass');
    expect(layer.code).toBeUndefined();
  });

  it('blames this machine when only the public resolvers answer', () => {
    const layer = buildDnsLayer(
      { systemResolved: false, publicResolved: true, systemError: 'queryA ESERVFAIL' },
      30,
    );
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('resolver-broken');
    expect(layer.detail).toContain('1.1.1.1');
    expect(layer.detail).toContain('queryA ESERVFAIL');
  });

  it('blames the network when no resolver answers', () => {
    const layer = buildDnsLayer({ systemResolved: false, publicResolved: false }, 40);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('dns-unreachable');
    expect(layer.nextStep).toContain('network');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-layers.test.ts`
Expected: FAIL — `buildInterfaceLayer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/triage.ts`:

```ts
// ── Layer builders (pure) ──

/** A layer we deliberately did not run. Never contributes to the verdict. */
export function skippedLayer(layer: TriageLayerName, detail: string, durationMs: number): TriageLayerResult {
  return { layer, status: 'skipped', detail, durationMs };
}

export function buildInterfaceLayer(result: InterfaceProbeResult, durationMs: number): TriageLayerResult {
  if (result.activeInterfaces.length === 0) {
    return {
      layer: 'interfaces',
      status: 'fail',
      code: 'no-active-interface',
      detail: 'No non-loopback interface has an address — this machine is not on any network.',
      nextStep: 'Turn on Wi-Fi or plug in the network cable, then re-run `crisismode triage`.',
      durationMs,
    };
  }
  return {
    layer: 'interfaces',
    status: 'pass',
    detail: `Active interfaces: ${result.activeInterfaces.join(', ')}`,
    durationMs,
  };
}

export function buildGatewayLayer(result: GatewayProbeResult, durationMs: number): TriageLayerResult {
  if (result.address === null) {
    return {
      layer: 'gateway',
      status: 'unknown',
      code: 'gateway-unknown',
      detail: 'Could not read the default gateway from the route table (context only — this does not change the verdict).',
      durationMs,
    };
  }
  return {
    layer: 'gateway',
    status: 'pass',
    detail: `Default gateway: ${result.address} (context only — not probed)`,
    durationMs,
  };
}

export function buildDnsLayer(result: DnsProbeResult, durationMs: number): TriageLayerResult {
  const resolvers = PUBLIC_RESOLVERS.join(', ');
  if (result.systemResolved) {
    return {
      layer: 'dns',
      status: 'pass',
      detail: `The system resolver answered for ${DNS_TEST_HOST}.`,
      durationMs,
    };
  }
  if (result.publicResolved) {
    const why = result.systemError === undefined ? '' : ` Resolver error: ${result.systemError}`;
    return {
      layer: 'dns',
      status: 'fail',
      code: 'resolver-broken',
      detail: `The system resolver failed for ${DNS_TEST_HOST}, but public resolvers (${resolvers}) answered — this machine\'s DNS configuration is broken.${why}`,
      nextStep: 'Fix this machine\'s DNS settings (VPN split-DNS, /etc/resolv.conf, or a corporate resolver) — the network itself is reachable.',
      durationMs,
    };
  }
  return {
    layer: 'dns',
    status: 'fail',
    code: 'dns-unreachable',
    detail: `Neither the system resolver nor public resolvers (${resolvers}) answered for ${DNS_TEST_HOST}.`,
    nextStep: 'Check the network you are on (Wi-Fi sign-in, VPN, router) — DNS traffic is not getting out.',
    durationMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-layers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/__tests__/triage-layers.test.ts
git commit -m "feat(triage): add interface, gateway, and two-step DNS layer builders"
```

---

### Task 4: Layer builders — captive portal, internet, targets

**Files:**
- Modify: `src/framework/triage.ts` (append)
- Test: `src/__tests__/triage-layers.test.ts` (append)

**Interfaces:**
- Consumes: `CaptiveEndpoint`, `CAPTIVE_ENDPOINTS`, `HttpProbeResult`, `TriageLayerResult`, `ProbeResult` (Task 1).
- Produces: `matchesCaptiveExpectation(endpoint: CaptiveEndpoint, result: HttpProbeResult): boolean`, `buildCaptiveLayer(results: CaptiveProbe[], durationMs: number): TriageLayerResult` where `CaptiveProbe = { endpoint: CaptiveEndpoint; probe: HttpProbeResult }`, `buildInternetLayer(results: InternetProbe[], durationMs: number): TriageLayerResult` where `InternetProbe = { url: string; probe: HttpProbeResult }`, `buildTargetsLayer(probes: ProbeResult[], durationMs: number): TriageLayerResult`. Task 7 calls all three; Task 8 reads `layer.probes` from the internet and targets layers.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-layers.test.ts`:

```ts
import {
  buildCaptiveLayer, buildInternetLayer, buildTargetsLayer,
  matchesCaptiveExpectation, CAPTIVE_ENDPOINTS,
} from '../framework/triage.js';
import type { CaptiveEndpoint, HttpProbeResult } from '../framework/triage.js';

const gstatic = CAPTIVE_ENDPOINTS[0]!;
const apple = CAPTIVE_ENDPOINTS[1]!;

function http(over: Partial<HttpProbeResult> = {}): HttpProbeResult {
  return { status: 204, body: '', redirected: false, latencyMs: 8, ...over };
}

describe('matchesCaptiveExpectation', () => {
  it('accepts an exactly-204 empty response from gstatic', () => {
    expect(matchesCaptiveExpectation(gstatic, http())).toBe(true);
  });

  it('rejects a 200 with a body from gstatic', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: 200, body: '<html>sign in</html>' }))).toBe(false);
  });

  it('accepts captive.apple.com answering 200 with Success in the body', () => {
    expect(matchesCaptiveExpectation(apple, http({ status: 200, body: '<HTML><BODY>Success</BODY></HTML>' }))).toBe(true);
  });

  it('rejects a 200 from captive.apple.com without Success', () => {
    expect(matchesCaptiveExpectation(apple, http({ status: 200, body: '<html>hotel wifi</html>' }))).toBe(false);
  });

  it('rejects any redirect', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: 302, redirected: true }))).toBe(false);
  });

  it('rejects a probe that never completed', () => {
    expect(matchesCaptiveExpectation(gstatic, http({ status: null, error: 'fetch failed' }))).toBe(false);
  });
});

describe('buildCaptiveLayer', () => {
  it('passes when an endpoint returns its expected response', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http() }], 20);
    expect(layer.status).toBe('pass');
  });

  it('reports a captive portal when a response arrives but does not match', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http({ status: 302, redirected: true }) }], 20);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('captive-portal');
    expect(layer.nextStep).toContain('sign-in');
  });

  it('records unknown when no connectivity-check endpoint responded at all', () => {
    const layer = buildCaptiveLayer([{ endpoint: gstatic, probe: http({ status: null, error: 'fetch failed' }) }], 20);
    expect(layer.status).toBe('unknown');
  });
});

describe('buildInternetLayer', () => {
  it('passes when at least one host answers, and records per-host probes', () => {
    const layer = buildInternetLayer([
      { url: 'https://api.anthropic.com', probe: http({ status: 401, latencyMs: 40 }) },
      { url: 'https://api.github.com', probe: http({ status: null, error: 'fetch failed', latencyMs: 1500 }) },
    ], 60);
    expect(layer.status).toBe('pass');
    expect(layer.probes).toHaveLength(2);
    expect(layer.probes![0]!.reachable).toBe(true);
    expect(layer.probes![1]!.error).toBe('fetch failed');
  });

  it('fails when no host answers', () => {
    const layer = buildInternetLayer([
      { url: 'https://api.anthropic.com', probe: http({ status: null, error: 'fetch failed' }) },
    ], 60);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('internet-unreachable');
  });
});

describe('buildTargetsLayer', () => {
  it('skips when there is nothing to probe', () => {
    const layer = buildTargetsLayer([], 0);
    expect(layer.status).toBe('skipped');
  });

  it('passes when every target accepts a connection', () => {
    const layer = buildTargetsLayer([{ target: 'pg', reachable: true, latencyMs: 3 }], 5);
    expect(layer.status).toBe('pass');
  });

  it('reports targets-partial when only some answer', () => {
    const layer = buildTargetsLayer([
      { target: 'pg', reachable: true, latencyMs: 3 },
      { target: 'redis', reachable: false, latencyMs: 800, error: 'ECONNREFUSED' },
    ], 810);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('targets-partial');
    expect(layer.detail).toContain('redis');
  });

  it('reports targets-unreachable when none answer', () => {
    const layer = buildTargetsLayer([{ target: 'pg', reachable: false, latencyMs: 800 }], 810);
    expect(layer.status).toBe('fail');
    expect(layer.code).toBe('targets-unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-layers.test.ts`
Expected: FAIL — `matchesCaptiveExpectation` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/triage.ts`:

```ts
export interface CaptiveProbe {
  endpoint: CaptiveEndpoint;
  probe: HttpProbeResult;
}

export interface InternetProbe {
  url: string;
  probe: HttpProbeResult;
}

/**
 * Does this response match what this specific endpoint promises when the
 * network is clean? Redirects never match: a redirect is the signature of a
 * portal intercepting the request.
 */
export function matchesCaptiveExpectation(endpoint: CaptiveEndpoint, result: HttpProbeResult): boolean {
  if (result.error !== undefined || result.status === null) return false;
  if (result.redirected) return false;
  if (result.status !== endpoint.expectedStatus) return false;
  return endpoint.expectedBody === ''
    ? result.body.trim() === ''
    : result.body.includes(endpoint.expectedBody);
}

export function buildCaptiveLayer(results: CaptiveProbe[], durationMs: number): TriageLayerResult {
  const matched = results.find((r) => matchesCaptiveExpectation(r.endpoint, r.probe));
  if (matched !== undefined) {
    return {
      layer: 'captive-portal',
      status: 'pass',
      detail: `${matched.endpoint.url} returned its expected response — no portal is intercepting traffic.`,
      durationMs,
    };
  }

  const responded = results.find((r) => r.probe.status !== null && r.probe.error === undefined);
  if (responded === undefined) {
    return {
      layer: 'captive-portal',
      status: 'unknown',
      detail: 'No connectivity-check endpoint responded — a captive portal cannot be distinguished from a blocked path here.',
      durationMs,
    };
  }

  const shape = responded.probe.redirected ? ' (a redirect)' : '';
  return {
    layer: 'captive-portal',
    status: 'fail',
    code: 'captive-portal',
    detail: `${responded.endpoint.url} returned HTTP ${responded.probe.status}${shape} instead of the expected ${responded.endpoint.expectedStatus} — something is intercepting traffic.`,
    nextStep: 'Open a browser and complete the network sign-in page, then re-run `crisismode triage`.',
    durationMs,
  };
}

export function buildInternetLayer(results: InternetProbe[], durationMs: number): TriageLayerResult {
  const probes: ProbeResult[] = results.map(({ url, probe }) => ({
    target: url,
    reachable: probe.error === undefined && probe.status !== null,
    latencyMs: probe.latencyMs,
    ...(probe.error !== undefined ? { error: probe.error } : {}),
  }));

  const reachable = probes.filter((p) => p.reachable);
  if (reachable.length === 0) {
    return {
      layer: 'internet',
      status: 'fail',
      code: 'internet-unreachable',
      detail: `No response from ${probes.map((p) => p.target).join(' or ')}.`,
      nextStep: 'This machine cannot reach the internet — check Wi-Fi, VPN, or the network you are on.',
      probes,
      durationMs,
    };
  }
  return {
    layer: 'internet',
    status: 'pass',
    detail: `${reachable.length} of ${probes.length} internet endpoint(s) answered.`,
    probes,
    durationMs,
  };
}

export function buildTargetsLayer(probes: ProbeResult[], durationMs: number): TriageLayerResult {
  if (probes.length === 0) {
    return skippedLayer('targets', 'No targets to probe.', durationMs);
  }

  const unreachable = probes.filter((p) => !p.reachable);
  if (unreachable.length === 0) {
    return {
      layer: 'targets',
      status: 'pass',
      detail: `All ${probes.length} target(s) accepted a TCP connection.`,
      probes,
      durationMs,
    };
  }

  const names = unreachable.map((p) => p.target).join(', ');
  if (unreachable.length === probes.length) {
    return {
      layer: 'targets',
      status: 'fail',
      code: 'targets-unreachable',
      detail: `None of ${probes.length} target(s) accepted a TCP connection: ${names}.`,
      nextStep: 'This machine and its network look fine — run `crisismode scan` to diagnose the services themselves.',
      probes,
      durationMs,
    };
  }

  return {
    layer: 'targets',
    status: 'fail',
    code: 'targets-partial',
    detail: `${probes.length - unreachable.length} of ${probes.length} target(s) answered; these did not: ${names}.`,
    nextStep: 'Some services answered and others did not — run `crisismode scan` and treat the silent ones as the leads.',
    probes,
    durationMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-layers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/__tests__/triage-layers.test.ts
git commit -m "feat(triage): add captive-portal, internet, and target layer builders"
```

---

### Task 5: Observer context detection (laptop vs. cloud VM)

**Files:**
- Create: `src/framework/triage-probes.ts`
- Test: `src/__tests__/triage-probes.test.ts`

**Interfaces:**
- Consumes: `ObserverContext`, `ObserverContextResult` (Task 1).
- Produces: `classifyObserverContext(input: { platform: string; env: Record<string, string | undefined>; dmi: string | null }): ObserverContextResult` (pure) and `detectObserverContext(): ObserverContextResult` (reads `process.platform`, `process.env`, and the Linux DMI files). Task 7 calls `detectObserverContext()`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/triage-probes.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { classifyObserverContext, detectObserverContext } from '../framework/triage-probes.js';

describe('classifyObserverContext', () => {
  it('calls a Kubernetes pod a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
      dmi: null,
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('KUBERNETES_SERVICE_HOST');
  });

  it('calls a cloud DMI vendor string a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: {},
      dmi: 'Amazon EC2 t3.medium',
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('amazon');
  });

  it('assumes darwin with no server markers is a laptop, and says it is an assumption', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: {}, dmi: null });
    expect(result.context).toBe('laptop');
    expect(result.evidence).toContain('assumption');
  });

  it('returns unknown for a bare Linux host with no markers', () => {
    const result = classifyObserverContext({ platform: 'linux', env: {}, dmi: 'LENOVO 20XW' });
    expect(result.context).toBe('unknown');
  });

  it('ignores an empty environment marker', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: { DYNO: '' }, dmi: null });
    expect(result.context).toBe('laptop');
  });
});

describe('detectObserverContext', () => {
  it('classifies the real host without throwing', () => {
    const result = detectObserverContext();
    expect(['laptop', 'server', 'unknown']).toContain(result.context);
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-probes.test.ts`
Expected: FAIL — cannot resolve `src/framework/triage-probes.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/triage-probes.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Node implementations of the triage probes — the only code in the triage
 * path that touches the real machine. Node built-ins only, everything
 * read-only, every failure returned as data rather than thrown.
 */

import { readFileSync } from 'node:fs';
import type { ObserverContextResult } from './triage.js';

// ── Observer context ──

/** Vendor strings that mean "this is a cloud/virtual host, not someone's laptop". */
export const CLOUD_DMI_MARKERS = [
  'amazon', 'google', 'microsoft corporation', 'digitalocean', 'alibaba',
  'openstack', 'hetzner', 'linode', 'qemu', 'kvm', 'vmware', 'xen', 'virtualbox',
];

/** Environment variables that only exist in server/CI environments. */
export const SERVER_ENV_MARKERS = [
  'KUBERNETES_SERVICE_HOST',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'AWS_EXECUTION_ENV',
  'WEBSITE_INSTANCE_ID',
  'DYNO',
  'K_SERVICE',
  'FUNCTION_TARGET',
  'CI',
];

const DMI_PATHS = ['/sys/class/dmi/id/sys_vendor', '/sys/class/dmi/id/product_name'];

/**
 * Best-effort laptop-vs-server classification, with no network calls.
 * Pure so it can be table-tested; `detectObserverContext` supplies the inputs.
 */
export function classifyObserverContext(input: {
  platform: string;
  env: Record<string, string | undefined>;
  dmi: string | null;
}): ObserverContextResult {
  const marker = SERVER_ENV_MARKERS.find((key) => {
    const value = input.env[key];
    return value !== undefined && value !== '';
  });
  if (marker !== undefined) {
    return { context: 'server', evidence: `environment variable ${marker} is set (best-effort detection)` };
  }

  if (input.dmi !== null) {
    const dmi = input.dmi.toLowerCase();
    const hit = CLOUD_DMI_MARKERS.find((m) => dmi.includes(m));
    if (hit !== undefined) {
      return { context: 'server', evidence: `DMI vendor string contains "${hit}" (best-effort detection)` };
    }
  }

  if (input.platform === 'darwin') {
    return { context: 'laptop', evidence: 'macOS host with no server markers (assumption, not a measurement)' };
  }

  return { context: 'unknown', evidence: 'no laptop or server markers found — captive-portal checks still apply' };
}

export function detectObserverContext(): ObserverContextResult {
  return classifyObserverContext({
    platform: process.platform,
    env: process.env,
    dmi: readDmi(),
  });
}

function readDmi(): string | null {
  if (process.platform !== 'linux') return null;
  const parts: string[] = [];
  for (const path of DMI_PATHS) {
    try {
      parts.push(readFileSync(path, 'utf-8').trim());
    } catch {
      // Not readable (non-DMI host, container, permissions) — best effort.
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-probes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage-probes.ts src/__tests__/triage-probes.test.ts
git commit -m "feat(triage): detect laptop vs. server observer context offline"
```

---

### Task 6: Node probe implementations and shared bounded execution

**Files:**
- Modify: `src/framework/triage-probes.ts` (append)
- Test: `src/__tests__/triage-probes.test.ts` (append)

**Interfaces:**
- Consumes: `TriageProbes`, `InterfaceProbeResult`, `GatewayProbeResult`, `DnsProbeResult`, `HttpProbeResult` (Task 1, **type-only**), `ProbeResult` from `@crisismode/agent-sdk`.
- Produces: `BoundedOutcome<T>`, `runBounded<T>(op, timeoutMs, onTimeout?): Promise<BoundedOutcome<T>>`, `parseIpRouteDefault(stdout: string): string | null`, `parseRouteGetDefault(stdout: string): string | null`, `boundedResolve(hostname: string, servers: readonly string[] | null, timeoutMs: number): Promise<{ ok: boolean; error?: string | undefined }>`, `probeTcpBounded(host, port, label, timeoutMs): Promise<ProbeResult>`, `nodeTriageProbes(timeoutMs: number, publicResolvers: readonly string[]): TriageProbes`. Task 7 uses `runBounded` as its outer backstop and calls `nodeTriageProbes(timeoutMs, PUBLIC_RESOLVERS)`; Task 13 reuses `runBounded` and `probeTcpBounded`.

**`runBounded` is the shared machinery.** Timeout + cancel + `try/finally` around a promise that can outlive its race is the part B1 and B2 proved is drift-prone, so exactly one copy exists: `boundedResolve` uses it with `resolver.cancel()`, `runTriage`'s outer backstop uses it with nothing to cancel, and `network-profile.ts`'s `probeDns` uses it with no hook because getaddrinfo cannot be cancelled (Task 13). `probeTcpBounded` is the one probe that does **not** route through it — a socket exposes its own timeout and `destroy()`, and its timeout is a legitimate `ProbeResult` ("did not answer") rather than an error, so wrapping it would convert a measurement into an exception and back. Note what is **not** shared: how each caller *resolves a name*. `boundedResolve` issues raw resolver queries to isolate a broken resolver from a broken network; `network-profile.ts` keeps `lookup()`/getaddrinfo because its question is "can this machine resolve names the way the user's app does", which must honor `/etc/hosts` and nsswitch. Both are correct measurements of different things — do not collapse them.

**The DNS probe is the load-bearing part of this task.** `dns/promises.resolve4()` uses the process-global resolver with c-ares defaults — several retries, seconds each — so an unbounded call cannot be rescued by an outer `Promise.race`: the race resolves, the query does not, and offline the DNS layer records `unknown`, which `synthesizeVerdict` turns into `mixed` instead of `local`/`network`. That is acceptance criterion 1 failing. Both halves of the two-step check therefore go through one `boundedResolve` helper that (a) uses its own `new Resolver({ timeout, tries: 1 })`, (b) runs concurrently with the other half rather than in sequence, and (c) calls `resolver.cancel()` on the timeout path so c-ares does not keep the event loop alive after the report has printed (`runTriageCommand` sets `process.exitCode` and returns — it never calls `process.exit()`, so a lingering handle delays the process by seconds).

Note: `triage-probes.ts` must import from `triage.ts` **with `import type` only**. `triage.ts` imports values from this file (Task 7), so a value import back would create a runtime module cycle. That is why the resolver list is a parameter rather than an import.

Note: all tests here stay on localhost (`127.0.0.1:1`), so they never depend on the machine having internet.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-probes.test.ts`:

```ts
import {
  boundedResolve, nodeTriageProbes, parseIpRouteDefault, parseRouteGetDefault, runBounded,
} from '../framework/triage-probes.js';

describe('route table parsing', () => {
  it('parses the Linux `ip route show default` form', () => {
    const stdout = 'default via 192.168.1.1 dev wlan0 proto dhcp metric 600 \n';
    expect(parseIpRouteDefault(stdout)).toBe('192.168.1.1');
  });

  it('returns null when Linux has no default route', () => {
    expect(parseIpRouteDefault('')).toBeNull();
  });

  it('parses the macOS `route -n get default` form', () => {
    const stdout = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 10.0.0.1',
      '  interface: en0',
    ].join('\n');
    expect(parseRouteGetDefault(stdout)).toBe('10.0.0.1');
  });

  it('returns null when macOS reports no gateway', () => {
    expect(parseRouteGetDefault('   route to: default\n  interface: lo0\n')).toBeNull();
  });
});

describe('nodeTriageProbes', () => {
  const probes = nodeTriageProbes(1_000, ['1.1.1.1', '8.8.8.8']);

  it('lists this machine\'s active interfaces', async () => {
    const result = await probes.listInterfaces();
    expect(Array.isArray(result.activeInterfaces)).toBe(true);
  });

  it('never throws when looking up the default gateway', async () => {
    const result = await probes.findDefaultGateway();
    expect(result.address === null || typeof result.address === 'string').toBe(true);
  });

  it('returns a failed TCP probe as data, not an exception', async () => {
    const result = await probes.connectTcp('127.0.0.1', 1, 'closed-port');
    expect(result.target).toBe('closed-port');
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns a failed fetch as data, not an exception', async () => {
    const result = await probes.fetchUrl('http://127.0.0.1:1/', 'GET');
    expect(result.status).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.body).toBe('');
  });
});

describe('runBounded', () => {
  it('returns the value when the operation finishes in time', async () => {
    const outcome = await runBounded(async () => 'done', 1_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toBe('done');
  });

  it('returns an error instead of throwing when the operation rejects', async () => {
    const outcome = await runBounded(async () => { throw new Error('boom'); }, 1_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('boom');
  });

  it('gives up on a stalled operation and runs the cancel hook', async () => {
    let cancelled = false;
    const outcome = await runBounded(
      () => new Promise<string>(() => {}),
      50,
      () => { cancelled = true; },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('timed out');
    // Without this, a raced-out query keeps the event loop alive after the
    // CLI has already printed its report.
    expect(cancelled).toBe(true);
  });

  it('works without a cancel hook, for APIs that cannot be cancelled', async () => {
    const outcome = await runBounded(() => new Promise<string>(() => {}), 50);
    expect(outcome.ok).toBe(false);
  });
});

describe('boundedResolve', () => {
  // 10.255.255.1 is RFC1918 space that drops rather than refuses, which is
  // what a broken resolver looks like. With an unbounded resolver this call
  // runs for c-ares' full retry schedule (seconds); bounded, it must give up
  // on our schedule. Both halves of resolveDns share this helper, so this
  // pins the bound for the system lookup too.
  const BLACKHOLE = ['10.255.255.1'];

  it('gives up on its own timeout instead of c-ares\' default schedule', async () => {
    const started = Date.now();
    const result = await boundedResolve('example.com', BLACKHOLE, 300);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(elapsed).toBeLessThan(2_000);
  });

  it('classifies rather than hanging when every resolver is unreachable', async () => {
    const probesWithDeadResolvers = nodeTriageProbes(300, BLACKHOLE);
    const started = Date.now();
    const result = await probesWithDeadResolvers.resolveDns('example.com');
    const elapsed = Date.now() - started;
    // A definite false is a classification; a hang would be `unknown`.
    expect(result.publicResolved).toBe(false);
    expect(typeof result.systemResolved).toBe('boolean');
    // Concurrent, not sequential: two 300ms lookups must not cost 600ms+.
    expect(elapsed).toBeLessThan(2_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-probes.test.ts`
Expected: FAIL — `nodeTriageProbes` and `boundedResolve` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/triage-probes.ts`, adding these imports at the top alongside the existing `node:fs` import and merging the `./triage.js` type import with the one Task 5 already added:

```ts
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { ProbeResult } from '@crisismode/agent-sdk';
import type {
  DnsProbeResult, GatewayProbeResult, HttpProbeResult, InterfaceProbeResult, TriageProbes,
} from './triage.js';

const execFileAsync = promisify(execFile);

/** Max characters of a connectivity-check body we keep. */
const MAX_BODY_CHARS = 256;

/** Parses `ip route show default` (Linux). */
export function parseIpRouteDefault(stdout: string): string | null {
  const match = /^default\s+via\s+(\S+)/m.exec(stdout);
  return match?.[1] ?? null;
}

/** Parses `route -n get default` (macOS/BSD). */
export function parseRouteGetDefault(stdout: string): string | null {
  const match = /^\s*gateway:\s*(\S+)\s*$/m.exec(stdout);
  return match?.[1] ?? null;
}

export type BoundedOutcome<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * Run one operation under a hard timeout, returning failure as data.
 *
 * The single implementation of bounded execution in the triage path — used by
 * boundedResolve, by runTriage's outer backstop, and by network-profile.ts.
 * Keeping one copy is the point: an unbounded probe is invisible until an
 * offline machine reports `unknown` instead of a verdict.
 *
 * `onTimeout` is where cancellation goes. Provide it whenever the underlying
 * API can be cancelled — a timed-out promise is still running, and a live
 * c-ares query keeps the event loop alive after the CLI has printed its
 * report. Omit it when the API offers no cancellation (`dns.lookup` runs in
 * the libuv threadpool and cannot be aborted); the bound still holds for the
 * caller, the work merely finishes on its own.
 */
export async function runBounded<T>(
  op: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<BoundedOutcome<T>> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      op().then(resolve, reject);
    });
    return { ok: true, value, durationMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One DNS query, bounded and cancelled on timeout.
 *
 * `servers === null` means "this machine's configured resolvers".
 *
 * This is a *raw resolver query*, deliberately not `lookup()`: triage needs to
 * tell a broken local resolver apart from a broken network, which means asking
 * named servers directly and bypassing `/etc/hosts`. `network-profile.ts` asks
 * the other question and keeps `lookup()` — see Task 13.
 *
 * Its own resolver with `tries: 1` is load-bearing: the process-global
 * resolver behind `dns/promises.resolve4()` retries on c-ares' schedule
 * (seconds), which no outer race can shorten.
 */
export async function boundedResolve(
  hostname: string,
  servers: readonly string[] | null,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (servers !== null) resolver.setServers([...servers]);

  const outcome = await runBounded(
    () => resolver.resolve4(hostname),
    timeoutMs,
    () => resolver.cancel(),
  );
  return outcome.ok
    ? { ok: outcome.value.length > 0 }
    : { ok: false, error: outcome.error };
}

/**
 * The real probe set. `timeoutMs` bounds each probe from the inside
 * (sockets, fetch, resolver, subprocess); `runTriage` bounds it again from
 * the outside so a probe that ignores its own timeout still cannot hang.
 *
 * The only subprocess invocations are the two fixed, argument-free route
 * table reads below — no user-influenced input reaches a shell.
 *
 * `publicResolvers` is a parameter rather than an import so this module needs
 * no runtime import from triage.ts, which imports this one.
 */
export function nodeTriageProbes(timeoutMs: number, publicResolvers: readonly string[]): TriageProbes {
  return {
    async listInterfaces(): Promise<InterfaceProbeResult> {
      const activeInterfaces: string[] = [];
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (!address.internal && address.address !== '') {
            activeInterfaces.push(name);
            break;
          }
        }
      }
      return { activeInterfaces };
    },

    async findDefaultGateway(): Promise<GatewayProbeResult> {
      try {
        if (process.platform === 'linux') {
          const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'], { timeout: timeoutMs });
          return { address: parseIpRouteDefault(stdout) };
        }
        if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'], { timeout: timeoutMs });
          return { address: parseRouteGetDefault(stdout) };
        }
        return { address: null };
      } catch {
        // No route tool, no default route, or a timeout — honesty over guessing.
        return { address: null };
      }
    },

    async resolveDns(hostname: string): Promise<DnsProbeResult> {
      // Concurrent, not sequential: run in sequence, a dead system resolver
      // eats the whole probe budget before the public resolver is ever tried,
      // and the layer can never distinguish 'resolver-broken' from
      // 'dns-unreachable'. Each half is bounded independently.
      const [system, direct] = await Promise.all([
        boundedResolve(hostname, null, timeoutMs),
        boundedResolve(hostname, publicResolvers, timeoutMs),
      ]);
      return {
        systemResolved: system.ok,
        publicResolved: direct.ok,
        ...(system.error !== undefined ? { systemError: system.error } : {}),
        ...(direct.error !== undefined ? { publicError: direct.error } : {}),
      };
    },

    async fetchUrl(url: string, method: 'GET' | 'HEAD'): Promise<HttpProbeResult> {
      const start = Date.now();
      try {
        const response = await fetch(url, {
          method,
          // Manual redirects: a portal's 302 must be observed, not followed.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': 'crisismode-triage' },
        });
        const body = method === 'GET' ? (await response.text()).slice(0, MAX_BODY_CHARS) : '';
        return {
          status: response.status,
          body,
          redirected: response.status >= 300 && response.status < 400,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        return {
          status: null,
          body: '',
          redirected: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    connectTcp(host: string, port: number, label: string): Promise<ProbeResult> {
      return probeTcpBounded(host, port, label, timeoutMs);
    },
  };
}

/**
 * TCP reachability as a ProbeResult. Shared with network-profile.ts (Task 13)
 * so there is exactly one socket-probe implementation to keep bounded.
 */
export function probeTcpBounded(
  host: string,
  port: number,
  label: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ target: label, reachable: false, latencyMs: Date.now() - start, error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: label, reachable: true, latencyMs: Date.now() - start });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ target: label, reachable: false, latencyMs: Date.now() - start, error: err.message });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-probes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage-probes.ts src/__tests__/triage-probes.test.ts
git commit -m "feat(triage): implement bounded, cancellable node probes for every triage layer"
```

---

### Task 7: `runTriage()` orchestration with per-probe timeouts and a whole-run deadline

**Files:**
- Modify: `src/framework/triage.ts` (append)
- Test: `src/__tests__/triage-run.test.ts`

**Interfaces:**
- Consumes: every builder from Tasks 1-4, `nodeTriageProbes` and `detectObserverContext` from `src/framework/triage-probes.ts` (Tasks 5-6).
- Produces: `TriageOptions` (`{ probes?: TriageProbes | undefined; timeoutMs?: number | undefined; deadlineMs?: number | undefined; targets?: TriageTarget[] | undefined; observerContext?: ObserverContextResult | undefined }`) and `runTriage(options?: TriageOptions): Promise<TriageReport>`. Task 8 adds `cacheResults` to `TriageOptions`; Task 9 and Task 12 call `runTriage`.

**Two bounds, and why both exist:**
- *Per-probe* (`timeoutMs`) caps one probe. Probes bound themselves internally (Task 6); `runBounded`'s race here is the outer backstop for a probe that misbehaves. This file does **not** define its own timeout helper — it imports the one from `triage-probes.ts`, so there is a single implementation to keep correct.
- *Whole-run* (`deadlineMs`, default `TRIAGE_DEADLINE_MS`) caps the report. Per-probe timeouts do not compose: four stages at 1000ms is 4s of probes, but nothing stopped that from being six stages at 1500ms (9s) before this bound existed. When the deadline passes, unrun layers are recorded as **`unknown`, never `skipped`** — `skipped` means "we chose not to check and it does not affect the verdict", which would let a truncated run report `healthy`. `unknown` routes through synthesis rule 6 to `mixed`: "we ran out of time, we cannot conclude."

**Stage layout** (probe stages run back to back, work inside a stage runs concurrently):
1. `interfaces` — no I/O, short-circuits everything on failure
2. `gateway` + `dns` — concurrent
3. `captive-portal` (both endpoints concurrent) + `internet` (both hosts concurrent) — concurrent with each other; independent HTTP probes, and serializing them is what pushed the worst case past 5s
4. `targets` — all concurrent

Worst case: 4 × 1000ms = 4s, inside the 5s deadline with a second of headroom. Report order in `layers` still follows the spec's 1-6 numbering regardless of execution order.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/triage-run.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { runTriage } from '../framework/triage.js';
import type { DnsProbeResult, TriageProbes } from '../framework/triage.js';

function healthyProbes(overrides: Partial<TriageProbes> = {}): TriageProbes {
  return {
    listInterfaces: async () => ({ activeInterfaces: ['en0'] }),
    findDefaultGateway: async () => ({ address: '192.168.1.1' }),
    resolveDns: async () => ({ systemResolved: true, publicResolved: true }),
    fetchUrl: async (_url: string, method: 'GET' | 'HEAD') => (
      method === 'GET'
        ? { status: 204, body: '', redirected: false, latencyMs: 5 }
        : { status: 200, body: '', redirected: false, latencyMs: 12 }
    ),
    connectTcp: async (_host: string, _port: number, label: string) => ({ target: label, reachable: true, latencyMs: 3 }),
    ...overrides,
  };
}

const laptop = { context: 'laptop' as const, evidence: 'test fixture' };
const server = { context: 'server' as const, evidence: 'test fixture' };

describe('runTriage', () => {
  it('reports healthy when every layer passes and no targets were given', async () => {
    const report = await runTriage({ probes: healthyProbes(), observerContext: laptop });
    expect(report.verdict).toBe('healthy');
    expect(report.layers.map((l) => l.layer)).toEqual([
      'interfaces', 'gateway', 'dns', 'captive-portal', 'internet', 'targets',
    ]);
    expect(report.layers.find((l) => l.layer === 'targets')!.status).toBe('skipped');
    expect(report.escalationLevel).toBe(2);
    expect(report.observerContext).toBe('laptop');
    expect(report.explanation.length).toBeGreaterThan(0);
    expect(report.nextStep.length).toBeGreaterThan(0);
  });

  it('short-circuits every later layer when no interface is up', async () => {
    const report = await runTriage({
      probes: healthyProbes({ listInterfaces: async () => ({ activeInterfaces: [] }) }),
      observerContext: laptop,
    });
    expect(report.verdict).toBe('local');
    expect(report.layers.filter((l) => l.status === 'skipped')).toHaveLength(5);
  });

  it('skips the captive-portal check in a server environment', async () => {
    const report = await runTriage({ probes: healthyProbes(), observerContext: server });
    const captive = report.layers.find((l) => l.layer === 'captive-portal')!;
    expect(captive.status).toBe('skipped');
    expect(captive.detail).toContain('server environment');
    expect(report.verdict).toBe('healthy');
  });

  it('detects a captive portal from a non-matching response', async () => {
    const report = await runTriage({
      probes: healthyProbes({
        fetchUrl: async (_url: string, method: 'GET' | 'HEAD') => (
          method === 'GET'
            ? { status: 302, body: '', redirected: true, latencyMs: 5 }
            : { status: 200, body: '', redirected: false, latencyMs: 12 }
        ),
      }),
      observerContext: laptop,
    });
    expect(report.verdict).toBe('network');
    expect(report.layers.find((l) => l.layer === 'captive-portal')!.code).toBe('captive-portal');
  });

  it('probes the targets it is given', async () => {
    const report = await runTriage({
      probes: healthyProbes({
        connectTcp: async (_host: string, _port: number, label: string) => ({ target: label, reachable: false, latencyMs: 9, error: 'ECONNREFUSED' }),
      }),
      observerContext: laptop,
      targets: [{ host: '127.0.0.1', port: 5432, label: 'main-pg' }],
    });
    expect(report.verdict).toBe('remote');
    expect(report.layers.find((l) => l.layer === 'targets')!.probes).toHaveLength(1);
  });

  // The OUTER bound: a probe that ignores its own timeout (only reachable via
  // an injected pathological probe — the real ones bound themselves, see the
  // boundedResolve tests in Task 6) is still cut off, and the honest result of
  // an unassessable layer is `mixed`, never `healthy`.
  it('records unknown for a probe that never resolves, without hanging', async () => {
    vi.useFakeTimers();
    try {
      const pending = runTriage({
        probes: healthyProbes({ resolveDns: () => new Promise<DnsProbeResult>(() => {}) }),
        observerContext: laptop,
        timeoutMs: 800,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      expect(report.layers.find((l) => l.layer === 'dns')!.status).toBe('unknown');
      expect(report.verdict).toBe('mixed');
    } finally {
      vi.useRealTimers();
    }
  });

  // The ≤5s acceptance criterion, as a property rather than a hope. Per-probe
  // timeouts here (3s) would otherwise compose to 9s+ across the stages.
  it('finishes inside the whole-run deadline even when every probe stalls', async () => {
    vi.useFakeTimers();
    try {
      const stalled: TriageProbes = {
        listInterfaces: async () => ({ activeInterfaces: ['en0'] }),
        findDefaultGateway: () => new Promise(() => {}),
        resolveDns: () => new Promise(() => {}),
        fetchUrl: () => new Promise(() => {}),
        connectTcp: () => new Promise(() => {}),
      };
      const pending = runTriage({
        probes: stalled,
        observerContext: laptop,
        timeoutMs: 3_000,
        targets: [{ host: '127.0.0.1', port: 5432, label: 'main-pg' }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const report = await pending;
      expect(report.durationMs).toBeLessThanOrEqual(5_000);
      expect(report.layers).toHaveLength(6);
      // The deadline bit before the target stage, so targets is unknown-by-budget.
      const targets = report.layers.find((l) => l.layer === 'targets')!;
      expect(targets.status).toBe('unknown');
      expect(targets.detail).toContain('budget');
      // Whatever else is true, a run this degraded may never read as healthy.
      expect(report.verdict).not.toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks layers it ran out of budget for as unknown, never skipped', async () => {
    vi.useFakeTimers();
    try {
      // The DNS probe consumes the entire 1000ms budget, so every later stage
      // is out of time before it starts.
      const pending = runTriage({
        probes: healthyProbes({ resolveDns: () => new Promise<DnsProbeResult>(() => {}) }),
        observerContext: laptop,
        timeoutMs: 1_000,
        deadlineMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      const unrun = report.layers.filter(
        (l) => l.layer === 'captive-portal' || l.layer === 'internet' || l.layer === 'targets',
      );
      expect(unrun).toHaveLength(3);
      expect(unrun.every((l) => l.status === 'unknown')).toBe(true);
      expect(unrun.every((l) => l.status !== 'skipped')).toBe(true);
      expect(unrun[0]!.detail).toContain('budget');
      // A truncated run must never be able to report healthy.
      expect(report.verdict).toBe('mixed');
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-run.test.ts`
Expected: FAIL — `runTriage` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/triage.ts`, adding these imports near the top of the file after the type imports. Note `runBounded` and `BoundedOutcome`: this file does not define its own timeout helper.

```ts
import { detectObserverContext, nodeTriageProbes, runBounded } from './triage-probes.js';
import type { BoundedOutcome } from './triage-probes.js';
```

```ts
// ── Orchestration ──

export interface TriageOptions {
  /** Injectable probe set. Defaults to the real Node probes. */
  probes?: TriageProbes | undefined;
  /** Hard per-probe timeout. Defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** Whole-run budget. Defaults to TRIAGE_DEADLINE_MS. */
  deadlineMs?: number | undefined;
  /** Targets for layer 6. Absent or empty skips the layer. */
  targets?: TriageTarget[] | undefined;
  /** Override observer detection (tests). */
  observerContext?: ObserverContextResult | undefined;
}

/** Report order, which is the spec's layer numbering — not execution order. */
const LAYER_ORDER: readonly TriageLayerName[] = [
  'interfaces', 'gateway', 'dns', 'captive-portal', 'internet', 'targets',
];

/**
 * Run every layer and synthesize a verdict.
 *
 * Layer 1 runs first and short-circuits the rest: with no network interface,
 * every later probe would fail for the same reason and only add latency.
 * Everything after it runs in three concurrent stages, and the whole run is
 * capped by a monotonic deadline so a pathological network cannot stretch the
 * report past the ≤5s the spec promises.
 */
export async function runTriage(options: TriageOptions = {}): Promise<TriageReport> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = startedAt + (options.deadlineMs ?? TRIAGE_DEADLINE_MS);
  const probes = options.probes ?? nodeTriageProbes(timeoutMs, PUBLIC_RESOLVERS);
  const observer = options.observerContext ?? detectObserverContext();
  const targets = options.targets ?? [];
  const layers: TriageLayerResult[] = [];

  /** Budget for the next probe: whichever of the two bounds bites first. */
  const budget = (): number => Math.min(timeoutMs, Math.max(0, deadline - Date.now()));

  // Layer 1 — interfaces
  const interfaceOutcome = await runBounded(() => probes.listInterfaces(), budget());
  const interfaceLayer = interfaceOutcome.ok
    ? buildInterfaceLayer(interfaceOutcome.value, interfaceOutcome.durationMs)
    : unknownLayer('interfaces', interfaceOutcome.error, interfaceOutcome.durationMs);
  layers.push(interfaceLayer);

  if (interfaceLayer.status === 'fail') {
    const remaining: TriageLayerName[] = ['gateway', 'dns', 'captive-portal', 'internet', 'targets'];
    for (const name of remaining) {
      layers.push(skippedLayer(name, 'Skipped — this machine has no active network interface.', 0));
    }
    return buildReport(layers, observer, startedAt);
  }

  // Stage 2 — gateway (context) and DNS, concurrently
  if (budget() === 0) return finishExpired(layers, observer, startedAt);
  const stage2Budget = budget();
  const [gatewayOutcome, dnsOutcome] = await Promise.all([
    runBounded(() => probes.findDefaultGateway(), stage2Budget),
    runBounded(() => probes.resolveDns(DNS_TEST_HOST), stage2Budget),
  ]);
  layers.push(gatewayOutcome.ok
    ? buildGatewayLayer(gatewayOutcome.value, gatewayOutcome.durationMs)
    : unknownLayer('gateway', gatewayOutcome.error, gatewayOutcome.durationMs));
  layers.push(dnsOutcome.ok
    ? buildDnsLayer(dnsOutcome.value, dnsOutcome.durationMs)
    : unknownLayer('dns', dnsOutcome.error, dnsOutcome.durationMs));

  // Stage 3 — captive portal and internet. Independent HTTP probes, so they
  // run concurrently; serializing them is what pushed the worst case past 5s.
  if (budget() === 0) return finishExpired(layers, observer, startedAt);
  const stage3Budget = budget();
  const stage3Start = Date.now();
  const captiveWork: Promise<TriageLayerResult> = observer.context === 'server'
    ? Promise.resolve(skippedLayer('captive-portal', 'Not applicable (server environment).', 0))
    : Promise.all(
        CAPTIVE_ENDPOINTS.map(async (endpoint) => ({
          endpoint,
          probe: asHttpProbe(await runBounded(() => probes.fetchUrl(endpoint.url, 'GET'), stage3Budget)),
        })),
      ).then((captiveProbes: CaptiveProbe[]) => buildCaptiveLayer(captiveProbes, Date.now() - stage3Start));

  const internetWork: Promise<TriageLayerResult> = Promise.all(
    INTERNET_PROBE_URLS.map(async (url) => ({
      url,
      probe: asHttpProbe(await runBounded(() => probes.fetchUrl(url, 'HEAD'), stage3Budget)),
    })),
  ).then((internetProbes: InternetProbe[]) => buildInternetLayer(internetProbes, Date.now() - stage3Start));

  const [captiveLayer, internetLayer] = await Promise.all([captiveWork, internetWork]);
  layers.push(captiveLayer);
  layers.push(internetLayer);

  // Stage 4 — per-target reachability
  if (budget() === 0) return finishExpired(layers, observer, startedAt);
  const targetsBudget = budget();
  const targetsStart = Date.now();
  const targetProbes: ProbeResult[] = await Promise.all(
    targets.map(async (t) => {
      const outcome = await runBounded(() => probes.connectTcp(t.host, t.port, t.label), targetsBudget);
      return outcome.ok
        ? outcome.value
        : { target: t.label, reachable: false, latencyMs: outcome.durationMs, error: outcome.error };
    }),
  );
  layers.push(buildTargetsLayer(targetProbes, Date.now() - targetsStart));

  return buildReport(layers, observer, startedAt);
}

/**
 * Finish a run that hit its deadline. Layers we never got to are `unknown`,
 * not `skipped`: we did intend to check them, so the honest report is "could
 * not assess" (which synthesis turns into `mixed`) rather than a silence that
 * would let the verdict come out `healthy`.
 */
function finishExpired(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  startedAt: number,
): TriageReport {
  for (const name of LAYER_ORDER) {
    if (layers.some((l) => l.layer === name)) continue;
    layers.push({
      layer: name,
      status: 'unknown',
      detail: 'Not checked — triage ran out of its whole-run budget.',
      durationMs: 0,
    });
  }
  return buildReport(layers, observer, startedAt);
}

function buildReport(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  startedAt: number,
): TriageReport {
  const verdict = synthesizeVerdict(layers);
  const { explanation, nextStep } = explainVerdict(verdict, layers);
  return {
    verdict,
    explanation,
    nextStep,
    layers,
    observerContext: observer.context,
    observerContextEvidence: observer.evidence,
    escalationLevel: TRIAGE_ESCALATION_LEVEL,
    checkedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

function unknownLayer(layer: TriageLayerName, error: string, durationMs: number): TriageLayerResult {
  return { layer, status: 'unknown', detail: `Probe did not complete: ${error}`, durationMs };
}

/**
 * A timed-out HTTP or TCP probe becomes "no response" — evidence, because
 * that is exactly what unreachable looks like from here, and it is how
 * network-profile.ts has always treated a socket timeout. A timed-out DNS
 * probe becomes `unknown` instead (see unknownLayer): it cannot distinguish
 * "the resolver is broken" from "we did not wait long enough", and guessing
 * between those is the difference between a `local` and a `network` verdict.
 * The asymmetry is deliberate — do not "fix" it into consistency.
 */
function asHttpProbe(outcome: BoundedOutcome<HttpProbeResult>): HttpProbeResult {
  return outcome.ok
    ? outcome.value
    : { status: null, body: '', redirected: false, latencyMs: outcome.durationMs, error: outcome.error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-run.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/__tests__/triage-run.test.ts
git commit -m "feat(triage): orchestrate layered probes with hard per-probe timeouts"
```

---

### Task 8: Cache the triage results (report singleton + NetworkProfile)

**Files:**
- Modify: `src/framework/network-profile.ts:107` (mode inference call site), `:125-127` (next to `resetNetworkProfile`), `:219-235` (`inferMode` → `inferNetworkMode`)
- Modify: `src/framework/triage.ts` (append the report cache and `toNetworkProfile`, extend `TriageOptions` and `runTriage`)
- Test: `src/__tests__/triage-run.test.ts` (append)

**Interfaces:**
- Consumes: `TriageReport` (Task 1), `NetworkProfile` / `NetworkLayer` / `ConnectivityStatus` from `@crisismode/agent-sdk`.
- Produces, in `network-profile.ts`: `setNetworkProfile(profile: NetworkProfile): void`, `inferNetworkMode(internet: NetworkLayer, hub: NetworkLayer, targets: NetworkLayer, dnsAvailable: boolean): NetworkMode`.
- Produces, in `triage.ts`: `toNetworkProfile(report: TriageReport): NetworkProfile`; the process-lifetime report cache `getTriageReport(): TriageReport | null` and `resetTriageReport(): void`; and `TriageOptions.cacheResults?: boolean | undefined` (default `true`).

Why the NetworkProfile write: `src/cli/ai-summary.ts:50` and `src/framework/environment-guard.ts:137` read the cached profile, but today only `diagnose` populates it. Triage becomes the single prober so scan's offline gate and the environment guard see consistent state.

**Only measured layers may be published.** `NetworkProfile.dns` is `{ available: boolean; latencyMs: number }` — it has no way to say "unknown". So a triage run whose DNS layer is `unknown` (probe timed out, never completed) must **not** write the profile at all: mapping unknown to `available: false` would make `assessEnvironment` (`environment-guard.ts:38-40`) tell the operator "This machine cannot resolve DNS names (resolver probe failed at startup)" on the strength of a probe that never ran. Leaving the cache `null` is the honest state — every consumer already handles null as "no profile yet". The triage report cache is still written in that case, because `TriageLayerResult` *can* express `unknown` per layer.

Why the report cache: **this is a deliberate addition beyond the spec, and a pinned cross-PR contract** (see "Deliberate Additions Beyond the Spec" above). PR 3's llm-provider agent and PR 5 read the verdict from inside `assessHealth()` to skip network checks when the problem is the observer, and they must not re-run probes to do it. `getTriageReport()` returns `null` when triage has not run in this process (e.g. `crisismode diagnose`, which never calls it) — callers must treat `null` as "no information" and run their checks normally, never as "offline". This mirrors the existing `getNetworkProfile()` / `resetNetworkProfile()` pattern in `network-profile.ts:56-64,125-127`, including the `null` (not `undefined`) convention.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-run.test.ts` (extend the file's existing `import { describe, it, expect, vi } from 'vitest'` with `afterEach` rather than adding a second vitest import):

```ts
import { getTriageReport, resetTriageReport, toNetworkProfile } from '../framework/triage.js';
import { getNetworkProfile, resetNetworkProfile } from '../framework/network-profile.js';
import type { TriageReport } from '../framework/triage.js';

afterEach(() => {
  resetNetworkProfile();
  resetTriageReport();
});

const offlineReport: TriageReport = {
  verdict: 'network',
  explanation: 'x',
  nextStep: 'y',
  observerContext: 'laptop',
  observerContextEvidence: 'test fixture',
  escalationLevel: 2,
  checkedAt: '2026-08-05T00:00:00.000Z',
  durationMs: 100,
  layers: [
    { layer: 'interfaces', status: 'pass', detail: 'en0', durationMs: 1 },
    { layer: 'dns', status: 'fail', code: 'dns-unreachable', detail: 'no resolver answered', durationMs: 40 },
    {
      layer: 'internet', status: 'fail', code: 'internet-unreachable', detail: 'nothing answered', durationMs: 60,
      probes: [{ target: 'https://api.anthropic.com', reachable: false, latencyMs: 60, error: 'fetch failed' }],
    },
    { layer: 'targets', status: 'skipped', detail: 'No targets to probe.', durationMs: 0 },
  ],
};

describe('toNetworkProfile', () => {
  it('maps failing triage layers onto an isolated network profile', () => {
    const profile = toNetworkProfile(offlineReport);
    expect(profile.dns.available).toBe(false);
    expect(profile.internet.status).toBe('unavailable');
    expect(profile.internet.probes).toHaveLength(1);
    expect(profile.hub.status).toBe('unknown');
    expect(profile.targets.status).toBe('unknown');
    expect(profile.mode).toBe('isolated');
    expect(profile.profiledAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('maps a healthy DNS layer to an available profile', () => {
    const healthy: TriageReport = {
      ...offlineReport,
      verdict: 'healthy',
      layers: [
        { layer: 'dns', status: 'pass', detail: 'ok', durationMs: 12 },
        {
          layer: 'internet', status: 'pass', detail: 'ok', durationMs: 30,
          probes: [{ target: 'https://api.anthropic.com', reachable: true, latencyMs: 30 }],
        },
      ],
    };
    const profile = toNetworkProfile(healthy);
    expect(profile.dns.available).toBe(true);
    expect(profile.dns.latencyMs).toBe(12);
    expect(profile.internet.status).toBe('available');
    expect(profile.mode).toBe('full');
  });
});

describe('runTriage caching', () => {
  it('caches a network profile so ai-summary and the environment guard agree', async () => {
    expect(getNetworkProfile()).toBeNull();
    await runTriage({ probes: healthyProbes(), observerContext: laptop });
    expect(getNetworkProfile()).not.toBeNull();
    expect(getNetworkProfile()!.internet.status).toBe('available');
  });

  it('returns null from getTriageReport until triage has run in this process', () => {
    expect(getTriageReport()).toBeNull();
  });

  it('caches the report so agents can read the verdict without re-probing', async () => {
    const report = await runTriage({ probes: healthyProbes(), observerContext: laptop });
    expect(getTriageReport()).not.toBeNull();
    expect(getTriageReport()!.verdict).toBe(report.verdict);
  });

  it('writes nothing global when cacheResults is false', async () => {
    await runTriage({ probes: healthyProbes(), observerContext: laptop, cacheResults: false });
    expect(getNetworkProfile()).toBeNull();
    expect(getTriageReport()).toBeNull();
  });

  it('does not publish a DNS claim it never measured', async () => {
    vi.useFakeTimers();
    try {
      const pending = runTriage({
        probes: healthyProbes({ resolveDns: () => new Promise<DnsProbeResult>(() => {}) }),
        observerContext: laptop,
        timeoutMs: 800,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      expect(report.layers.find((l) => l.layer === 'dns')!.status).toBe('unknown');
      // NetworkProfile.dns cannot express "unknown", and environment-guard
      // reads `available: false` as "this machine cannot resolve DNS names".
      expect(getNetworkProfile()).toBeNull();
      // The report cache can express it, so it is still published.
      expect(getTriageReport()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-run.test.ts`
Expected: FAIL — `toNetworkProfile`, `getTriageReport`, and `resetTriageReport` are not exported, and `cacheResults` is not a valid option.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/network-profile.ts`, add the write path next to `resetNetworkProfile` and rename the private `inferMode` to an exported `inferNetworkMode`:

```ts
/**
 * Replace the cached profile. This is the write path triage uses after its
 * layers run, so the offline gate in ai-summary.ts and the environment guard
 * see the same connectivity picture without a second probe system.
 */
export function setNetworkProfile(profile: NetworkProfile): void {
  cachedProfile = profile;
}
```

```ts
/**
 * Classify overall connectivity from the layer statuses. Exported so triage
 * can reuse the exact same rules rather than re-deriving them.
 */
export function inferNetworkMode(
  internet: NetworkLayer,
  hub: NetworkLayer,
  targets: NetworkLayer,
  dnsAvailable: boolean,
): NetworkMode {
```

(the body is unchanged; update the call site at `probeNetwork` from `inferMode(...)` to `inferNetworkMode(...)`).

Append to `src/framework/triage.ts` — add the value import at the top:

```ts
import { inferNetworkMode, setNetworkProfile } from './network-profile.js';
import type { ConnectivityStatus, NetworkLayer, NetworkProfile } from '@crisismode/agent-sdk';
```

```ts
// ── Cached report ──

let cachedReport: TriageReport | null = null;

/**
 * The last triage report from this process, or null if triage has not run.
 *
 * Cross-PR contract: agents call this from `assessHealth()` to skip network
 * checks when triage already localized the problem to this machine or its
 * network. `null` means "triage never ran here" — no information, not
 * "offline". Non-blocking read; never triggers a probe.
 */
export function getTriageReport(): TriageReport | null {
  return cachedReport;
}

/** Clear the cached report. Used by tests. */
export function resetTriageReport(): void {
  cachedReport = null;
}

// ── NetworkProfile bridge ──

/**
 * Project a triage report onto the NetworkProfile shape the rest of the CLI
 * already consumes. Triage never probes the hub, so that layer stays
 * 'unknown' rather than claiming a result we did not measure.
 */
export function toNetworkProfile(report: TriageReport): NetworkProfile {
  const find = (name: TriageLayerName): TriageLayerResult | undefined =>
    report.layers.find((l) => l.layer === name);
  const checkedAt = report.checkedAt;
  const dnsLayer = find('dns');
  const internetLayer = find('internet');
  const targetsLayer = find('targets');

  const internet: NetworkLayer = {
    status: layerConnectivity(internetLayer),
    probes: internetLayer?.probes ?? [],
    checkedAt,
  };
  const hub: NetworkLayer = { status: 'unknown', probes: [], checkedAt };
  const targets: NetworkLayer = {
    status: layerConnectivity(targetsLayer),
    probes: targetsLayer?.probes ?? [],
    checkedAt,
  };
  const dns = {
    available: dnsLayer?.status === 'pass',
    latencyMs: dnsLayer?.durationMs ?? 0,
  };

  return {
    internet,
    hub,
    targets,
    dns,
    mode: inferNetworkMode(internet, hub, targets, dns.available),
    profiledAt: checkedAt,
  };
}

function layerConnectivity(layer: TriageLayerResult | undefined): ConnectivityStatus {
  if (layer === undefined) return 'unknown';
  if (layer.status === 'pass') {
    const probes = layer.probes ?? [];
    return probes.some((p) => !p.reachable) ? 'degraded' : 'available';
  }
  if (layer.status === 'fail') {
    return layer.code === 'targets-partial' ? 'degraded' : 'unavailable';
  }
  return 'unknown';
}
```

Extend `TriageOptions` with:

```ts
  /**
   * Publish the results to the process-lifetime caches — the triage report
   * (read by agents via getTriageReport) and the NetworkProfile singleton.
   * Default true; set false for a side-effect-free run.
   */
  cacheResults?: boolean | undefined;
```

and route **every** exit path through one helper. There are three in Task 7's code:

1. the interfaces short-circuit `return buildReport(layers, observer, startedAt);`
2. the final `return buildReport(layers, observer, startedAt);`
3. `finishExpired`, which ends in `return buildReport(layers, observer, startedAt);`

Change 1 and 2 to `return finish(layers, observer, startedAt, options);`. For 3, give `finishExpired` a fourth parameter `options: TriageOptions`, end it with `return finish(layers, observer, startedAt, options);`, and pass `options` at its three call sites. Miss `finishExpired` and a deadline-truncated run silently skips both caches. Then add:

```ts
function finish(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  startedAt: number,
  options: TriageOptions,
): TriageReport {
  const report = buildReport(layers, observer, startedAt);
  if (options.cacheResults !== false) {
    cachedReport = report;
    // Only publish a NetworkProfile built from a DNS layer we actually
    // measured — see the "only measured layers" note above.
    if (report.layers.find((l) => l.layer === 'dns')?.status !== 'unknown') {
      setNetworkProfile(toNetworkProfile(report));
    }
  }
  return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-run.test.ts src/__tests__/network-profile.test.ts`
Expected: PASS for both files.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/triage.ts src/framework/network-profile.ts src/__tests__/triage-run.test.ts
git commit -m "feat(triage): cache the triage report and publish its results to the NetworkProfile"
```

---

### Task 9: `crisismode triage` command

**Files:**
- Create: `src/cli/commands/triage.ts`
- Modify: `src/cli/status-presentation.ts` (append the verdict color mapping)
- Test: `src/__tests__/triage-cli.test.ts`

**Interfaces:**
- Consumes: `runTriage`, `TriageReport`, `TriageVerdict`, `TriageLayerStatus`, `TriageTarget` (Tasks 1-8); `getEscalationInfo` from `src/framework/escalation.ts`; `printBanner`, `printInfo`, `jsonOut`, `getOutputMode` from `src/cli/output.ts`; `discoverStack` from `src/cli/autodiscovery.ts`; `loadConfigWithDetection` and `ConfigNotFoundError` from `src/config/loader.ts`.
- Produces: `triageVerdictColor(verdict: TriageVerdict): ChalkInstance` in `status-presentation.ts`; `triageExitCode(verdict: TriageVerdict): 0 | 1`, `renderTriageReport(report: TriageReport): string[]`, `renderTriagePipe(report: TriageReport): string[]`, `resolveTriageTargets(configPath?: string): Promise<TriageTarget[]>`, `runTriageCommand(opts?: TriageCommandOptions): Promise<number>` in `commands/triage.ts`. Task 10 wires `runTriageCommand` into `src/cli/index.ts`.

Verdict → color lives in `status-presentation.ts` because CLAUDE.md names it the single source for status → presentation mappings; the exhaustive `Record` there is what makes a new verdict fail compilation instead of rendering colorless.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/triage-cli.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { renderTriagePipe, renderTriageReport, triageExitCode } from '../cli/commands/triage.js';
import type { TriageReport } from '../framework/triage.js';

const report: TriageReport = {
  verdict: 'network',
  explanation: 'This machine looks fine, but the network it is on does not: DNS is not resolving from this machine.',
  nextStep: 'Check the network you are on (Wi-Fi sign-in, VPN, router) — DNS traffic is not getting out.',
  observerContext: 'laptop',
  observerContextEvidence: 'macOS host with no server markers (assumption, not a measurement)',
  escalationLevel: 2,
  checkedAt: '2026-08-05T12:00:00.000Z',
  durationMs: 1234,
  layers: [
    { layer: 'interfaces', status: 'pass', detail: 'Active interfaces: en0', durationMs: 1 },
    { layer: 'gateway', status: 'pass', detail: 'Default gateway: 192.168.1.1 (context only — not probed)', durationMs: 4 },
    { layer: 'dns', status: 'fail', code: 'dns-unreachable', detail: 'Neither resolver answered.', nextStep: 'Check the network.', durationMs: 800 },
    { layer: 'captive-portal', status: 'unknown', detail: 'No connectivity-check endpoint responded.', durationMs: 800 },
    { layer: 'internet', status: 'fail', code: 'internet-unreachable', detail: 'No response.', durationMs: 800 },
    { layer: 'targets', status: 'skipped', detail: 'No targets to probe.', durationMs: 0 },
  ],
};

describe('triageExitCode', () => {
  it('exits 0 when this machine is not the problem', () => {
    expect(triageExitCode('healthy')).toBe(0);
    expect(triageExitCode('remote')).toBe(0);
  });

  it('exits 1 when the problem is local, network, or unresolved', () => {
    expect(triageExitCode('local')).toBe(1);
    expect(triageExitCode('network')).toBe(1);
    expect(triageExitCode('mixed')).toBe(1);
  });
});

describe('renderTriageReport', () => {
  const out = renderTriageReport(report).join('\n');

  it('leads with the verdict and its plain-language explanation', () => {
    expect(out).toContain('network');
    expect(out).toContain('the network it is on does not');
  });

  it('gives one next step', () => {
    expect(out).toContain('Next: Check the network you are on');
  });

  it('shows every layer with its detail', () => {
    for (const layer of report.layers) {
      expect(out).toContain(layer.layer);
      expect(out).toContain(layer.detail);
    }
  });

  it('names the escalation level and the observer-context caveat', () => {
    expect(out).toContain('Diagnose');
    expect(out).toContain('laptop');
    expect(out).toContain('assumption');
  });
});

describe('renderTriagePipe', () => {
  const lines = renderTriagePipe(report);

  it('emits a tab-separated verdict line first', () => {
    expect(lines[0]).toBe('triage\tnetwork\t2026-08-05T12:00:00.000Z\t1234');
  });

  it('emits one tab-separated line per layer', () => {
    expect(lines).toHaveLength(1 + report.layers.length);
    expect(lines[1]).toBe('layer\tinterfaces\tpass\tActive interfaces: en0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-cli.test.ts`
Expected: FAIL — cannot resolve `src/cli/commands/triage.ts`.

- [ ] **Step 3: Write minimal implementation**

First append to `src/cli/status-presentation.ts`:

```ts
import type { TriageVerdict } from '../framework/triage.js';

export const TRIAGE_VERDICT_COLOR: Record<TriageVerdict, ChalkInstance> = {
  local: chalk.red,
  network: chalk.red,
  mixed: chalk.yellow,
  remote: chalk.cyan,
  healthy: chalk.green,
};

export function triageVerdictColor(verdict: TriageVerdict): ChalkInstance {
  return TRIAGE_VERDICT_COLOR[verdict] ?? chalk.dim;
}
```

Then create `src/cli/commands/triage.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode triage` — is it me, my network, or them?
 *
 * Deterministic, dependency-free localization. Works with no internet and no
 * API key. Read-only (escalation level 2: Diagnose).
 *
 * Exit codes: 0 when this machine is not the problem (healthy, remote),
 * 1 when it might be (local, network, mixed) — so scripts can branch.
 */

import chalk from 'chalk';
import { runTriage } from '../../framework/triage.js';
import { getEscalationInfo } from '../../framework/escalation.js';
import { getOutputMode, jsonOut, printBanner, printInfo } from '../output.js';
import { triageVerdictColor } from '../status-presentation.js';
import { discoverStack } from '../autodiscovery.js';
import { ConfigNotFoundError, loadConfigWithDetection } from '../../config/loader.js';
import type { TriageLayerStatus, TriageReport, TriageTarget, TriageVerdict } from '../../framework/triage.js';

export interface TriageCommandOptions {
  configPath?: string | undefined;
}

/** Exhaustive: adding a layer status must fail compilation here. */
const LAYER_ICON: Record<TriageLayerStatus, string> = {
  pass: '✅', fail: '🔴', unknown: '❔', skipped: '·',
};

const VERDICT_HEADLINE: Record<TriageVerdict, string> = {
  local: 'Verdict: local — the problem looks like this machine',
  network: 'Verdict: network — the problem looks like the network this machine is on',
  remote: 'Verdict: remote — this machine and its network are fine',
  mixed: 'Verdict: mixed — triage could not localize the problem',
  healthy: 'Verdict: healthy — nothing local or network-level is wrong',
};

/** 0 when this machine is not the problem, 1 when it might be. */
export function triageExitCode(verdict: TriageVerdict): 0 | 1 {
  return verdict === 'healthy' || verdict === 'remote' ? 0 : 1;
}

export function renderTriageReport(report: TriageReport): string[] {
  const escalation = getEscalationInfo(report.escalationLevel);
  const lines: string[] = [];
  // The verdict is the headline — bold + severity color, matching how
  // printScanSummary renders the health score (output.ts:487-490). chalk
  // emits nothing when --no-color or pipe mode set chalk.level = 0, so
  // substring assertions in tests are unaffected.
  lines.push(chalk.bold(triageVerdictColor(report.verdict)(VERDICT_HEADLINE[report.verdict])));
  lines.push(report.explanation);
  lines.push(`Next: ${report.nextStep}`);
  lines.push('');
  lines.push('Layers checked:');
  for (const layer of report.layers) {
    lines.push(`  ${LAYER_ICON[layer.status]} ${layer.layer} — ${layer.detail}`);
  }
  lines.push('');
  lines.push(`Observer: ${report.observerContext} (${report.observerContextEvidence})`);
  lines.push(`Escalation: ${escalation.label} — ${escalation.description}`);
  lines.push(`Checked at ${report.checkedAt} (${report.durationMs}ms)`);
  return lines;
}

export function renderTriagePipe(report: TriageReport): string[] {
  const lines = [`triage\t${report.verdict}\t${report.checkedAt}\t${report.durationMs}`];
  for (const layer of report.layers) {
    lines.push(`layer\t${layer.layer}\t${layer.status}\t${layer.detail}`);
  }
  return lines;
}

/**
 * Targets for layer 6: configured targets first (their names are what the
 * operator recognizes), then autodiscovered services that aren't already
 * covered, deduped by host:port.
 */
export async function resolveTriageTargets(configPath?: string): Promise<TriageTarget[]> {
  const byEndpoint = new Map<string, TriageTarget>();

  let configured: TriageTarget[] = [];
  try {
    const { config } = loadConfigWithDetection(configPath !== undefined ? { configPath } : {});
    configured = (config?.targets ?? [])
      .filter((t) => t.primary !== undefined)
      .map((t) => ({ host: t.primary!.host, port: t.primary!.port, label: t.name }));
  } catch (err) {
    // An explicitly named config file that doesn't exist is a user error.
    if (err instanceof ConfigNotFoundError) throw err;
  }
  for (const target of configured) {
    byEndpoint.set(`${target.host}:${target.port}`, target);
  }

  const profile = await discoverStack();
  for (const service of profile.services) {
    if (!service.detected) continue;
    const key = `${service.host}:${service.port}`;
    if (!byEndpoint.has(key)) {
      byEndpoint.set(key, { host: service.host, port: service.port, label: service.kind });
    }
  }

  return [...byEndpoint.values()];
}

export async function runTriageCommand(opts: TriageCommandOptions = {}): Promise<number> {
  const targets = await resolveTriageTargets(opts.configPath);
  const report = await runTriage({ targets });

  const mode = getOutputMode();
  if (mode === 'machine') {
    jsonOut('triage', report);
  } else if (mode === 'pipe') {
    for (const line of renderTriagePipe(report)) console.log(line);
  } else {
    printBanner();
    for (const line of renderTriageReport(report)) printInfo(line);
  }

  const code = triageExitCode(report.verdict);
  process.exitCode = code;
  return code;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/triage-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/triage.ts src/cli/status-presentation.ts src/__tests__/triage-cli.test.ts
git commit -m "feat(triage): add the crisismode triage command with documented exit codes"
```

---

### Task 10: Register the command (CLI router, help, completions)

**Files:**
- Modify: `src/cli/index.ts:25-73` (HELP), `:147-334` (command switch)
- Modify: `src/cli/commands/completions.ts:20` (bash commands), `:35-76` (bash cases), `:99-112` (zsh subcommands), `:116-197` (zsh args), `:211-222` (fish subcommands)
- Test: `src/__tests__/triage-cli.test.ts` (append), `src/__tests__/completions.test.ts` (append)

**Interfaces:**
- Consumes: `runTriageCommand` from `src/cli/commands/triage.ts` (Task 9).
- Produces: the `triage` subcommand, reachable as `crisismode triage [--config <path>] [--json] [--no-color] [--verbose]`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-cli.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('CLI registration', () => {
  const indexSource = readFileSync(
    fileURLToPath(new URL('../cli/index.ts', import.meta.url)),
    'utf-8',
  );

  it('routes the triage subcommand to runTriageCommand', () => {
    expect(indexSource).toContain("case 'triage':");
    expect(indexSource).toContain("await import('./commands/triage.js')");
    expect(indexSource).toContain('runTriageCommand');
  });

  it('documents triage in the help text', () => {
    expect(indexSource).toContain('crisismode triage');
  });
});
```

Add this test to `src/__tests__/completions.test.ts` **inside** the existing `describe('Shell completions (6.2)', ...)` block — as a new `it(...)` alongside the current ones, not appended at file scope. It reassigns `stdoutChunks`, which only exists in that block's `beforeEach` closure; at file scope it will not compile.

```ts
  it('completes the triage command in every shell', async () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      stdoutChunks = [];
      await runCompletions(shell);
      expect(stdoutChunks.join('')).toContain('triage');
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/triage-cli.test.ts src/__tests__/completions.test.ts`
Expected: FAIL — `case 'triage':` is not in `src/cli/index.ts` and no completion script mentions `triage`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/index.ts`, add to the usage comment block and the `HELP` string, directly after the `crisismode status` line:

```
    crisismode triage                       Is it me, my network, or them? (exit 1 when local/network/mixed)
```

Add the route in the command switch, after the `case 'status'` block:

```ts
    case 'triage': {
      const { runTriageCommand } = await import('./commands/triage.js');
      await runTriageCommand({ configPath: values.config as string | undefined });
      break;
    }
```

In `src/cli/commands/completions.ts`:

- bash — add `triage` to the `commands` list:
  ```
  local commands="scan triage diagnose recover status init demo webhook ask watch mcp completions registry"
  ```
  and add a case alongside `status)`:
  ```
    triage)
      COMPREPLY=( $(compgen -W "--config --json --no-color --verbose -h --help" -- "\${cur}") )
      ;;
  ```
- zsh — add to the `subcommands` array:
  ```
        'triage:Is it me, my network, or them? (offline localization)'
  ```
  and add to the `args` case:
  ```
        triage)
          _arguments \\
            '--config[Path to crisismode.yaml]:config file:_files' \\
            '--json[Machine-readable JSON output]' \\
            '--no-color[Disable colored output]' \\
            '--verbose[Show additional detail]' \\
            {-h,--help}'[Show help]'
          ;;
  ```
- fish — add a subcommand line after `scan`:
  ```
  complete -c crisismode -n '__fish_use_subcommand' -a triage      -d 'Is it me, my network, or them? (offline localization)'
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/triage-cli.test.ts src/__tests__/completions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/commands/completions.ts src/__tests__/triage-cli.test.ts src/__tests__/completions.test.ts
git commit -m "feat(triage): register the triage command in the CLI router and completions"
```

---

### Task 11: Observer reframe for scan findings

**Files:**
- Create: `src/cli/observer-reframe.ts`
- Modify: `src/cli/output.ts:437-448` (`ScanFinding`)
- Test: `src/__tests__/observer-reframe.test.ts`

**Interfaces:**
- Consumes: `TriageReport`, `primaryFailureCode`, `layerCauseLabel` (Tasks 1-2); `ScanFinding` from `src/cli/output.ts`.
- Produces: `ObserverReframe` (`{ verdict: 'local' | 'network'; findingIds: string[]; cause: string; headline: string; nextStep: string }`), `isUnreachableFinding(finding: ScanFinding): boolean`, `reframeFindings(findings: ScanFinding[], report: TriageReport): { findings: ScanFinding[]; reframe: ObserverReframe | null }`; and `ScanFinding.possiblyObserverCaused?: boolean`. Task 12 renders `ObserverReframe`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/observer-reframe.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { isUnreachableFinding, reframeFindings } from '../cli/observer-reframe.js';
import type { ScanFinding } from '../cli/output.js';
import type { TriageReport } from '../framework/triage.js';

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    id: 'PG-001',
    service: 'postgresql (main-pg)',
    status: 'unknown',
    summary: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    confidence: 0,
    escalationLevel: 2,
    signals: [],
    ...over,
  };
}

function reportWith(verdict: TriageReport['verdict']): TriageReport {
  return {
    verdict,
    explanation: 'explanation',
    nextStep: 'Fix this machine\'s DNS settings.',
    observerContext: 'laptop',
    observerContextEvidence: 'test fixture',
    escalationLevel: 2,
    checkedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 900,
    layers: [
      { layer: 'interfaces', status: 'pass', detail: 'en0', durationMs: 1 },
      { layer: 'dns', status: 'fail', code: 'resolver-broken', detail: 'system resolver failed', durationMs: 40 },
    ],
  };
}

describe('isUnreachableFinding', () => {
  it('matches a connection error on an unknown finding', () => {
    expect(isUnreachableFinding(finding())).toBe(true);
  });

  it('matches an unreachable signal on an unhealthy finding', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replica lag unknown',
      signals: [{ status: 'critical', detail: 'host unreachable: EHOSTUNREACH', source: 'pg_connection' }],
    }))).toBe(true);
  });

  it('does not match a healthy finding', () => {
    expect(isUnreachableFinding(finding({ status: 'healthy', summary: 'All good' }))).toBe(false);
  });

  it('does not match a degraded-but-reachable service', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replication lag is 45s and growing',
    }))).toBe(false);
  });

  // A service-level timeout is a real outage reported BY a reachable service.
  // Matching it here would collapse a genuine incident out of human output
  // whenever triage happened to blame the network.
  it('does not match service-level timeouts', () => {
    for (const summary of [
      'canceling statement due to statement_timeout',
      'ERROR: canceling statement due to lock_timeout',
      'BLPOP timed out after 30s',
      'Query timeout: 5 queries exceeded 30s',
    ]) {
      expect(isUnreachableFinding(finding({ status: 'unhealthy', summary }))).toBe(false);
    }
  });

  it('still matches an ETIMEDOUT errno, which is unambiguous', () => {
    expect(isUnreachableFinding(finding({
      summary: 'Error: connect ETIMEDOUT 10.0.0.5:5432',
    }))).toBe(true);
  });
});

describe('reframeFindings', () => {
  const unreachable = finding();
  const lagging = finding({ id: 'REDIS-001', status: 'unhealthy', summary: 'Memory usage at 95%' });

  it('leaves findings untouched when the verdict is healthy', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('healthy'));
    expect(result.reframe).toBeNull();
    expect(result.findings[0]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leaves findings untouched when the verdict is remote', () => {
    expect(reframeFindings([unreachable], reportWith('remote')).reframe).toBeNull();
  });

  it('flags only the unreachable findings when the verdict is local', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('local'));
    expect(result.reframe).not.toBeNull();
    expect(result.reframe!.findingIds).toEqual(['PG-001']);
    expect(result.findings[0]!.possiblyObserverCaused).toBe(true);
    expect(result.findings[1]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leads the headline with the count and the named cause', () => {
    const { reframe } = reframeFindings([unreachable], reportWith('network'));
    expect(reframe!.headline).toContain('1 service appears unreachable');
    expect(reframe!.headline).toContain('DNS resolver');
    expect(reframe!.headline).toContain('Fix that first.');
    expect(reframe!.nextStep).toBe('Fix this machine\'s DNS settings.');
  });

  it('pluralizes the headline for several findings', () => {
    const { reframe } = reframeFindings([unreachable, finding({ id: 'REDIS-002' })], reportWith('network'));
    expect(reframe!.headline).toContain('2 services appear unreachable');
  });

  it('returns no reframe when nothing looks unreachable', () => {
    expect(reframeFindings([lagging], reportWith('local')).reframe).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/observer-reframe.test.ts`
Expected: FAIL — cannot resolve `src/cli/observer-reframe.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/observer-reframe.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Observer reframe — when triage says the problem is this machine or its
 * network, "six services are down" is the wrong headline. This module groups
 * the unreachable-service findings and attributes them to the observer, so
 * scan leads with the one thing worth fixing first.
 *
 * Deterministic and presentation-only: no finding is removed, no count and no
 * score changes. Machine output keeps every finding, flagged with
 * `possiblyObserverCaused`; human output collapses them under the reframe.
 */

import { layerCauseLabel, primaryFailureCode } from '../framework/triage.js';
import type { TriageReport } from '../framework/triage.js';
import type { ScanFinding } from './output.js';

export interface ObserverReframe {
  /** Only local and network verdicts reframe anything. */
  verdict: 'local' | 'network';
  /** IDs of the findings attributed to the observer's own machine/network. */
  findingIds: string[];
  /** Plain-language cause, named in the headline. */
  cause: string;
  /** The line human output leads with. */
  headline: string;
  nextStep: string;
}

/**
 * Connection-level failures only.
 *
 * Deliberately does NOT include bare `timeout` / `timed out`: those match
 * `statement_timeout`, `lock_timeout`, and `BLPOP timed out` — real service
 * outages that have nothing to do with the observer's network. Collapsing
 * those out of human output under a local/network verdict would hide a
 * genuine incident, which is far worse than showing one finding that turns
 * out to be observer-caused. `ETIMEDOUT` (the errno) stays, because it is
 * unambiguous; the English phrase does not.
 */
const UNREACHABLE_PATTERN =
  /unreachable|econnrefused|etimedout|ehostunreach|enetunreach|enotfound|eai_again|getaddrinfo|connection refused|connect failed/i;

/**
 * Does this finding look like "we could not reach the service" rather than
 * "the service told us something is wrong"? Only the former can be explained
 * by the observer's own network.
 */
export function isUnreachableFinding(finding: ScanFinding): boolean {
  if (finding.status !== 'unhealthy' && finding.status !== 'unknown') return false;
  if (UNREACHABLE_PATTERN.test(finding.summary)) return true;
  return finding.signals.some((s) => UNREACHABLE_PATTERN.test(s.detail));
}

export function reframeFindings(
  findings: ScanFinding[],
  report: TriageReport,
): { findings: ScanFinding[]; reframe: ObserverReframe | null } {
  if (report.verdict !== 'local' && report.verdict !== 'network') {
    return { findings, reframe: null };
  }

  const affected = findings.filter(isUnreachableFinding);
  if (affected.length === 0) return { findings, reframe: null };

  const code = primaryFailureCode(report.layers);
  const cause = code === null ? 'a network check on this machine failed' : layerCauseLabel(code);
  const affectedIds = new Set(affected.map((f) => f.id));
  const flagged = findings.map((f) => (affectedIds.has(f.id) ? { ...f, possiblyObserverCaused: true } : f));
  const subject = affected.length === 1 ? 'service appears' : 'services appear';

  return {
    findings: flagged,
    reframe: {
      verdict: report.verdict,
      findingIds: affected.map((f) => f.id),
      cause,
      headline: `${affected.length} ${subject} unreachable, but the likely cause is this machine\'s network (${cause}). Fix that first.`,
      nextStep: report.nextStep,
    },
  };
}
```

In `src/cli/output.ts`, add to the `ScanFinding` interface:

```ts
  /** Triage attributed this unreachable finding to the observer's own machine/network. */
  possiblyObserverCaused?: boolean;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/observer-reframe.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/observer-reframe.ts src/cli/output.ts src/__tests__/observer-reframe.test.ts
git commit -m "feat(triage): attribute unreachable scan findings to the observer when triage localizes"
```

---

### Task 12: Scan step 0 — run triage and render the reframe

**Files:**
- Modify: `src/cli/output.ts:456-468` (`ScanResult`), `:470-546` (`printScanSummary`), plus a new `printTriageContext`
- Modify: `src/cli/commands/scan.ts:253-478` (`runScan`)
- Test: `src/__tests__/observer-reframe.test.ts` (append rendering tests)

**Interfaces:**
- Consumes: `runTriage`, `SCAN_PROBE_TIMEOUT_MS`, `TriageReport` (Tasks 1-8); `reframeFindings`, `ObserverReframe` (Task 11).
- Produces: `ScanResult.triage?: TriageReport`, `ScanResult.observerReframe?: ObserverReframe`, `ScanOptions.triageReport?: TriageReport | undefined`, `printTriageContext(report: TriageReport): void`, and `printScanSummary` collapsing reframed findings in human mode.

`ScanOptions.triageReport` is an injection point (beyond spec, deliberate): it lets a test drive the whole `Promise.all` → reframe → `ScanResult` path with a known verdict and no live network. The CLI never sets it.

Two deliberate non-changes:
- **Scan runs layers 1-5 only.** `runTriage` is called with no `targets`, so layer 6 is skipped — scan's own agents already probe every target, and re-probing them would double the wall-clock cost of step 0. The standalone `crisismode triage` command is the surface that runs layer 6.
- **`src/framework/root-cause-synthesis.ts` is not touched.** Its `observer-environment` correlation rule (`root-cause-synthesis.ts:171`) becomes largely redundant for this path, but the rule set is frozen and the freeze policy is about additions. Scan's deterministic reframe simply takes precedence in presentation.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/observer-reframe.test.ts` (extend the file's existing vitest import with `vi`, `beforeEach`, and `afterEach` rather than adding a second one; the `finding()` and `reportWith()` helpers from Task 11 are reused):

```ts
import { configure, printScanSummary, printTriageContext } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';

describe('scan rendering with a reframe', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  const base: ScanResult = {
    score: 30,
    findings: [
      { ...finding(), possiblyObserverCaused: true },
      finding({ id: 'REDIS-001', status: 'unhealthy', summary: 'Memory usage at 95%' }),
    ],
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 900,
  };

  const reframe = {
    verdict: 'network' as const,
    findingIds: ['PG-001'],
    cause: 'DNS is not resolving from this machine',
    headline: '1 service appears unreachable, but the likely cause is this machine\'s network (DNS is not resolving from this machine). Fix that first.',
    nextStep: 'Check the network you are on.',
  };

  it('leads with the reframe and collapses the attributed finding in human mode', () => {
    configure({ noColor: true, mode: 'human' });
    printScanSummary({ ...base, observerReframe: reframe });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('1 service appears unreachable');
    expect(out).toContain('Check the network you are on.');
    // The reframed finding is collapsed, not listed with the real service problems.
    expect(out).not.toContain('connect ECONNREFUSED');
    // Findings triage cannot explain are still shown.
    expect(out).toContain('Memory usage at 95%');
  });

  it('keeps every finding and the triage report in machine mode', () => {
    configure({ json: true });
    printScanSummary({ ...base, observerReframe: reframe, triage: reportWith('network') });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.type).toBe('scan');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].possiblyObserverCaused).toBe(true);
    expect(parsed.observerReframe.findingIds).toEqual(['PG-001']);
    expect(parsed.triage.verdict).toBe('network');
  });

  it('lists findings normally when there is no reframe', () => {
    configure({ noColor: true, mode: 'human' });
    printScanSummary(base);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('connect ECONNREFUSED');
  });
});

describe('printTriageContext', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    configure({ noColor: true, mode: 'human' });
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  it('notes that triage passed for a healthy verdict', () => {
    printTriageContext(reportWith('healthy'));
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('triage passed');
  });

  it('says nothing when the verdict already produced a reframe', () => {
    printTriageContext(reportWith('network'));
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// The wiring test: unit tests cover reframeFindings and the renderers, but
// only this covers runScan's Promise.all -> reframe -> ScanResult path. The
// injected report keeps it off the network; findings still depend on what is
// running locally, so assertions are about relationships, not fixed values.
describe('runScan step 0 wiring', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Machine mode keeps the console quiet and the output structured.
    configure({ json: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // runScan calls generatePlainEnglishSummary, which makes a real Anthropic
    // API call when a key is present. A unit test must never do that.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    configure({ json: false, noColor: false, verbose: false });
    resetNetworkProfile();
    resetTriageReport();
  });

  it('carries the injected triage report into the result and flags only unreachable findings', async () => {
    const { runScan } = await import('../cli/commands/scan.js');
    const injected = reportWith('network');

    const result = await runScan({ triageReport: injected });

    expect(result.triage).toBe(injected);
    // Every flagged finding is one isUnreachableFinding would have picked.
    for (const f of result.findings) {
      if (f.possiblyObserverCaused === true) expect(isUnreachableFinding(f)).toBe(true);
    }
    // And the reframe exists exactly when there was something to reframe.
    const hasUnreachable = result.findings.some(isUnreachableFinding);
    expect(result.observerReframe !== undefined).toBe(hasUnreachable);
    if (result.observerReframe) {
      expect(result.observerReframe.findingIds.length).toBeGreaterThan(0);
      expect(result.observerReframe.headline).toContain('Fix that first.');
    }
  }, 30_000);

  it('leaves findings unflagged when the injected verdict is healthy', async () => {
    const { runScan } = await import('../cli/commands/scan.js');

    const result = await runScan({ triageReport: reportWith('healthy') });

    expect(result.observerReframe).toBeUndefined();
    expect(result.findings.every((f) => f.possiblyObserverCaused === undefined)).toBe(true);
  }, 30_000);
});
```

This test file now imports `resetNetworkProfile` from `../framework/network-profile.js` and `resetTriageReport` from `../framework/triage.js` — add them to the import block at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/observer-reframe.test.ts`
Expected: FAIL — `printTriageContext` is not exported and `ScanResult` has no `observerReframe`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/output.ts`, add the type imports:

```ts
import type { TriageReport } from '../framework/triage.js';
import type { ObserverReframe } from './observer-reframe.js';
```

Extend `ScanResult`:

```ts
  /** Step-0 triage report: is the problem this machine, the network, or the services? */
  triage?: TriageReport;
  /** Present when triage attributed unreachable findings to this machine/network. */
  observerReframe?: ObserverReframe;
```

In `printScanSummary`, replace the human-mode finding grouping so the reframe leads and the attributed findings are collapsed. After the `if (result.findings.length === 0) { ... }` early return, insert:

```ts
  // Observer reframe — "six services are down" is the wrong headline when the
  // cause is this machine's network. Lead with the cause, collapse the rest.
  const reframe = result.observerReframe;
  const reframedIds = new Set(reframe?.findingIds ?? []);
  if (reframe) {
    console.log(chalk.yellow.bold('  LIKELY THIS MACHINE, NOT YOUR SERVICES'));
    console.log(chalk.yellow(`    ${reframe.headline}`));
    console.log(chalk.dim(`    Next: ${reframe.nextStep}`));
    console.log(chalk.dim(`    Collapsed ${reframe.findingIds.length} unreachable finding(s): ${reframe.findingIds.join(', ')}`));
    console.log(chalk.dim('    Run `crisismode triage` for the per-layer detail.'));
    console.log('');
  }
  const presented = result.findings.filter((f) => !reframedIds.has(f.id));
```

and change the four grouping lines to filter `presented` instead of `result.findings`:

```ts
  const unhealthy = presented.filter((f) => f.status === 'unhealthy');
  const recovering = presented.filter((f) => f.status === 'recovering');
  const unknown = presented.filter((f) => f.status === 'unknown');
  const healthy = presented.filter((f) => f.status === 'healthy');
```

Add, next to `printVisibility`:

```ts
/**
 * One line of context when triage found nothing wrong locally. When triage
 * did localize the problem, the reframe in printScanSummary already says so,
 * and repeating it here would be noise.
 */
export function printTriageContext(report: TriageReport): void {
  if (outputOptions.mode !== 'human') return;
  if (report.verdict !== 'healthy' && report.verdict !== 'remote') return;
  const detail = report.verdict === 'healthy'
    ? 'triage passed — this machine, its DNS, and its internet path look healthy'
    : 'triage passed — this machine and its network are fine; the services did not answer';
  console.log(chalk.dim(`  Network path: ${detail}`));
  console.log('');
}
```

In `src/cli/commands/scan.ts`, add the imports:

```ts
import { runTriage, SCAN_PROBE_TIMEOUT_MS } from '../../framework/triage.js';
import { reframeFindings } from '../observer-reframe.js';
import type { TriageReport } from '../../framework/triage.js';
```

and `printTriageContext` to the existing import list from `../output.js`. Extend `ScanOptions` (`scan.ts:44-48`):

```ts
  /** Injected step-0 triage report. Tests only — the CLI never sets this. */
  triageReport?: TriageReport | undefined;
```

Run triage as step 0, in the existing Phase 1 `Promise.all` (it needs no config, and running it concurrently keeps it off the critical path):

```ts
  // Phase 1: Discovery, plus step-0 triage (is it this machine, the network,
  // or the services?). Triage also populates the cached NetworkProfile that
  // generatePlainEnglishSummary's offline gate reads later in this function.
  const [stackProfile, configDetection, triageReport] = await Promise.all([
    discoverStack(),
    loadConfigWithDetectionSafe(opts.configPath),
    opts.triageReport !== undefined
      ? Promise.resolve(opts.triageReport)
      : runTriage({ timeoutMs: SCAN_PROBE_TIMEOUT_MS }),
  ]);
```

After the plugin findings are pushed and before `// Phase 3: Detect recent changes`, apply the reframe:

```ts
  // Reframe unreachable-service findings when triage blames this machine.
  const { findings: presentedFindings, reframe } = reframeFindings(findings, triageReport);
```

Change the `ScanResult` construction to use the reframed findings and carry the triage context:

```ts
  const result: ScanResult = {
    score,
    findings: presentedFindings,
    recentChanges,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    triage: triageReport,
    ...(reframe !== null ? { observerReframe: reframe } : {}),
  };
```

and change `computeHealthScore(findings)` to `computeHealthScore(presentedFindings)` (identical values — the reframe only adds a flag — but it keeps score and findings derived from the same array).

Finally, print the triage context line after the visibility report:

```ts
  printScanSummary(result);
  printVisibility(result.visibility);
  printTriageContext(triageReport);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/observer-reframe.test.ts src/__tests__/scan.test.ts src/__tests__/cli-output.test.ts src/__tests__/cli-snapshots.test.ts`
Expected: PASS. If a scan snapshot changed because of the new "Network path:" line, review the diff and update it with `pnpm vitest run src/__tests__/cli-snapshots.test.ts -u`.

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/scan.ts src/cli/output.ts src/__tests__/observer-reframe.test.ts src/__tests__/__snapshots__
git commit -m "feat(triage): run triage as scan step 0 and reframe observer-caused findings"
```

---

### Task 13: Share the bounded-execution machinery with network-profile.ts

**Files:**
- Modify: `src/framework/network-profile.ts:131-199` (`probeDns`, `probeEndpoints`, `probeHub`, `probeTcp`)
- Test: `src/__tests__/network-profile.test.ts` (append)

**Interfaces:**
- Consumes: `runBounded`, `probeTcpBounded` from `src/framework/triage-probes.ts` (Task 6).
- Produces: no new exports, and **no behavior change** — `probeNetwork` returns exactly what it returns today.

Why: the spec's `Relationship to the cached NetworkProfile` section ends with "`probeNetwork` remains for callers that need only the lightweight profile (diagnose), **internally sharing the same probe implementations**." Two hand-maintained copies of the timeout/cancel machinery is exactly the setup that produced B1 and B2 — one copy bounded, the other not. This closes it.

**Share the bounding, not the resolution.** The two DNS probes answer different questions and both are right:

| | question | API | why |
|---|---|---|---|
| `network-profile.ts` `probeDns` | can this machine resolve names *the way the user's app does*? | `lookup()` / getaddrinfo | must honor `/etc/hosts` and nsswitch — that is the app's experience |
| triage `boundedResolve` | is the *resolver* broken, or the *network*? | raw resolver queries | must bypass local files and ask named servers directly to isolate the layer |

So `probeDns` keeps `lookup()` and only its timeout plumbing moves to `runBounded`. Collapsing the two would silently change what `assessEnvironment` and the offline gate report for a host resolving via its hosts file.

`probeTcp` is a pure move: identical logic, identical `ProbeResult` shape, same 3s budget.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/network-profile.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probeTcpBounded } from '../framework/triage-probes.js';

describe('shared bounded-execution machinery', () => {
  it('probeTcpBounded produces the ProbeResult shape probeNetwork returns', async () => {
    const shared = await probeTcpBounded('127.0.0.1', 1, 'closed-port', 500);
    const profile = await probeNetwork({ targets: [{ host: '127.0.0.1', port: 1, label: 'closed-port' }] });
    const viaProfile = profile.targets.probes[0]!;

    expect(Object.keys(shared).sort()).toEqual(Object.keys(viaProfile).sort());
    expect(shared.target).toBe(viaProfile.target);
    expect(shared.reachable).toBe(false);
    expect(viaProfile.reachable).toBe(false);
    expect(typeof viaProfile.latencyMs).toBe('number');
  });

  // This module and triage answer different DNS questions on purpose. The
  // behavioral difference only shows up on hosts where getaddrinfo and a raw
  // query disagree (hosts-file entries, split-DNS), so a runtime assertion
  // would pass on most machines even after a wrong swap. Assert the API.
  it('probeDns still asks the getaddrinfo question, not a raw resolver query', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../framework/network-profile.ts', import.meta.url)),
      'utf-8',
    );
    expect(source).toContain('lookup');
    expect(source).not.toContain('boundedResolve');
    // ...while still delegating the timeout plumbing to the shared helper.
    expect(source).toContain('runBounded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/network-profile.test.ts`
Expected: FAIL — `network-profile.ts` does not reference `runBounded` yet (and `probeTcpBounded` is not exported if Task 6 was skipped).

- [ ] **Step 3: Write minimal implementation**

In `src/framework/network-profile.ts`, delete the local `probeTcp` (lines ~163-199) and the local `withTimeout` (lines ~237-245), then re-point the call sites. Keep the `lookup` import from `node:dns/promises` — it is the whole point of this module's DNS probe.

```ts
import { runBounded, probeTcpBounded } from './triage-probes.js';
```

```ts
/**
 * Can this machine resolve names the way an application would? Uses
 * getaddrinfo (honoring /etc/hosts and nsswitch) rather than a raw resolver
 * query, because that is what the user's app experiences. Triage asks the
 * narrower "is it the resolver or the network" question and uses raw queries
 * for it — see boundedResolve in triage-probes.ts. Only the timeout plumbing
 * is shared; getaddrinfo offers no cancellation, so there is no cancel hook.
 */
async function probeDns(): Promise<{ available: boolean; latencyMs: number }> {
  const outcome = await runBounded(() => lookup(DNS_TEST_HOST), PROBE_TIMEOUT_MS);
  return { available: outcome.ok, latencyMs: outcome.durationMs };
}

async function probeEndpoints(
  endpoints: Array<{ host: string; port: number; label: string }>,
): Promise<ProbeResult[]> {
  return Promise.all(endpoints.map((ep) => probeTcpBounded(ep.host, ep.port, ep.label, PROBE_TIMEOUT_MS)));
}
```

and in `probeHub`, replace `probeTcp(host, port, 'hub')` with `probeTcpBounded(host, port, 'hub', PROBE_TIMEOUT_MS)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/network-profile.test.ts src/__tests__/environment-guard.test.ts src/__tests__/live-environment-guard.test.ts`
Expected: PASS, with no changes to any existing assertion. This task is a pure refactor — if an existing test fails, the refactor changed behavior. Stop and restore the behavior; do not edit the test.

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/framework/network-profile.ts src/__tests__/network-profile.test.ts
git commit -m "refactor(triage): share one bounded-execution helper with network-profile"
```

---

### Task 14: Document the command and verify it live

**Files:**
- Modify: `README.md:270-300` (command list), `:307-311` (JSON output types)
- Modify: `CLAUDE.md` (CLI command table, Key Files table)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-13.
- Produces: no code. This task makes the command discoverable and confirms it works on a real machine.

- [ ] **Step 1: Update the README command list**

In the command block, after the `crisismode status` line, add:

```
crisismode triage                     # Is it me, my network, or them? Offline localization — exits 1 when the cause is this machine or its network
```

- [ ] **Step 2: Update the README JSON output table**

Add a row to the JSON type table:

```
| `triage` | Localization verdict (`local`/`network`/`remote`/`mixed`/`healthy`) with per-layer results. Exit code 0 for `healthy`/`remote`, 1 for `local`/`network`/`mixed` |
```

- [ ] **Step 3: Update CLAUDE.md**

Add to the CLI command table, after the `status` row:

```
| `triage` | Offline localization: is the problem this machine, its network, or the remote services? (exit 1 on local/network/mixed) |
```

Add to the Key Files table:

```
| `src/framework/triage.ts` | Offline triage — layered localization and verdict synthesis |
| `src/framework/triage-probes.ts` | Node implementations of the triage probes (built-ins only) |
| `src/cli/commands/triage.ts` | `crisismode triage` command and exit-code contract |
```

- [ ] **Step 4: Verify the healthy path on the real machine**

Run:
```bash
pnpm dev --help >/dev/null 2>&1 || true
npx tsx src/cli/index.ts triage; echo "exit=$?"
npx tsx src/cli/index.ts triage --json | head -1
```
Expected: a verdict of `healthy` or `remote` on a normally connected machine, `exit=0`, the whole run completing in a few seconds, and one JSON line whose `type` is `triage`.

- [ ] **Step 5: Verify the offline path**

Turn off Wi-Fi (or run `sudo ifconfig en0 down` on macOS / `nmcli networking off` on Linux — reverse it afterwards), then run:
```bash
time npx tsx src/cli/index.ts triage; echo "exit=$?"
```
Expected: completes in ≤ 5s, prints a `local` or `network` verdict with a named cause and next step, and `exit=1`. Turn networking back on and re-run to confirm it returns to `healthy`/`remote`.

- [ ] **Step 6: Verify the scan reframe**

With networking still off, run:
```bash
npx tsx src/cli/index.ts scan | head -40
npx tsx src/cli/index.ts scan --json | jq 'select(.type == "scan") | {reframe: .observerReframe.headline, flagged: [.findings[] | select(.possiblyObserverCaused) | .id]}'
```
Expected: human output leads with "LIKELY THIS MACHINE, NOT YOUR SERVICES" rather than a list of down services; JSON output keeps every finding, with the unreachable ones carrying `possiblyObserverCaused: true`.

- [ ] **Step 7: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(triage): document the triage command, exit codes, and JSON output"
```

---

## Acceptance Criteria (from the spec)

- `crisismode triage` completes in ≤ 5s offline, with no API key and no internet, and prints a correct `local`/`network` verdict when the machine's network is down. Enforced in three places, because this one criterion is where the plan was weakest on first review: the bounded DNS probe (Task 6) is what keeps the offline verdict `local`/`network` rather than a timed-out `mixed`; the whole-run deadline test (Task 7) makes ≤5s a property; Task 14 steps 5-6 confirm it on real hardware.
- `crisismode scan` with an unreachable stack and broken local DNS leads with the observer reframe, not one down-service finding per target. (Tasks 11-12, including the `runScan` wiring test; verified live in Task 14 step 6.)
- Zero new package.json dependencies. (Global constraints; confirm with `git diff --stat package.json` — it must be empty.)
