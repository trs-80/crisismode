# Scale-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `crisismode readiness` command + `crisismode_readiness` MCP tool that scores scale-readiness for Vercel + managed-Postgres stacks, plus scaling attributions in existing diagnosis explanations.

**Architecture:** New `src/readiness/` rule-registry module. Rules consume existing data sources (pg live client, `discoverStack()` from autodiscovery). CLI and MCP are thin renderers over one `ReadinessReport`. The reactive half adds context-aware attribution entries to `src/framework/signal-explanations.ts`.

**Tech Stack:** TypeScript strict ESM (NodeNext, `.js` import extensions), vitest, zod (MCP schemas), pg via existing `PgLiveClient`.

**Spec:** `docs/superpowers/specs/2026-07-18-scale-readiness-design.md`

## Global Constraints

- Named exports only; SPDX header on every new file (`// SPDX-License-Identifier: Apache-2.0` + `// Copyright 2026 CrisisMode Contributors`)
- `import type { ... }` for type-only imports; async backend methods return `Promise<T>`
- Read-only end to end: no rule may mutate anything; MCP tool MUST register `annotations: { readOnlyHint: true }`
- Honesty policy: connection failures propagate into the report as explicit findings; a rule that cannot evaluate returns `status: 'unknown'` with a reason — never a guess, never simulated data
- `unknown` findings are excluded from the score and reported separately
- Every threshold is a named constant with a comment citing its rationale
- Conventional Commits; commit after every green test cycle
- Before merge: `pnpm run build:bundle && pnpm run eval:diagnosis:gate` must pass (≥13/14)

---

### Task 1: Readiness types and report scoring

**Files:**
- Create: `src/readiness/types.ts`
- Create: `src/readiness/report.ts`
- Test: `src/__tests__/readiness-report.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces: `ReadinessStatus`, `ReadinessFinding`, `ReadinessRule`, `ReadinessContext`, `ReadinessSources`, `ReadinessReport`, `buildReport(findings: ReadinessFinding[]): ReadinessReport`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/readiness-report.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { buildReport } from '../readiness/report.js';
import type { ReadinessFinding } from '../readiness/types.js';

const finding = (over: Partial<ReadinessFinding>): ReadinessFinding => ({
  ruleId: 'test-rule',
  title: 'Test rule',
  status: 'ready',
  evidence: [],
  explanation: 'x',
  fix: 'x',
  learnMoreUrl: 'https://example.com',
  ...over,
});

describe('buildReport', () => {
  it('scores ready findings at 100 with verdict ready', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b' })]);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('ready');
    expect(r.evaluated).toBe(2);
    expect(r.unknown).toBe(0);
  });

  it('any blocking finding yields not-ready and subtracts 30', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b', status: 'blocking' })]);
    expect(r.verdict).toBe('not-ready');
    expect(r.score).toBe(70);
  });

  it('at_risk without blocking yields at-risk and subtracts 10', () => {
    const r = buildReport([finding({ status: 'at_risk' })]);
    expect(r.verdict).toBe('at-risk');
    expect(r.score).toBe(90);
  });

  it('unknown findings are counted separately and do not affect score', () => {
    const r = buildReport([finding({}), finding({ ruleId: 'b', status: 'unknown', reason: 'no extension' })]);
    expect(r.score).toBe(100);
    expect(r.unknown).toBe(1);
    expect(r.evaluated).toBe(1);
  });

  it('score floors at 0', () => {
    const blockers = ['a', 'b', 'c', 'd'].map((id) => finding({ ruleId: id, status: 'blocking' }));
    expect(buildReport(blockers).score).toBe(0);
  });

  it('all-unknown report has verdict unknown', () => {
    const r = buildReport([finding({ status: 'unknown', reason: 'unreachable' })]);
    expect(r.verdict).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-report.test.ts`
Expected: FAIL — cannot resolve `../readiness/report.js`

- [ ] **Step 3: Write the types**

```typescript
// src/readiness/types.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Scale-readiness rule registry types. Readiness is forward-looking and
 * strictly read-only (suggest escalation level at most): rules observe,
 * explain, and recommend — they never mutate.
 */

import type { ConnectionUsage } from '../agent/pg-replication/backend.js';
import type { StackProfile } from '../cli/autodiscovery.js';

export type ReadinessStatus = 'ready' | 'at_risk' | 'blocking' | 'unknown';

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
}

/** Per-table stats from pg_stat_user_tables (null when unavailable). */
export interface TableStat {
  table: string;
  rowEstimate: number;
  seqScans: number;
  idxScans: number;
}

/** Per-statement stats from pg_stat_statements (null when extension absent). */
export interface StatementStat {
  query: string;
  calls: number;
  meanMs: number;
}

/** Narrow data-access surface rules are allowed to use. */
export interface ReadinessSources {
  connectionUsage(): Promise<ConnectionUsage | null>;
  tableStats(): Promise<TableStat[] | null>;
  statementStats(): Promise<StatementStat[] | null>;
}

export interface ReadinessContext {
  stack: StackProfile;
  /** True when Vercel deployment signals were detected (platform or .vercel/) */
  serverless: boolean;
  /** kind/host/port of the resolved postgresql target, if any */
  target?: { host: string; port: number } | undefined;
}

export interface ReadinessRule {
  id: string;
  title: string;
  applicable(ctx: ReadinessContext): boolean;
  evaluate(sources: ReadinessSources, ctx: ReadinessContext): Promise<ReadinessFinding>;
}

export interface ReadinessReport {
  verdict: 'ready' | 'at-risk' | 'not-ready' | 'unknown';
  score: number;
  evaluated: number;
  unknown: number;
  findings: ReadinessFinding[];
}
```

- [ ] **Step 4: Write the scoring**

