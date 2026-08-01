# Vibe-Coder UX Arc 1: Plain-Language & Honesty Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scan` explain findings in plain language, report what CrisisMode can/can't see, and frame recovery risk as consequences — default-on, static-first, `--terse` to suppress.

**Architecture:** All presentation-layer. Reuse the existing `signal-explanations.ts` knowledge map (today wired only into `diagnose`) by retaining signal sources through scan's finding assembly. Add a pure `visibility.ts` builder over the `StackProfile` autodiscovery already produces. Add a pure `risk-framing.ts` builder over the safety fields plans already carry. Enforce explanation coverage with a registry-walking test.

**Tech Stack:** TypeScript strict/ESM (imports use `.js` extensions, named exports only), vitest, chalk. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-01-vibe-coder-ux-arc1-design.md`

## Global Constraints

- Static-first: every new output works with no `ANTHROPIC_API_KEY` and no network.
- Plain language is ON by default in human mode; `--terse` suppresses it (human mode only).
- Machine (`--json`) output changes are strictly additive — never rename/remove existing fields.
- TDD per task: failing test → verify RED → minimal code → verify GREEN → commit.
- Run `pnpm vitest run <testfile>` for the task's tests; before each commit run `pnpm test && pnpm run typecheck && pnpm run lint`.
- Conventional commits. Branch: `feat/vibe-coder-ux-arc1` (create from `main` at Task 1 Step 1).
- Match surrounding code style; comments only for non-obvious constraints.

---

### Task 1: `--terse` output option

**Files:**
- Modify: `src/cli/output.ts` (the `outputOptions` module state and its setter)
- Modify: `src/cli/index.ts` (scan flag parsing at the `case 'scan':` block ~line 144 and the default-command block ~line 314; help text ~line 60)
- Modify: `src/cli/commands/scan.ts` (`ScanOptions` interface, ~line 41)
- Test: `src/__tests__/output-terse.test.ts` (create)

**Interfaces:**
- Produces: `outputOptions.terse: boolean` (default `false`) readable by every print function in `output.ts`; `setOutputOptions({ terse?: boolean })` accepts it; `ScanOptions.terse?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/output-terse.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { outputOptions, setOutputOptions } from '../cli/output.js';