```typescript
// src/readiness/report.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessFinding, ReadinessReport } from './types.js';

/** A blocking finding is an outage waiting for traffic — heavy penalty. */
const BLOCKING_PENALTY = 30;
/** An at-risk finding degrades under load but may survive — light penalty. */
const AT_RISK_PENALTY = 10;

export function buildReport(findings: ReadinessFinding[]): ReadinessReport {
  const known = findings.filter((f) => f.status !== 'unknown');
  const unknown = findings.length - known.length;

  let score = 100;
  for (const f of known) {
    if (f.status === 'blocking') score -= BLOCKING_PENALTY;
    else if (f.status === 'at_risk') score -= AT_RISK_PENALTY;
  }
  score = Math.max(0, score);

  let verdict: ReadinessReport['verdict'];
  if (known.length === 0) verdict = 'unknown';
  else if (known.some((f) => f.status === 'blocking')) verdict = 'not-ready';
  else if (known.some((f) => f.status === 'at_risk')) verdict = 'at-risk';
  else verdict = 'ready';

  return { verdict, score, evaluated: known.length, unknown, findings };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-report.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run typecheck
git add src/readiness/ src/__tests__/readiness-report.test.ts
git commit -m "feat(readiness): rule/finding types and report scoring"
```

---

### Task 2: PostgreSQL stats queries (backend, live client, simulator)

**Files:**
- Modify: `src/agent/pg-replication/backend.ts` (add optional methods to `PgBackend`)
- Modify: `src/agent/pg-replication/live-client.ts`
- Modify: `src/agent/pg-replication/simulator.ts`
- Test: `src/__tests__/readiness-pg-stats.test.ts`

**Interfaces:**
- Consumes: `TableStat`, `StatementStat` from Task 1
- Produces: `PgBackend.queryTableStats?(): Promise<TableStat[] | null>` and `PgBackend.queryStatementStats?(): Promise<StatementStat[] | null>` — OPTIONAL on the interface so existing `PgBackend` test doubles keep compiling; both real implementations provide them. Simulator gains fixture setters `setTableStats(rows)` / `setStatementStats(rows | null)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/readiness-pg-stats.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('PgSimulator readiness stats fixtures', () => {
  it('returns configured table stats', async () => {
    const sim = new PgSimulator();
    sim.setTableStats([{ table: 'orders', rowEstimate: 500_000, seqScans: 9_000, idxScans: 40 }]);
    const rows = await sim.queryTableStats();
    expect(rows).toEqual([{ table: 'orders', rowEstimate: 500_000, seqScans: 9_000, idxScans: 40 }]);
  });

  it('statement stats default to null (extension absent)', async () => {
    const sim = new PgSimulator();
    expect(await sim.queryStatementStats()).toBeNull();
  });

  it('returns configured statement stats', async () => {
    const sim = new PgSimulator();
    sim.setStatementStats([{ query: 'SELECT * FROM orders', calls: 1200, meanMs: 640 }]);
    const rows = await sim.queryStatementStats();
    expect(rows?.[0]?.meanMs).toBe(640);
  });
});
```

Note: if the simulator class is not named `PgSimulator`, use the actual exported name from `src/agent/pg-replication/simulator.ts` in both this test and Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-pg-stats.test.ts`
Expected: FAIL — `setTableStats` is not a function

- [ ] **Step 3: Extend the backend interface and both implementations**

In `src/agent/pg-replication/backend.ts`, after `queryConnectionUsage`:

```typescript
import type { TableStat, StatementStat } from '../../readiness/types.js';

  /**
   * Per-table scan stats from pg_stat_user_tables (readiness: missing-index
   * rule). Optional: test doubles may omit; null means unavailable.
   */
  queryTableStats?(): Promise<TableStat[] | null>;

  /**
   * Per-statement timing from pg_stat_statements (readiness: slow-queries
   * rule). Null when the extension is not installed.
   */
  queryStatementStats?(): Promise<StatementStat[] | null>;
```

In `src/agent/pg-replication/live-client.ts`, following the `queryConnectionUsage` null-on-error pattern:

```typescript
  async queryTableStats(): Promise<TableStat[] | null> {
    try {
      const result = await this.primaryPool.query<{
        relname: string; n_live_tup: number; seq_scan: number; idx_scan: number | null;
      }>(`
        SELECT relname, n_live_tup::int, seq_scan::int, COALESCE(idx_scan, 0)::int AS idx_scan
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
        LIMIT 50
      `);
      return result.rows.map((r) => ({
        table: r.relname,
        rowEstimate: r.n_live_tup,
        seqScans: r.seq_scan,
        idxScans: r.idx_scan ?? 0,
      }));
    } catch {
      return null;
    }
  }

  async queryStatementStats(): Promise<StatementStat[] | null> {
    try {
      const result = await this.primaryPool.query<{ query: string; calls: number; mean_ms: number }>(`
        SELECT query, calls::int, mean_exec_time AS mean_ms
        FROM pg_stat_statements
        ORDER BY mean_exec_time DESC
        LIMIT 20
      `);
      return result.rows.map((r) => ({ query: r.query, calls: r.calls, meanMs: r.mean_ms }));
    } catch {
      return null; // extension absent or no privilege — rule reports unknown
    }
  }
```

In `src/agent/pg-replication/simulator.ts`:

```typescript
  private tableStats: TableStat[] = [];
  private statementStats: StatementStat[] | null = null;

  setTableStats(rows: TableStat[]): void { this.tableStats = rows; }
  setStatementStats(rows: StatementStat[] | null): void { this.statementStats = rows; }

  async queryTableStats(): Promise<TableStat[] | null> { return this.tableStats; }
  async queryStatementStats(): Promise<StatementStat[] | null> { return this.statementStats; }
```

(Add the `import type { TableStat, StatementStat } from '../../readiness/types.js';` line to both implementation files.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-pg-stats.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full typecheck (catches any PgBackend double that broke), then commit**

```bash
pnpm run typecheck && pnpm test
git add src/agent/pg-replication/ src/__tests__/readiness-pg-stats.test.ts
git commit -m "feat(pg-replication): optional table/statement stats queries for readiness"
```

---

### Task 3: Connection rules (headroom, limit tier, long transactions)

**Files:**
- Create: `src/readiness/rules/connection-headroom.ts`
- Create: `src/readiness/rules/connection-limit-tier.ts`
- Create: `src/readiness/rules/long-transactions.ts`
- Test: `src/__tests__/readiness-connection-rules.test.ts`

**Interfaces:**
- Consumes: `ReadinessRule`, `ReadinessSources`, `ReadinessFinding` (Task 1); `ConnectionUsage` (existing)
- Produces: `connectionHeadroomRule`, `connectionLimitTierRule`, `longTransactionsRule` — each a `ReadinessRule` const

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/readiness-connection-rules.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { connectionHeadroomRule } from '../readiness/rules/connection-headroom.js';
import { connectionLimitTierRule } from '../readiness/rules/connection-limit-tier.js';
import { longTransactionsRule } from '../readiness/rules/long-transactions.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';
import type { ConnectionUsage } from '../agent/pg-replication/backend.js';

const ctx: ReadinessContext = {
  stack: { services: [], appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] }, envHints: [], platform: { platform: null, detected: false, signals: [] }, aiProviders: [], derivedTargets: [], derivedNotes: {}, confidence: 0 },
  serverless: false,
};

const sources = (usage: ConnectionUsage | null): ReadinessSources => ({
  connectionUsage: async () => usage,
  tableStats: async () => null,
  statementStats: async () => null,
});

const usage = (over: Partial<ConnectionUsage>): ConnectionUsage => ({
  max: 100, total: 10, byState: {}, idleInTransactionOldest: [], ...over,
});

describe('connectionHeadroomRule', () => {
  it('ready below 60% usage, reports headroom', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 30 })), ctx);
    expect(f.status).toBe('ready');
    expect(f.headroom).toBeCloseTo(0.7);
  });
  it('at_risk at 60% usage', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 60 })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('blocking at 80% usage', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 85 })), ctx);
    expect(f.status).toBe('blocking');
  });
  it('unknown with reason when usage unavailable', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(null), ctx);
    expect(f.status).toBe('unknown');
    expect(f.reason).toBeTruthy();
  });
});

describe('connectionLimitTierRule', () => {
  it('warns on small max_connections (free-tier shaped)', async () => {
    const f = await connectionLimitTierRule.evaluate(sources(usage({ max: 20 })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('ready on generous max_connections', async () => {
    const f = await connectionLimitTierRule.evaluate(sources(usage({ max: 200 })), ctx);
    expect(f.status).toBe('ready');
  });
});

describe('longTransactionsRule', () => {
  it('flags idle-in-transaction sessions older than 60s', async () => {
    const f = await longTransactionsRule.evaluate(
      sources(usage({ idleInTransactionOldest: [{ pid: 1, ageSeconds: 300 }] })), ctx);
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('300');
  });
  it('ready when none exceed the threshold', async () => {
    const f = await longTransactionsRule.evaluate(
      sources(usage({ idleInTransactionOldest: [{ pid: 1, ageSeconds: 5 }] })), ctx);
    expect(f.status).toBe('ready');
  });
});
```

Note: if `IdleInTransactionSession` requires `applicationName`, add `applicationName: undefined` to the fixture objects.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/readiness-connection-rules.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the three rules**

```typescript
// src/readiness/rules/connection-headroom.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Above 60% of max_connections, bursts start failing under 2-3x traffic. */
const AT_RISK_USAGE = 0.6;
/** Above 80%, ordinary traffic variance can exhaust the pool. */
const BLOCKING_USAGE = 0.8;

export const connectionHeadroomRule: ReadinessRule = {
  id: 'connection-headroom',
  title: 'Database connection headroom',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const usage = await sources.connectionUsage();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'PostgreSQL allows a fixed number of simultaneous connections (max_connections). When they run out, new requests fail immediately — this is the most common way growing apps fall over.',
      fix: 'Add a connection pooler (pgbouncer, or your provider\'s pooled connection string) and close connections promptly.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/runtime-config-connection.html',
    };
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read pg_stat_activity' };
    }
    const used = usage.total / usage.max;
    const headroom = 1 - used;
    const status = used >= BLOCKING_USAGE ? 'blocking' : used >= AT_RISK_USAGE ? 'at_risk' : 'ready';
    return {
      ...base,
      status,
      headroom,
      evidence: [`${usage.total} of ${usage.max} connections in use (${Math.round(used * 100)}%)`],
    };
  },
};
```

```typescript
// src/readiness/rules/connection-limit-tier.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Managed-PG free tiers commonly cap max_connections at or below ~25. */
const SMALL_MAX_CONNECTIONS = 25;

export const connectionLimitTierRule: ReadinessRule = {
  id: 'connection-limit-tier',
  title: 'Connection limit size',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const usage = await sources.connectionUsage();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'A small max_connections (typical of free/starter database plans) leaves little room for traffic growth — every serverless instance and background job consumes one.',
      fix: 'Plan a tier upgrade or add pooling before launch traffic arrives.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS',
    };
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read max_connections' };
    }
    const status = usage.max <= SMALL_MAX_CONNECTIONS ? 'at_risk' : 'ready';
    return { ...base, status, evidence: [`max_connections = ${usage.max}`] };
  },
};
```