describe('terse output option', () => {
  afterEach(() => setOutputOptions({ mode: 'human', terse: false }));

  it('defaults to false', () => {
    expect(outputOptions.terse).toBe(false);
  });

  it('is settable via setOutputOptions', () => {
    setOutputOptions({ terse: true });
    expect(outputOptions.terse).toBe(true);
  });

  it('is not reset by unrelated option updates', () => {
    setOutputOptions({ terse: true });
    setOutputOptions({ mode: 'pipe' });
    expect(outputOptions.terse).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/output-terse.test.ts`
Expected: FAIL — `outputOptions.terse` is `undefined` (property does not exist).
Note: first read `src/cli/output.ts` around the existing `outputOptions` /
`setOutputOptions` definitions (search for `setOutputOptions`) and mirror the
existing option shape exactly; if the existing setter replaces rather than
merges, adjust the third test's expectation to match a merge-preserving
implementation you add.

- [ ] **Step 3: Implement**

In `src/cli/output.ts`, add `terse: boolean` (default `false`) to the output
options state and let `setOutputOptions` accept and merge it. In
`src/cli/commands/scan.ts` add `terse?: boolean` to `ScanOptions` and, at the
top of `runScan`, call `setOutputOptions({ terse: opts.terse ?? false })`
alongside however mode is currently set (search `setOutputOptions` in the scan
path — if scan sets options in `index.ts` instead, do it there). In
`src/cli/index.ts`, parse `--terse` in the scan case and default-command case:

```ts
const terse = args.includes('--terse');
```

and pass `{ ...existingOpts, terse }` to `runScan`. Add to the help text:
`    --terse             Suppress plain-language explanations (scan)`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/output-terse.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(cli): add --terse flag and terse output option"
```

---

### Task 2: Retain signal sources and enrich scan findings

**Files:**
- Modify: `src/cli/output.ts:416-424` (`ScanFinding` interface)
- Modify: `src/cli/commands/scan.ts` (finding assembly, ~lines 245-282 — the
  `signals: health.signals.map(...)` expression and the enrichment hook)
- Test: `src/__tests__/scan-explanations.test.ts` (create)

**Interfaces:**
- Consumes: `explainSourceInContext(source, ctx)` and `ExplanationContext` from `src/framework/signal-explanations.js`; `StackProfile.platform` from `src/cli/autodiscovery.js`.
- Produces: `ScanFinding.signals` entries gain optional `source?: string`; `ScanFinding` gains optional `explanation?: string` and `learnMoreUrl?: string`; exported pure helper `enrichScanFinding` in `scan.ts`:

```ts
export function enrichScanFinding<T extends {
  status: string;
  signals: Array<{ status: string; detail: string; source?: string }>;
  explanation?: string;
  learnMoreUrl?: string;
}>(finding: T, ctx: ExplanationContext): T
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/scan-explanations.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { enrichScanFinding } from '../cli/commands/scan.js';

const ctx = { serverless: false };

describe('enrichScanFinding', () => {
  it('attaches explanation from the first non-healthy signal with a map hit', () => {
    const finding = {
      status: 'unhealthy',
      signals: [
        { status: 'healthy', detail: 'ok', source: 'pg_connection' },
        { status: 'critical', detail: 'lag 45m', source: 'pg_replication_lag' },
      ],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toContain('replication');
    expect(enriched.learnMoreUrl).toMatch(/^https:/);
  });

  it('falls back to any signal with a hit when none are non-healthy', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'healthy', detail: 'ok', source: 'dns_probe' }],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toBeDefined();
  });

  it('leaves findings without matching sources untouched', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'critical', detail: 'x', source: 'zz_nothing_matches_this' }],
    };
    const enriched = enrichScanFinding(finding, ctx);
    expect(enriched.explanation).toBeUndefined();
  });

  it('leaves healthy findings untouched', () => {
    const finding = {
      status: 'healthy',
      signals: [{ status: 'healthy', detail: 'ok', source: 'pg_connection' }],
    };
    expect(enrichScanFinding(finding, ctx).explanation).toBeUndefined();
  });

  it('handles signals with no source', () => {
    const finding = {
      status: 'unhealthy',
      signals: [{ status: 'critical', detail: 'x' }],
    };
    expect(enrichScanFinding(finding, ctx).explanation).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/scan-explanations.test.ts`
Expected: FAIL — `enrichScanFinding` is not exported.

- [ ] **Step 3: Implement**

In `src/cli/output.ts`, change `ScanFinding`:

```ts
export interface ScanFinding {
  id: string;
  service: string;
  status: HealthStatus;
  summary: string;
  confidence: number;
  escalationLevel: EscalationLevel;
  signals: Array<{ status: string; detail: string; source?: string }>;
  /** Plain-language explanation of the dominant signal (static knowledge map). */
  explanation?: string;
  learnMoreUrl?: string;
}
```

In `src/cli/commands/scan.ts`:

```ts
import { explainSourceInContext, type ExplanationContext } from '../../framework/signal-explanations.js';

export function enrichScanFinding<T extends {
  status: string;
  signals: Array<{ status: string; detail: string; source?: string }>;
  explanation?: string;
  learnMoreUrl?: string;
}>(finding: T, ctx: ExplanationContext): T {
  if (finding.status === 'healthy') return finding;
  const candidates = [
    ...finding.signals.filter((s) => s.status !== 'healthy'),
    ...finding.signals.filter((s) => s.status === 'healthy'),
  ];
  for (const signal of candidates) {
    if (!signal.source) continue;
    const hit = explainSourceInContext(signal.source, ctx);
    if (hit) return { ...finding, ...hit };
  }
  return finding;
}
```

In the assembly path change the signal mapping (~line 253) from
`signals: health.signals.map((s) => ({ status: s.status, detail: s.detail }))`
to
`signals: health.signals.map((s) => ({ status: s.status, detail: s.detail, source: s.source }))`.

In `runScan`, after `stackProfile` resolves, build the context and enrich each
finding as it is pushed (both the agent loop at ~line 282 and the plugin loop
at ~line 345):

```ts
const explanationCtx: ExplanationContext = {
  serverless: stackProfile.platform.platform === 'vercel',
};
// agent loop:
findings.push(enrichScanFinding({ id: findingId(kind, findingCounter++), ...finding }, explanationCtx));
// plugin loop:
findings.push(enrichScanFinding({ id: findingId('plugin', pluginFindingCounter++), ...result }, explanationCtx));
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/__tests__/scan-explanations.test.ts`
Expected: PASS. Also run `pnpm vitest run src/__tests__` for regressions —
existing scan tests asserting exact signal shapes may need the additive
`source` field added to their expectations (update expectations; do not remove
the field).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(scan): retain signal sources and enrich findings with plain-language explanations"
```

---

### Task 3: Render explanations in scan human output

**Files:**
- Modify: `src/cli/output.ts` (`printFindingGroup`, ~line 522)
- Test: `src/__tests__/scan-render-explanations.test.ts` (create)

**Interfaces:**
- Consumes: `ScanFinding.explanation` / `learnMoreUrl` from Task 2; `outputOptions.terse` from Task 1.

- [ ] **Step 1: Write the failing test**

Capture console output the way existing output tests do (check
`src/__tests__` for an existing pattern that spies on `console.log`; use the
same helper/pattern — for example `vi.spyOn(console, 'log')` collecting lines):

```ts
// src/__tests__/scan-render-explanations.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printScanSummary, setOutputOptions } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';

function fixtureResult(): ScanResult {
  return {
    score: 40,
    findings: [{
      id: 'PG-001',
      service: 'postgresql (default-postgres)',
      status: 'unhealthy',
      summary: 'Replication lag exceeds threshold',
      confidence: 0.9,
      escalationLevel: 2,
      signals: [{ status: 'critical', detail: 'lag 45m', source: 'pg_replication_lag' }],
      explanation: 'PostgreSQL replication keeps a standby copy of the database in sync.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/warm-standby.html',
    }],
    recentChanges: [],
    scannedAt: '2026-08-01T00:00:00.000Z',
    durationMs: 100,
  } as unknown as ScanResult;
}

describe('scan explanation rendering', () => {
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

  it('prints the explanation and learn-more line under a non-healthy finding', () => {
    printScanSummary(fixtureResult());
    const text = lines.join('\n');
    expect(text).toContain('standby copy');
    expect(text).toContain('postgresql.org');
  });

  it('suppresses explanations when terse', () => {
    setOutputOptions({ terse: true });
    printScanSummary(fixtureResult());
    const text = lines.join('\n');
    expect(text).not.toContain('standby copy');
    expect(text).toContain('Replication lag exceeds threshold'); // finding line intact
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/scan-render-explanations.test.ts`
Expected: first test FAILS ('standby copy' absent); terse test may pass
trivially — confirm the first fails before implementing. If `ScanResult`
requires more fields than the fixture provides, extend the fixture (with
`summary`/`aiSummary` optional fields) rather than weakening assertions.

- [ ] **Step 3: Implement**

In `printFindingGroup` (`src/cli/output.ts`), after the existing per-finding
line, add:

```ts
if (!outputOptions.terse && f.explanation) {
  console.log(chalk.dim(`      ${f.explanation}`));
  if (f.learnMoreUrl) console.log(chalk.dim(`      Learn more: ${f.learnMoreUrl}`));
}
```

(Reference `outputOptions` however module state is exposed internally — it is
the same module.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/scan-render-explanations.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(scan): render plain-language explanations under findings (default on, --terse off)"
```

---

### Task 4: Fill the knowledge-map gaps

**Files:**
- Modify: `src/framework/signal-explanations.ts` (the `EXPLANATIONS` array)
- Test: `src/__tests__/signal-explanations.test.ts` (modify if it exists — check first — else create)

**Interfaces:**
- Consumes/Produces: `explainSource(source)` returns a hit for every source listed in Step 1.

- [ ] **Step 1: Write the failing test**

Append (or create with) this test:

```ts
// in src/__tests__/signal-explanations.test.ts
import { describe, it, expect } from 'vitest';
import { explainSource } from '../framework/signal-explanations.js';

describe('knowledge map covers all built-in agent sources', () => {
  const REPRESENTATIVE_SOURCES = [
    'resolver_reachability',        // dns agent — /^dns/ does NOT match this today
    'flink_job_status',             // flink
    'ceph_cluster_health',          // ceph
    'environment_variables',        // config-drift
    'schema_migrations',            // db-migration
    'deploy_status',                // deploy-rollback
    'provider_health_status',       // ai-provider
    's3_versioning',                // aws-s3
  ];

  for (const source of REPRESENTATIVE_SOURCES) {
    it(`explains '${source}'`, () => {
      const hit = explainSource(source);
      expect(hit, `no EXPLANATIONS entry matches '${source}'`).toBeDefined();
      expect(hit!.explanation.length).toBeGreaterThan(40);
      expect(hit!.learnMoreUrl).toMatch(/^https:/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/signal-explanations.test.ts`
Expected: FAIL on all eight sources (none match today; `certificate_expiry`,
`disk_usage`, `redis_info_memory` etc. already match and are intentionally not
in this list).

- [ ] **Step 3: Implement — add entries to `EXPLANATIONS`**

Add these entries to the array (before the existing broad `/queue|consumer|lag_/` entry to keep most-specific-first ordering):

```ts
  {
    match: /^resolver_|^dns_/,
    explanation: 'DNS translates names like db.example.com into IP addresses. If this machine cannot reach a DNS resolver, everything that uses names appears down even when services are healthy.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/dns/what-is-dns/',
  },
  {
    match: /^flink|_checkpoint/,
    explanation: 'Flink runs continuous stream-processing jobs with periodic checkpoints. A failing job or stalled checkpoints means data is not being processed and recovery to a recent point may not be possible.',
    learnMoreUrl: 'https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpoints/',
  },
  {
    match: /^ceph|_osd|placement_group/,
    explanation: 'Ceph is distributed storage: data is spread across many disks (OSDs) with copies. Degraded health means some copies are missing — another failure could make data unavailable.',
    learnMoreUrl: 'https://docs.ceph.com/en/latest/rados/operations/monitoring/',
  },
  {
    match: /^environment_variables|^config_|drift/,
    explanation: 'Configuration drift: what is running no longer matches what was declared (env vars, config files). Drift makes incidents confusing — the system misbehaves in ways the config says it should not.',
    learnMoreUrl: 'https://www.hashicorp.com/resources/what-is-configuration-drift',
  },
  {
    match: /^schema_migrations|^migration_/,
    explanation: 'Database migrations change the schema your application expects. A half-applied or failed migration means the app and database disagree about structure — queries start failing.',
    learnMoreUrl: 'https://www.prisma.io/dataguide/types/relational/what-are-database-migrations',
  },
  {
    match: /^deploy_|^release_/,
    explanation: 'Deployment health: whether the most recent release is running correctly. If problems started right after a deploy, rolling back to the previous version is usually the fastest fix.',
    learnMoreUrl: 'https://docs.aws.amazon.com/whitepapers/latest/practicing-continuous-integration-continuous-delivery/deployment-methods.html',
  },
  {
    match: /^provider_health|^ai_provider|model_availability/,
    explanation: 'AI provider health: whether the LLM API your app depends on is reachable and responding. Provider outages and rate limits look like app bugs unless checked directly.',
    learnMoreUrl: 'https://docs.claude.com/en/api/errors',
  },
  {
    match: /^s3_|^bucket_/,
    explanation: 'S3 bucket protection settings (versioning, lifecycle, public access). Wrong settings quietly remove your safety net — deleted or overwritten objects may be unrecoverable.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/signal-explanations.test.ts`
Expected: PASS. Also `pnpm test` — regex ordering can affect existing
expectations (e.g. the existing `/^dns/` entry still matches `dns_*` sources;
keep both entries).

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(explanations): cover dns resolver, flink, ceph, config-drift, db-migration, deploy, ai-provider, and s3 sources"
```

---

### Task 5: Enforcement — every built-in agent has an explanation

**Files:**
- Test: `src/__tests__/explanation-coverage.test.ts` (create)

**Interfaces:**
- Consumes: `builtinAgents: AgentRegistration[]` from `src/config/builtin-agents.js` (each has `kind: string`); `explainSource` from `src/framework/signal-explanations.js`.

- [ ] **Step 1: Write the test (this task is test-only; RED here means a coverage hole)**

```ts
// src/__tests__/explanation-coverage.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { builtinAgents } from '../config/builtin-agents.js';
import { explainSource } from '../framework/signal-explanations.js';

/**
 * Representative diagnosis signal source(s) per built-in agent kind.
 * Adding a new agent to builtinAgents without adding it here fails the first
 * assertion; listing a source no EXPLANATIONS entry matches fails the second.
 * Grep the agent's agent.ts for `source: '...'` values when adding.
 */
const REPRESENTATIVE_SOURCES: Record<string, string[]> = {
  postgresql: ['pg_connection', 'pg_replication_lag'],
  redis: ['redis_info_memory'],
  etcd: ['etcd_cluster_health'],
  kafka: ['kafka_broker_status'],
  kubernetes: ['k8s_node_status'],
  ceph: ['ceph_cluster_health'],
  flink: ['flink_job_status'],
  dns: ['resolver_reachability'],
  tls: ['certificate_expiry'],
  disk: ['disk_usage'],
  backup: ['backup_existence'],
  'ai-provider': ['provider_health_status'],
  'application-config': ['environment_variables'],
  'managed-database': ['schema_migrations'],
  application: ['deploy_status'],
  'message-queue': ['queue_discovery'],
  'aws-s3': ['s3_versioning'],
  'aws-dynamodb': ['dynamodb_continuous_backups'],
  'aws-rds': ['rds_backup_retention'],
};

describe('explanation coverage', () => {
  it('lists representative sources for every built-in agent kind', () => {
    for (const reg of builtinAgents) {
      expect(
        REPRESENTATIVE_SOURCES[reg.kind],
        `agent kind '${reg.kind}' has no representative sources — add them (and an EXPLANATIONS entry if needed)`,
      ).toBeDefined();
    }
  });

  it('every representative source matches an EXPLANATIONS entry', () => {
    for (const [kind, sources] of Object.entries(REPRESENTATIVE_SOURCES)) {
      for (const source of sources) {
        expect(
          explainSource(source),
          `source '${source}' (agent '${kind}') matches no EXPLANATIONS entry`,
        ).toBeDefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/__tests__/explanation-coverage.test.ts`
Expected: PASS if Task 4 landed. If a kind string mismatches the registry
(e.g. registry uses a different kind name than assumed here), fix the map key
to the registry's actual `kind` value — the first assertion's failure message
names it. If a source genuinely has no entry, add an entry to `EXPLANATIONS`
(same style as Task 4), not an exemption.

- [ ] **Step 3: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "test(explanations): enforce knowledge-map coverage for every built-in agent"
```

---

### Task 6: Visibility report builder

**Files:**
- Create: `src/cli/visibility.ts`
- Test: `src/__tests__/visibility.test.ts` (create)

**Interfaces:**
- Consumes: `StackProfile`, `EnvHint` types from `src/cli/autodiscovery.js`.
- Produces:

```ts
export interface VisibilityEntry { label: string; detail: string; hint?: string }
export interface VisibilityReport {
  watching: VisibilityEntry[];
  blocked: VisibilityEntry[];   // found but can't check yet
  invisible: VisibilityEntry[]; // not visible by design
}
export function buildVisibilityReport(
  profile: StackProfile,
  ranKinds: string[],
  configSource: string,  // 'file' | 'env' | 'detection' | 'none' — pass what scan has
): VisibilityReport
```

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/visibility.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildVisibilityReport } from '../cli/visibility.js';
import type { StackProfile } from '../cli/autodiscovery.js';

function profileWith(overrides: Partial<StackProfile>): StackProfile {
  return {
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
    ...overrides,
  };
}

describe('buildVisibilityReport', () => {
  it('lists ran agents as watching, with env-var evidence when a hint matches', () => {
    const profile = profileWith({
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' }],
    });
    const report = buildVisibilityReport(profile, ['postgresql', 'dns'], 'env');
    const pg = report.watching.find((e) => e.label === 'postgresql');
    expect(pg).toBeDefined();
    expect(pg!.detail).toContain('DATABASE_URL');
    const dns = report.watching.find((e) => e.label === 'dns');
    expect(dns!.detail).toContain('this machine');
  });

  it('reports AWS credentials as found-but-blocked with an actionable hint', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: true, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const aws = report.blocked.find((e) => e.label.toLowerCase().includes('aws'));
    expect(aws).toBeDefined();
    expect(aws!.hint).toBeTruthy();
  });

  it('reports a present service hint with no supported agent as blocked', () => {
    const profile = profileWith({
      envHints: [{ name: 'MONGODB_URI', present: true, kind: 'database_url', inferredService: 'mongodb' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    const mongo = report.blocked.find((e) => e.detail.includes('MONGODB_URI'));
    expect(mongo).toBeDefined();
  });

  it('does not report a hint as blocked when its service ran', () => {
    const profile = profileWith({
      envHints: [{ name: 'REDIS_URL', present: true, kind: 'redis_url', inferredService: 'redis' }],
    });
    const report = buildVisibilityReport(profile, ['redis'], 'env');
    expect(report.blocked.find((e) => e.detail.includes('REDIS_URL'))).toBeUndefined();
  });

  it('states OS-level limits when remote services ran', () => {
    const profile = profileWith({});
    const report = buildVisibilityReport(profile, ['postgresql'], 'file');
    expect(report.invisible.length).toBeGreaterThan(0);
    expect(report.invisible[0]!.detail.toLowerCase()).toContain('spoke');
  });

  it('omits absent env hints entirely', () => {
    const profile = profileWith({
      envHints: [{ name: 'AWS_ACCESS_KEY_ID', present: false, kind: 'aws_credentials' }],
    });
    const report = buildVisibilityReport(profile, [], 'none');
    expect(report.blocked).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/visibility.test.ts`
Expected: FAIL — module `src/cli/visibility.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/visibility.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Visibility report: what CrisisMode is watching, what it found but cannot
 * check yet, and what is invisible by design. Static, offline honesty layer —
 * every blocked entry carries an actionable hint.
 */

import type { StackProfile } from './autodiscovery.js';

export interface VisibilityEntry {
  label: string;
  detail: string;
  hint?: string;
}

export interface VisibilityReport {
  watching: VisibilityEntry[];
  blocked: VisibilityEntry[];
  invisible: VisibilityEntry[];
}

/** Agent kinds that check this machine rather than a remote service. */
const LOCAL_KINDS = new Set(['dns', 'disk']);

const CONFIG_SOURCE_DETAIL: Record<string, string> = {
  file: 'configured in crisismode.yaml',
  env: 'found via environment variables',
  detection: 'detected listening on this machine',
  none: 'detected automatically',
};

export function buildVisibilityReport(
  profile: StackProfile,
  ranKinds: string[],
  configSource: string,
): VisibilityReport {
  const watching: VisibilityEntry[] = [];
  const blocked: VisibilityEntry[] = [];
  const invisible: VisibilityEntry[] = [];

  const presentHints = profile.envHints.filter((h) => h.present);
  const ran = new Set(ranKinds);

  for (const kind of ranKinds) {
    if (LOCAL_KINDS.has(kind)) {
      watching.push({ label: kind, detail: 'local checks on this machine' });
      continue;
    }
    const hint = presentHints.find((h) => h.inferredService === kind);
    watching.push({
      label: kind,
      detail: hint ? `via ${hint.name}` : (CONFIG_SOURCE_DETAIL[configSource] ?? 'configured'),
    });
  }

  // Service hints whose service has no running agent — visible gap.
  for (const h of presentHints) {
    if (!h.inferredService || ran.has(h.inferredService)) continue;
    blocked.push({
      label: h.inferredService,
      detail: `found ${h.name}, but CrisisMode has no ${h.inferredService} checks yet`,
      hint: 'This service is detected but not monitored — treat its health as unknown during incidents.',
    });
  }

  // Cloud credentials with no control-plane support yet.
  if (presentHints.some((h) => h.kind === 'aws_credentials' || h.kind === 'aws_profile')) {
    blocked.push({
      label: 'AWS control plane',
      detail: 'AWS credentials detected — control-plane checks (RDS, ElastiCache instance health) are not supported yet',
      hint: 'AWS-hosted services CrisisMode can reach directly (e.g. RDS Postgres via DATABASE_URL) are still checked.',
    });
  }

  // Inherent limits — only worth stating when remote services are in play.
  if (ranKinds.some((k) => !LOCAL_KINDS.has(k))) {
    invisible.push({
      label: 'remote host internals',
      detail: 'disk, memory, and processes on remote or managed hosts cannot be seen from outside — that is true of any external tool. Run a CrisisMode spoke on the host to see them.',
    });
  }

  return { watching, blocked, invisible };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/visibility.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(cli): visibility report builder — watching / blocked / invisible"
```

---

### Task 7: Render visibility in scan and feed the AI summary

**Files:**
- Modify: `src/cli/output.ts` (new `printVisibility` next to `printScanSummary`)
- Modify: `src/cli/commands/scan.ts` (build + print the report in `runScan`; `ScanResult` gains optional `visibility`)
- Modify: `src/cli/ai-summary.ts` (optional `visibility` parameter)
- Test: `src/__tests__/visibility-render.test.ts` (create)

**Interfaces:**
- Consumes: `buildVisibilityReport`, `VisibilityReport` from Task 6; `outputOptions.terse` from Task 1.
- Produces: `printVisibility(report: VisibilityReport): void` exported from `output.ts`; `ScanResult.visibility?: VisibilityReport`; `generatePlainEnglishSummary(summary, recentChanges, visibility?)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/visibility-render.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printVisibility, setOutputOptions } from '../cli/output.js';
import type { VisibilityReport } from '../cli/visibility.js';

const report: VisibilityReport = {
  watching: [{ label: 'postgresql', detail: 'via DATABASE_URL' }],
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

  it('renders all three buckets with details and hints', () => {
    printVisibility(report);
    const text = lines.join('\n');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('AWS credentials detected');
    expect(text).toContain('still checked');
    expect(text).toContain('spoke');
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
Expected: FAIL — `printVisibility` is not exported.

- [ ] **Step 3: Implement**

In `src/cli/output.ts` (import the `VisibilityReport` type from
`./visibility.js`), next to `printScanSummary`:

```ts
export function printVisibility(report: VisibilityReport): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('visibility', { ...report });
    return;
  }
  if (outputOptions.mode === 'pipe' || outputOptions.terse) return;

  console.log(chalk.bold('  What CrisisMode can see'));
  for (const e of report.watching) {
    console.log(chalk.green('    watching  ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
  }
  for (const e of report.blocked) {
    console.log(chalk.yellow('    found     ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
    if (e.hint) console.log(chalk.dim(`              ${e.hint}`));
  }
  for (const e of report.invisible) {
    console.log(chalk.dim(`    invisible ${e.label} — ${e.detail}`));
  }
  console.log('');
}
```

In `src/cli/commands/scan.ts`: add `visibility?: VisibilityReport` to
`ScanResult` (it lives in `output.ts` — add it there, additive). In `runScan`,
after findings are assembled and before `printScanSummary(result)`:

```ts
import { buildVisibilityReport } from '../visibility.js';
// configSource is already in scope (from loadConfigWithDetectionSafe)
const ranKinds = [...new Set(agentResults.map((r) => r.kind))];
result.visibility = buildVisibilityReport(stackProfile, ranKinds, configSource);
```

and after `printScanSummary(result)`, call `printVisibility(result.visibility)`.
(`jsonOut('scan', ...)` spreads `result`, so machine mode gets the report in
the scan record too; the separate `visibility` record from `printVisibility`
is the streaming form — both are additive.)

In `src/cli/ai-summary.ts`: add an optional third parameter
`visibility?: VisibilityReport` to `generatePlainEnglishSummary`. Where the
prompt string for the AI call is assembled, append:

```ts
const visibilityText = visibility
  ? `\nVisibility: watching ${visibility.watching.map((e) => e.label).join(', ') || 'nothing'}. ` +
    `Known gaps: ${visibility.blocked.map((e) => e.detail).join('; ') || 'none'}.`
  : '';
```

and include `${visibilityText}` in the prompt. Update the call site in
`scan.ts` to pass `result.visibility`. The keyless fallback path
(`buildFallbackSummary`) is unchanged.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run src/__tests__/visibility-render.test.ts src/__tests__/visibility.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(scan): render visibility section and feed access gaps to the AI summary"
```

---

### Task 8: Risk framing for plan steps

**Files:**
- Create: `src/cli/risk-framing.ts`
- Modify: `src/cli/output.ts` (`printPlan`, ~line 216 — after each step line)
- Test: `src/__tests__/risk-framing.test.ts` (create)

**Interfaces:**
- Consumes: `RecoveryPlan` step union from `src/types/index.js`; `riskExceeds` exists in `src/framework/risk.js` if a comparator is needed.
- Produces:

```ts
export interface RiskFraming { does: string; couldGoWrong: string; undo: string }
export function buildRiskFraming(step: RecoveryPlan['steps'][number]): RiskFraming | null
```
Returns `null` for non-`system_action` steps and `routine` risk.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/risk-framing.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildRiskFraming } from '../cli/risk-framing.js';

function systemStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 's1',
    type: 'system_action' as const,
    name: 'Disconnect replica',
    description: 'Disconnect the lagging replica from the primary',
    executionContext: 'primary',
    target: 'pg-primary',
    riskLevel: 'elevated' as const,
    requiredCapabilities: ['db.replica.disconnect'],
    command: { type: 'sql', statement: 'SELECT 1' },
    statePreservation: { before: [{ name: 'replication_slots', capture: 'pg_replication_slots' }], after: [] },
    successCriteria: { checks: [] },
    rollback: { type: 'command' as const, description: 'Re-add the replica to the primary' },
    blastRadius: {
      directComponents: ['replica-1'],
      indirectComponents: ['read-traffic'],
      maxImpact: 'reads fall back to the primary',
      cascadeRisk: 'low',
    },
    timeout: '30s',
    ...overrides,
  };
}

describe('buildRiskFraming', () => {
  it('frames an elevated system action with does/wrong/undo', () => {
    const framing = buildRiskFraming(systemStep() as never);
    expect(framing).not.toBeNull();
    expect(framing!.does).toContain('Disconnect the lagging replica');
    expect(framing!.couldGoWrong).toContain('replica-1');
    expect(framing!.couldGoWrong).toContain('reads fall back to the primary');
    expect(framing!.undo).toContain('Re-add the replica');
  });

  it('describes state capture when there is no rollback directive', () => {
    const framing = buildRiskFraming(systemStep({ rollback: undefined }) as never);
    expect(framing!.undo).toContain('captured');
  });

  it('returns null for routine risk', () => {
    expect(buildRiskFraming(systemStep({ riskLevel: 'routine' }) as never)).toBeNull();
  });

  it('returns null for non-system-action steps', () => {
    const step = { stepId: 'd1', type: 'diagnosis_action', name: 'x' };
    expect(buildRiskFraming(step as never)).toBeNull();
  });

  it('escalates the warning wording with risk level', () => {
    const high = buildRiskFraming(systemStep({ riskLevel: 'high' }) as never);
    const critical = buildRiskFraming(systemStep({ riskLevel: 'critical' }) as never);
    expect(high!.couldGoWrong).not.toEqual(critical!.couldGoWrong);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/risk-framing.test.ts`
Expected: FAIL — module does not exist. If the `systemStep` fixture fails
typecheck against the real `SystemActionStep` (field shape drift), fix the
fixture to the real type — do not loosen the implementation.

- [ ] **Step 3: Implement `src/cli/risk-framing.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Plain-language consequence framing for plan steps, rendered before approval
 * gates. Pure derivation from safety data every plan already carries
 * (blast radius, state preservation, rollback) — no per-step authoring.
 */

import type { RecoveryPlan } from '../types/index.js';

export interface RiskFraming {
  does: string;
  couldGoWrong: string;
  undo: string;
}

const RISK_WARNING: Record<string, string> = {
  elevated: 'This changes a live system.',
  high: 'This makes a significant change to a live system — a mistake here causes real downtime.',
  critical: 'This is a last-resort action that can cause data loss or extended downtime if it goes wrong.',
};

type Step = RecoveryPlan['steps'][number];

export function buildRiskFraming(step: Step): RiskFraming | null {
  if (step.type !== 'system_action') return null;
  const warning = RISK_WARNING[step.riskLevel];
  if (!warning) return null; // routine (or unknown) — no framing needed

  const affected = [
    ...step.blastRadius.directComponents,
    ...step.blastRadius.indirectComponents,
  ].filter(Boolean);
  const couldGoWrong = [
    warning,
    affected.length > 0 ? `Affects: ${affected.join(', ')}.` : '',
    step.blastRadius.maxImpact ? `Worst case: ${step.blastRadius.maxImpact}.` : '',
  ].filter(Boolean).join(' ');

  const captures = step.statePreservation.before.map((c) => c.name).filter(Boolean);
  const undo = step.rollback
    ? step.rollback.description
    : captures.length > 0
      ? `No automatic undo — state (${captures.join(', ')}) is captured first so an operator can restore it manually.`
      : 'No automatic undo for this step.';

  return {
    does: step.description ?? step.name,
    couldGoWrong,
    undo,
  };
}
```

(If `CaptureDirective` uses a different property than `name` for its label,
check `packages/agent-sdk/src/types/common.ts:54` and use the real first
string property; adjust the fixture to match.)

- [ ] **Step 4: Run test to verify it passes, then wire rendering**

Run: `pnpm vitest run src/__tests__/risk-framing.test.ts` → PASS.

Then in `src/cli/output.ts` `printPlan`, inside the human-mode step loop after
each step line (the `console.log(chalk.dim('  ') + num + type + risk + s.name)`
at ~line 242), add:

```ts
import { buildRiskFraming } from './risk-framing.js';
// in the loop:
const framing = outputOptions.terse ? null : buildRiskFraming(s);
if (framing) {
  console.log(chalk.dim(`       what:  ${framing.does}`));
  console.log(chalk.yellow(`       risk:  `) + chalk.dim(framing.couldGoWrong));
  console.log(chalk.dim(`       undo:  ${framing.undo}`));
}
```

Run `pnpm test` — existing plan-rendering tests may assert exact line
sequences; update their expectations for the added lines only where they used
non-terse human mode.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "feat(plans): plain-language risk framing (what / could go wrong / undo) before approval"
```

---

### Task 9: Real-surface verification and docs

**Files:**
- Modify: `docs/architecture.md` only if it documents scan output (check; skip otherwise)
- Modify: `CLAUDE.md` (Output Modes section: mention `--terse`)

- [ ] **Step 1: Build and drive the bundle (use the project `verify` skill conventions)**

```bash
pnpm run build:bundle
BUNDLE=$PWD/dist/crisismode.bundle.cjs
WORK=$(mktemp -d)
cd "$WORK"

# 1. Keyless zero-config scan: expect explanation lines under non-healthy
#    findings and the "What CrisisMode can see" section.
env -u ANTHROPIC_API_KEY node "$BUNDLE" scan

# 2. Fake AWS creds: expect the blocked bucket to mention AWS control plane.
env -u ANTHROPIC_API_KEY AWS_ACCESS_KEY_ID=AKIAFAKE node "$BUNDLE" scan | grep -A2 "AWS"

# 3. Terse: expect NO explanation lines and NO visibility section.
env -u ANTHROPIC_API_KEY node "$BUNDLE" scan --terse

# 4. Machine mode: expect additive fields only — findings[].explanation,
#    findings[].signals[].source, and a visibility record.
env -u ANTHROPIC_API_KEY node "$BUNDLE" scan --json | head -5

# 5. Unknown-service hint: expect mongodb in the blocked bucket.
env -u ANTHROPIC_API_KEY MONGODB_URI=mongodb://localhost/x node "$BUNDLE" scan | grep -i mongo
```

Expected: each check shows the described output. The podman test Postgres may
be up — that produces REAL healthy pg findings (healthy findings get no
explanation line; that is correct). If any check fails, fix before proceeding.

- [ ] **Step 2: Risk framing at the surface**

```bash
node "$BUNDLE" demo 2>&1 | grep -B2 -A3 "risk:" | head -30
```

Expected: elevated+ system actions show the what/risk/undo block. (The demo
flow prints plans via `printPlan`; if demo output is interactive, drive the
plan preview via `playbook dry-run playbooks/examples/pg-replication-lag.md`
instead and look for the same block.)

- [ ] **Step 3: Update docs**

In `CLAUDE.md`, Output Modes bullet list, extend the human mode line:
`- **human** (default for TTY): colored, interactive, emoji severity indicators; plain-language explanations on by default (suppress with --terse)`

- [ ] **Step 4: Full gate, commit, PR**

```bash
pnpm test && pnpm run typecheck && pnpm run lint
git add -A && git commit -m "docs: document --terse and plain-language defaults"
gh pr create --title "feat(ux): plain-language & honesty layer for scan and plans" --body "Implements docs/superpowers/specs/2026-08-01-vibe-coder-ux-arc1-design.md"
```

---

## Self-Review Notes

- Spec §1 (scan explanations) → Tasks 1-3. Spec §2 (visibility) → Tasks 6-7.
  Spec §3 (risk framing) → Task 8. Spec §4 (content + enforcement) → Tasks 4-5.
  Spec error-handling bullets: no-match findings covered by Task 2 test 3;
  empty-profile visibility covered by Task 6 test 6; terse+json covered by
  Task 7 (printVisibility machine mode ignores terse).
- Type names verified against the codebase on 2026-08-01: `StackProfile`,
  `EnvHint` (`src/cli/autodiscovery.ts:35,64`), `ScanFinding`
  (`src/cli/output.ts:416`), `SystemActionStep` / `BlastRadius` /
  `StatePreservation` / `RollbackDirective`
  (`packages/agent-sdk/src/types/{step-types,common}.ts`),
  `builtinAgents` (`src/config/builtin-agents.ts:33`), `explainSourceInContext`
  (`src/framework/signal-explanations.ts`). Representative sources were
  grepped from each agent's `agent.ts`.
- Registry `kind` values in Task 5 come from `KIND_PREFIX` in `scan.ts:50`;
  if the registry disagrees, the test's first assertion names the fix.