```typescript
// src/readiness/rules/long-transactions.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Idle-in-transaction beyond 60s holds locks and a connection for no work. */
const LONG_IDLE_SECONDS = 60;

export const longTransactionsRule: ReadinessRule = {
  id: 'long-transactions',
  title: 'Long idle transactions',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const usage = await sources.connectionUsage();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'A transaction left open ("idle in transaction") holds its locks and its connection. Under load these pile up and block other queries.',
      fix: 'Find the code path that opens a transaction without committing; set idle_in_transaction_session_timeout as a backstop.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT',
    };
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read pg_stat_activity' };
    }
    const long = usage.idleInTransactionOldest.filter((s) => s.ageSeconds >= LONG_IDLE_SECONDS);
    if (long.length === 0) return { ...base, status: 'ready' as const, evidence: [] };
    return {
      ...base,
      status: 'at_risk' as const,
      evidence: long.map((s) => `pid ${s.pid} idle in transaction for ${s.ageSeconds}s`),
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-connection-rules.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readiness/rules/ src/__tests__/readiness-connection-rules.test.ts
git commit -m "feat(readiness): connection headroom, limit-tier, and long-transaction rules"
```

---

### Task 4: Query-shape rules (missing index, slow queries)

**Files:**
- Create: `src/readiness/rules/missing-index.ts`
- Create: `src/readiness/rules/slow-queries.ts`
- Test: `src/__tests__/readiness-query-rules.test.ts`

**Interfaces:**
- Consumes: Task 1 types
- Produces: `missingIndexRule`, `slowQueriesRule` — each a `ReadinessRule` const

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/readiness-query-rules.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { missingIndexRule } from '../readiness/rules/missing-index.js';
import { slowQueriesRule } from '../readiness/rules/slow-queries.js';
import type { ReadinessSources, ReadinessContext, TableStat, StatementStat } from '../readiness/types.js';

const ctx = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;

const sources = (tables: TableStat[] | null, stmts: StatementStat[] | null): ReadinessSources => ({
  connectionUsage: async () => null,
  tableStats: async () => tables,
  statementStats: async () => stmts,
});

describe('missingIndexRule', () => {
  it('flags a large seq-scan-dominated table', async () => {
    const f = await missingIndexRule.evaluate(
      sources([{ table: 'orders', rowEstimate: 100_000, seqScans: 5_000, idxScans: 10 }], null), ctx);
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('orders');
  });
  it('ignores small tables (seq scans are fine there)', async () => {
    const f = await missingIndexRule.evaluate(
      sources([{ table: 'settings', rowEstimate: 50, seqScans: 9_999, idxScans: 0 }], null), ctx);
    expect(f.status).toBe('ready');
  });
  it('unknown when table stats unavailable', async () => {
    const f = await missingIndexRule.evaluate(sources(null, null), ctx);
    expect(f.status).toBe('unknown');
  });
});

describe('slowQueriesRule', () => {
  it('flags queries with high mean execution time', async () => {
    const f = await slowQueriesRule.evaluate(
      sources(null, [{ query: 'SELECT * FROM orders', calls: 900, meanMs: 800 }]), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('unknown with enablement hint when pg_stat_statements is absent', async () => {
    const f = await slowQueriesRule.evaluate(sources(null, null), ctx);
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('pg_stat_statements');
  });
  it('ready when all tracked queries are fast', async () => {
    const f = await slowQueriesRule.evaluate(
      sources(null, [{ query: 'SELECT 1', calls: 10_000, meanMs: 2 }]), ctx);
    expect(f.status).toBe('ready');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/readiness-query-rules.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement both rules**

```typescript
// src/readiness/rules/missing-index.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Below ~10k rows a sequential scan is cheap; do not nag about small tables. */
const MIN_ROWS = 10_000;
/** Seq scans an order of magnitude above index scans ⇒ queries lack an index. */
const SEQ_TO_IDX_RATIO = 10;

export const missingIndexRule: ReadinessRule = {
  id: 'missing-index',
  title: 'Tables scanned without indexes',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const tables = await sources.tableStats();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'Without an index, every query reads the whole table. That is fine at 1k rows and an outage at 1M — cost grows with your data even if traffic stays flat.',
      fix: 'Add an index on the columns these queries filter or join on (check with EXPLAIN).',
      learnMoreUrl: 'https://use-the-index-luke.com/',
    };
    if (!tables) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read pg_stat_user_tables' };
    }
    const offenders = tables.filter(
      (t) => t.rowEstimate >= MIN_ROWS && t.seqScans > Math.max(1, t.idxScans) * SEQ_TO_IDX_RATIO,
    );
    if (offenders.length === 0) return { ...base, status: 'ready' as const, evidence: [] };
    return {
      ...base,
      status: 'at_risk' as const,
      evidence: offenders.map(
        (t) => `${t.table}: ~${t.rowEstimate} rows, ${t.seqScans} seq scans vs ${t.idxScans} index scans`,
      ),
    };
  },
};
```

```typescript
// src/readiness/rules/slow-queries.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Mean execution above 250ms per call compounds badly under concurrency. */
const SLOW_MEAN_MS = 250;

export const slowQueriesRule: ReadinessRule = {
  id: 'slow-queries',
  title: 'Slow queries',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const stmts = await sources.statementStats();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'A query that takes hundreds of milliseconds occupies a connection the whole time. Under concurrent traffic, slow queries multiply into pool exhaustion and timeouts.',
      fix: 'EXPLAIN the listed queries; usually the fix is an index or fetching fewer rows.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/pgstatstatements.html',
    };
    if (!stmts) {
      return {
        ...base,
        status: 'unknown' as const,
        evidence: [],
        reason: 'pg_stat_statements is not available — enable it with CREATE EXTENSION pg_stat_statements (most managed providers support it)',
      };
    }
    const slow = stmts.filter((s) => s.meanMs >= SLOW_MEAN_MS);
    if (slow.length === 0) return { ...base, status: 'ready' as const, evidence: [] };
    return {
      ...base,
      status: 'at_risk' as const,
      evidence: slow.map((s) => `${Math.round(s.meanMs)}ms mean × ${s.calls} calls: ${s.query.slice(0, 80)}`),
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-query-rules.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readiness/rules/ src/__tests__/readiness-query-rules.test.ts
git commit -m "feat(readiness): missing-index and slow-query rules"
```

---

### Task 5: Serverless pooling rule

**Files:**
- Create: `src/readiness/rules/serverless-pooling.ts`
- Test: `src/__tests__/readiness-serverless-rule.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `StackProfile.envHints` / `.platform` (existing autodiscovery)
- Produces: `serverlessPoolingRule: ReadinessRule`

Heuristic (label it as such in output): serverless context detected AND the postgresql connection targets the direct port 5432 AND `max_connections` is small ⇒ classic unpooled-serverless setup. Pooled managed endpoints (e.g. Supabase pgbouncer) conventionally use port 6543; port 5432 with a small limit from serverless is the highest-confidence bad signal available without provider APIs.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/readiness-serverless-rule.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { serverlessPoolingRule } from '../readiness/rules/serverless-pooling.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';

const sources = (max: number | null): ReadinessSources => ({
  connectionUsage: async () => (max === null ? null : { max, total: 1, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => null,
  statementStats: async () => null,
});

const ctx = (serverless: boolean, port: number): ReadinessContext =>
  ({ serverless, target: { host: 'db.example.com', port } }) as ReadinessContext;

describe('serverlessPoolingRule', () => {
  it('not applicable without serverless signals', () => {
    expect(serverlessPoolingRule.applicable(ctx(false, 5432))).toBe(false);
  });
  it('blocking: serverless + direct port + small limit', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(20), ctx(true, 5432));
    expect(f.status).toBe('blocking');
    expect(f.explanation).toContain('heuristic');
  });
  it('ready when using a pooled port', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(20), ctx(true, 6543));
    expect(f.status).toBe('ready');
  });
  it('at_risk (not blocking) when direct port but generous limit', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(500), ctx(true, 5432));
    expect(f.status).toBe('at_risk');
  });
  it('unknown when max_connections unreadable', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(null), ctx(true, 5432));
    expect(f.status).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/readiness-serverless-rule.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the rule**

```typescript
// src/readiness/rules/serverless-pooling.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Direct PostgreSQL port; pooled managed endpoints conventionally differ (e.g. 6543). */
const DIRECT_PG_PORT = 5432;
/** Same free-tier shape as connection-limit-tier. */
const SMALL_MAX_CONNECTIONS = 25;

export const serverlessPoolingRule: ReadinessRule = {
  id: 'serverless-pooling',
  title: 'Serverless without connection pooling',
  applicable: (ctx) => ctx.serverless && ctx.target !== undefined,
  async evaluate(sources, ctx) {
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'Each serverless invocation opens its own database connection, so traffic spikes translate directly into connection spikes. This check is a heuristic: it infers pooling from the connection port and limit size.',
      fix: 'Use your provider\'s pooled connection string (or add pgbouncer) for serverless functions.',
      learnMoreUrl: 'https://vercel.com/guides/connection-pooling-with-serverless-functions',
    };
    const port = ctx.target?.port;
    if (port !== DIRECT_PG_PORT) {
      return { ...base, status: 'ready' as const, evidence: [`connection uses port ${port} (pooled endpoint likely)`] };
    }
    const usage = await sources.connectionUsage();
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read max_connections to size the risk' };
    }
    const status = usage.max <= SMALL_MAX_CONNECTIONS ? ('blocking' as const) : ('at_risk' as const);
    return {
      ...base,
      status,
      evidence: [
        `serverless deploy detected with direct connection on port ${DIRECT_PG_PORT}`,
        `max_connections = ${usage.max}`,
      ],
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-serverless-rule.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readiness/rules/serverless-pooling.ts src/__tests__/readiness-serverless-rule.test.ts
git commit -m "feat(readiness): serverless-pooling heuristic rule"
```

---

### Task 6: Runner — context building, rule execution, error isolation

**Files:**
- Create: `src/readiness/run.ts`
- Create: `src/readiness/rules/index.ts`
- Test: `src/__tests__/readiness-run.test.ts`

**Interfaces:**
- Consumes: all rules (Tasks 3-5), `buildReport` (Task 1), `discoverStack`/`parseConnectionString` (existing), `PgLiveClient` (existing)
- Produces:
  - `allRules: ReadinessRule[]` (rules/index.ts)
  - `runReadiness(opts?: { configPath?: string }): Promise<ReadinessReport>` — full pipeline for CLI/MCP
  - `runRules(rules, sources, ctx): Promise<ReadinessFinding[]>` — pure core, unit-testable

- [ ] **Step 1: Write the failing test (core runner behavior)**

```typescript
// src/__tests__/readiness-run.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { runRules } from '../readiness/run.js';
import { allRules } from '../readiness/rules/index.js';
import type { ReadinessRule, ReadinessSources, ReadinessContext } from '../readiness/types.js';

const ctx = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;
const sources: ReadinessSources = {
  connectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => [],
  statementStats: async () => null,
};

describe('runRules', () => {
  it('skips rules whose applicable() is false', async () => {
    const findings = await runRules(allRules, sources, { ...ctx, serverless: false });
    expect(findings.some((f) => f.ruleId === 'serverless-pooling')).toBe(false);
  });

  it('a throwing rule becomes an unknown finding, not a crash', async () => {
    const bad: ReadinessRule = {
      id: 'bad', title: 'Bad',
      applicable: () => true,
      evaluate: async () => { throw new Error('boom'); },
    };
    const findings = await runRules([bad], sources, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('unknown');
    expect(findings[0]?.reason).toContain('boom');
  });

  it('registry contains the six v1 rules', () => {
    expect(allRules.map((r) => r.id).sort()).toEqual([
      'connection-headroom', 'connection-limit-tier', 'long-transactions',
      'missing-index', 'serverless-pooling', 'slow-queries',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-run.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement registry and runner**

```typescript
// src/readiness/rules/index.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';
import { connectionHeadroomRule } from './connection-headroom.js';
import { connectionLimitTierRule } from './connection-limit-tier.js';
import { longTransactionsRule } from './long-transactions.js';
import { missingIndexRule } from './missing-index.js';
import { slowQueriesRule } from './slow-queries.js';
import { serverlessPoolingRule } from './serverless-pooling.js';

export const allRules: ReadinessRule[] = [
  connectionHeadroomRule,
  connectionLimitTierRule,
  longTransactionsRule,
  missingIndexRule,
  slowQueriesRule,
  serverlessPoolingRule,
];
```

```typescript
// src/readiness/run.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Readiness pipeline: build context from stack discovery, connect the pg
 * live client, run applicable rules with per-rule error isolation, score.
 *
 * Honesty policy: a connection failure becomes an explicit can't-assess
 * finding in the report. There is no fallback to simulated data.
 */

import { discoverStack } from '../cli/autodiscovery.js';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
import { buildReport } from './report.js';
import { allRules } from './rules/index.js';
import type {
  ReadinessContext, ReadinessFinding, ReadinessReport, ReadinessRule, ReadinessSources,
} from './types.js';

export async function runRules(
  rules: ReadinessRule[],
  sources: ReadinessSources,
  ctx: ReadinessContext,
): Promise<ReadinessFinding[]> {
  const findings: ReadinessFinding[] = [];
  for (const rule of rules) {
    if (!rule.applicable(ctx)) continue;
    try {
      findings.push(await rule.evaluate(sources, ctx));
    } catch (err) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        status: 'unknown',
        evidence: [],
        explanation: 'This rule could not be evaluated.',
        fix: 'Re-run once the underlying error is resolved.',
        learnMoreUrl: 'https://github.com/trs-80/crisismode',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return findings;
}

function cantAssess(reason: string): ReadinessFinding {
  return {
    ruleId: 'readiness',
    title: 'Scale readiness',
    status: 'unknown',
    evidence: [],
    explanation: 'CrisisMode could not reach the database to assess readiness.',
    fix: 'Check DATABASE_URL and that the database accepts connections from this machine.',
    learnMoreUrl: 'https://www.postgresql.org/docs/current/monitoring.html',
    reason,
  };
}

export async function runReadiness(): Promise<ReadinessReport> {
  const stack = await discoverStack();
  const serverless =
    stack.platform.platform === 'vercel' || stack.vercelProject !== undefined;

  const pgTarget = stack.derivedTargets.find((t) => t.kind === 'postgresql');
  const ctx: ReadinessContext = {
    stack,
    serverless,
    target: pgTarget?.primary
      ? { host: pgTarget.primary.host, port: pgTarget.primary.port }
      : undefined,
  };

  if (!ctx.target || !pgTarget) {
    return buildReport([cantAssess('no PostgreSQL target found (set DATABASE_URL or configure crisismode.yaml)')]);
  }

  let client: PgLiveClient;
  try {
    client = new PgLiveClient(/* build PgConnectionConfig from pgTarget — reuse the
      exact construction used by createAgentForTarget in src/cli/runtime.ts */);
    await client.connect();
  } catch (err) {
    return buildReport([cantAssess(err instanceof Error ? err.message : String(err))]);
  }

  try {
    const sources: ReadinessSources = {
      connectionUsage: () => client.queryConnectionUsage(),
      tableStats: () => client.queryTableStats?.() ?? Promise.resolve(null),
      statementStats: () => client.queryStatementStats?.() ?? Promise.resolve(null),
    };
    const findings = await runRules(allRules, sources, ctx);
    return buildReport(findings);
  } finally {
    await client.close();
  }
}
```

Implementation note (not a placeholder in the plan's contract — an explicit
pointer): the `PgLiveClient` constructor call MUST copy the exact
config-building used by `createAgentForTarget` in `src/cli/runtime.ts`
(credentials env resolution included), and use the client's actual
connect/close method names from `src/agent/pg-replication/live-client.ts`.
Read both before writing this call.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-run.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full suite + commit**

```bash
pnpm run typecheck && pnpm test
git add src/readiness/ src/__tests__/readiness-run.test.ts
git commit -m "feat(readiness): rule registry and pipeline with error isolation"
```

---

### Task 7: CLI command `crisismode readiness`

**Files:**
- Create: `src/cli/commands/readiness.ts`
- Modify: `src/cli/index.ts` (new `case 'readiness'` + help text line)
- Test: `src/__tests__/readiness-cli.test.ts`

**Interfaces:**
- Consumes: `runReadiness` (Task 6), `printBanner`/`printInfo`/`jsonOut`/`getOutputMode` from `src/cli/output.ts`
- Produces: `runReadinessCommand(): Promise<void>`

- [ ] **Step 1: Write the failing test (renderer, via report injection)**

Structure `readiness.ts` so rendering is testable without a database: export
`renderReadinessReport(report: ReadinessReport): string[]` (pure) used by
`runReadinessCommand`.

```typescript
// src/__tests__/readiness-cli.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { renderReadinessReport } from '../cli/commands/readiness.js';
import type { ReadinessReport } from '../readiness/types.js';

const report: ReadinessReport = {
  verdict: 'at-risk',
  score: 90,
  evaluated: 5,
  unknown: 1,
  findings: [{
    ruleId: 'connection-headroom', title: 'Database connection headroom',
    status: 'at_risk', headroom: 0.35,
    evidence: ['65 of 100 connections in use (65%)'],
    explanation: 'explanation text', fix: 'add a pooler',
    learnMoreUrl: 'https://example.com',
  }, {
    ruleId: 'slow-queries', title: 'Slow queries', status: 'unknown',
    evidence: [], explanation: 'x', fix: 'x', learnMoreUrl: 'https://example.com',
    reason: 'pg_stat_statements is not available',
  }],
};

describe('renderReadinessReport', () => {
  it('shows verdict, score, and the ran-vs-could-not-run line', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('at-risk');
    expect(out).toContain('90');
    expect(out).toContain('5 rules evaluated, 1 could not run');
  });
  it('shows evidence and fix for non-ready findings', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('65 of 100');
    expect(out).toContain('add a pooler');
  });
  it('shows the unknown reason', () => {
    const out = renderReadinessReport(report).join('\n');
    expect(out).toContain('pg_stat_statements is not available');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement command module**

```typescript
// src/cli/commands/readiness.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode readiness` — forward-looking scale-readiness report.
 * Read-only; suggest escalation level at most.
 */

import { runReadiness } from '../../readiness/run.js';
import { printBanner, printInfo, jsonOut, getOutputMode } from '../output.js';
import type { ReadinessReport } from '../../readiness/types.js';

const STATUS_ICON: Record<string, string> = {
  ready: '✅', at_risk: '🟡', blocking: '🔴', unknown: '❔',
};

export function renderReadinessReport(report: ReadinessReport): string[] {
  const lines: string[] = [];
  lines.push(`Scale readiness: ${report.verdict} (score ${report.score}/100)`);
  lines.push(`${report.evaluated} rules evaluated, ${report.unknown} could not run`);
  lines.push('');
  for (const f of report.findings) {
    lines.push(`${STATUS_ICON[f.status] ?? '·'} ${f.title} [${f.status}]`);
    for (const e of f.evidence) lines.push(`    ${e}`);
    if (f.status === 'unknown' && f.reason) lines.push(`    could not run: ${f.reason}`);
    if (f.status === 'at_risk' || f.status === 'blocking') {
      lines.push(`    ${f.explanation}`);
      lines.push(`    Fix: ${f.fix}`);
      lines.push(`    Learn more: ${f.learnMoreUrl}`);
    }
  }
  return lines;
}

export async function runReadinessCommand(): Promise<void> {
  const report = await runReadiness();
  if (getOutputMode() === 'machine') {
    jsonOut('readiness', report);
    return;
  }
  printBanner();
  for (const line of renderReadinessReport(report)) printInfo(line);
}
```

Adjust `printInfo`/`getOutputMode`/mode-string usage to the exact signatures
in `src/cli/output.ts` (read it first — e.g. the machine mode enum value).

- [ ] **Step 4: Wire into the CLI dispatcher**

In `src/cli/index.ts`, alongside the existing cases:

```typescript
    case 'readiness': {
      const { runReadinessCommand } = await import('./commands/readiness.js');
      await runReadinessCommand();
      break;
    }
```

Add to the help text (near the scan line):

```
    crisismode readiness                   Scale-readiness report (read-only, will-it-break-under-load)
```

- [ ] **Step 5: Run tests, smoke the command, commit**

```bash
pnpm vitest run src/__tests__/readiness-cli.test.ts   # expect PASS (3 tests)
npx tsx src/cli/index.ts readiness                     # expect a report or an honest "cannot assess" — never a crash
pnpm run typecheck
git add src/cli/commands/readiness.ts src/cli/index.ts src/__tests__/readiness-cli.test.ts
git commit -m "feat(cli): crisismode readiness command"
```

---

### Task 8: MCP tool `crisismode_readiness`

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `src/__tests__/mcp-readiness.test.ts` (follow the existing MCP test file's setup pattern — find it with `grep -l readOnlyHint src/__tests__/*.ts`)

**Interfaces:**
- Consumes: `runReadiness` (Task 6)
- Produces: MCP tool `crisismode_readiness`, `annotations: { readOnlyHint: true }`

- [ ] **Step 1: Write the failing test**

Mirror the existing MCP server test's registration assertions (same helper/mocking approach), adding:

```typescript
// src/__tests__/mcp-readiness.test.ts — assertions to include:
// 1. tool 'crisismode_readiness' is registered
// 2. its annotations include readOnlyHint: true
// 3. ALL registered tools have readOnlyHint: true  (the 8-for-8 invariant)
```

Write it as real code copied from the existing MCP test file's structure — the registration-capture helper already exists there.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/mcp-readiness.test.ts`
Expected: FAIL — tool not registered

- [ ] **Step 3: Register the tool**

In `src/mcp/server.ts` (import `runReadiness` at top; add after the last `registerTool` call; update the file-header tool list comment to include it):

```typescript
  server.registerTool(
    'crisismode_readiness',
    {
      title: 'Scale-readiness report',
      description:
        'Forward-looking scale-readiness check for the detected stack (serverless + PostgreSQL): connection headroom, pooling, indexes, slow queries. Returns a scored report with plain-English findings and fixes. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => toResult(await runReadiness()),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/mcp-readiness.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/__tests__/mcp-readiness.test.ts
git commit -m "feat(mcp): crisismode_readiness read-only tool"
```

---

### Task 9: Attribution layer in signal explanations

**Files:**
- Modify: `src/framework/signal-explanations.ts`
- Modify: call sites that render diagnosis explanations in serverless-aware paths — locate with `grep -rn "enrichDiagnosis\|enrichHealth" src/cli src/mcp`
- Test: `src/__tests__/signal-attributions.test.ts`

**Interfaces:**
- Consumes: existing `SignalExplanation`, `explainSource`
- Produces: `ExplanationContext { serverless: boolean }`; `explainSourceInContext(source: string, ctx: ExplanationContext): SignalExplanation | undefined` — same shape as `explainSource`, with attribution appended when context matches. `explainSource` behavior is unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/signal-attributions.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { explainSource, explainSourceInContext } from '../framework/signal-explanations.js';

describe('explainSourceInContext', () => {
  it('appends serverless attribution to connection-exhaustion sources', () => {
    const plain = explainSource('pg_connection_pool');
    const ctx = explainSourceInContext('pg_connection_pool', { serverless: true });
    expect(ctx?.explanation).toContain(plain?.explanation ?? '');
    expect(ctx?.explanation).toContain('serverless');
    expect(ctx?.explanation).toContain('pooled connection string');
  });

  it('no attribution without serverless context', () => {
    const plain = explainSource('pg_connection_pool');
    const ctx = explainSourceInContext('pg_connection_pool', { serverless: false });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });

  it('non-matching sources pass through unchanged', () => {
    const plain = explainSource('dns_resolution');
    const ctx = explainSourceInContext('dns_resolution', { serverless: true });
    expect(ctx?.explanation).toBe(plain?.explanation);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/signal-attributions.test.ts`
Expected: FAIL — `explainSourceInContext` not exported

- [ ] **Step 3: Implement attributions**

Append to `src/framework/signal-explanations.ts`:

```typescript
export interface ExplanationContext {
  /** True when the app deploys to a serverless platform (Vercel detected). */
  serverless: boolean;
}

/** Scaling attributions layered onto base explanations when context matches. */
const ATTRIBUTIONS: Array<{ match: RegExp; when: (ctx: ExplanationContext) => boolean; append: string }> = [
  {
    match: /^pg_connection|connection_pool|pool_exhaust/,
    when: (ctx) => ctx.serverless,
    append:
      ' In a serverless deploy, each function invocation opens its own database connection — traffic spikes become connection spikes. Use a pooled connection string (or pgbouncer) for serverless functions.',
  },
  {
    match: /queue|consumer|lag_/,
    when: (ctx) => ctx.serverless,
    append:
      ' On serverless platforms, background work competes with request traffic for the same concurrency limits — a burst of requests can starve your workers and grow the backlog.',
  },
];

export function explainSourceInContext(
  source: string,
  ctx: ExplanationContext,
): SignalExplanation | undefined {
  const base = explainSource(source);
  if (!base) return undefined;
  const extra = ATTRIBUTIONS.filter((a) => a.match.test(source) && a.when(ctx))
    .map((a) => a.append)
    .join('');
  return extra ? { ...base, explanation: base.explanation + extra } : base;
}
```

- [ ] **Step 4: Wire context at call sites**

At each diagnosis-rendering call site found in Step 0's grep (CLI diagnose
path at minimum): compute `serverless` once via
`readVercelProjectConfig(process.cwd()) !== null || process.env['VERCEL_TOKEN'] !== undefined`
(import from `../cli/autodiscovery.js` — adjust relative path per file) and
prefer `explainSourceInContext(source, { serverless })` where
`explainSource(source)` is used today. Keep `explainSource` intact for
callers without context. If `enrichDiagnosis`/`enrichHealth` are the actual
render path, add an optional `ctx?: ExplanationContext` parameter that
defaults to `{ serverless: false }` — additive, no breaking change.

- [ ] **Step 5: Run tests, full suite, commit**

```bash
pnpm vitest run src/__tests__/signal-attributions.test.ts   # PASS (3 tests)
pnpm run typecheck && pnpm test
git add src/framework/signal-explanations.ts src/cli src/__tests__/signal-attributions.test.ts
git commit -m "feat(framework): serverless scaling attributions in signal explanations"
```

---

### Task 10: Docs, full verification, eval gate

**Files:**
- Modify: `README.md` (CLI reference + MCP tool table)
- Modify: `CLAUDE.md` (CLI command table + Key Files)
- Modify: `GETTING_STARTED.md` (CLI subcommand list)
- No new tests — this task is docs + gates

- [ ] **Step 1: README** — add to the CLI reference block:

```
crisismode readiness                  # Scale-readiness report (read-only): will this stack break under load?
```

Add a row to the MCP tools table and change its intro from 7 to 8 tools:

```
| `crisismode_readiness` | Forward-looking scale-readiness report: connection headroom, pooling, indexes, slow queries |
```

- [ ] **Step 2: CLAUDE.md** — add `readiness` to the CLI command table; update the `mcp` row's "7 read-only tools" to 8 (both occurrences — command table and Key Files row); add `src/readiness/` to Key Files:

```
| `src/readiness/` | Scale-readiness rule registry (readiness command + MCP tool) |
```

- [ ] **Step 3: GETTING_STARTED.md** — add `readiness` to the CLI commands sentence.

- [ ] **Step 4: Full verification gates**

```bash
pnpm run typecheck        # clean
pnpm run lint             # clean
pnpm test                 # all pass (expect ~1930+, up from 1905)
pnpm run build            # clean
pnpm run build:bundle && pnpm run eval:diagnosis:gate   # ≥13/14 — REQUIRED (attribution touched explanations)
```

- [ ] **Step 5: Commit docs and open the PR**

```bash
git add README.md CLAUDE.md GETTING_STARTED.md
git commit -m "docs: readiness command, 8th MCP tool, readiness module references"
git push -u origin feat/scale-readiness
gh pr create --title "feat: scale-readiness report and serverless scaling attributions" \
  --body "Implements docs/superpowers/specs/2026-07-18-scale-readiness-design.md (see spec for scope decisions). Six read-only rules, readiness CLI command, 8th read-only MCP tool, serverless attributions in diagnosis explanations. Eval gate re-run: <paste score>."
```

---

## Self-Review Notes

- Spec coverage: six rules (Tasks 3-5), runner + honesty policy (Task 6), CLI (Task 7), MCP + readOnlyHint invariant (Task 8), attribution layer (Task 9), docs + eval gate (Task 10), scoring with unknown-separation (Task 1), pg stats sources (Task 2). Latency checks intentionally absent per spec.
- Two deliberate read-before-write pointers remain (PgLiveClient constructor in Task 6; MCP test scaffold in Task 8; output-mode API in Task 7): these copy existing in-repo patterns whose exact shape the implementer must mirror, and inventing them in the plan risks drift from reality. Each pointer names the exact file to copy from.
- Type consistency verified: `ReadinessFinding.ruleId/title/status/headroom/evidence/explanation/fix/learnMoreUrl/reason` used identically in Tasks 1, 3-7; `TableStat`/`StatementStat` shapes match between Tasks 1, 2, and 4.
