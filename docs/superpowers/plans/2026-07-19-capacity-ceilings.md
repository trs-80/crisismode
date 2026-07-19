# Capacity Ceilings & Weak-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Capacity ceilings" section in the readiness report — honest upper bounds per stack component with labeled evidence classes, plus a conditional weak-link verdict.

**Architecture:** Extends `src/readiness/` (no new module): pure `ceilings.ts` + `weak-link.ts` computed from `ReadinessSources`, which gains optional probes (pg statement aggregate, redis limits, local fd limit, declared network egress). Ceilings are report context — they never affect the readiness score or verdict.

**Tech Stack:** TypeScript strict ESM (NodeNext, `.js` imports), vitest, existing PgLiveClient/RedisLiveClient.

**Spec:** `docs/superpowers/specs/2026-07-19-capacity-ceilings-design.md` (read it first — its "Core honesty rules" section is binding on every task).

## Global Constraints

- Ceilings are ALWAYS "at most" upper bounds with a named source; never predictions. Every ceiling carries a caveat that residence time inflates under load.
- Evidence classes labeled on every ceiling: `declared` | `measured` | `typical`. `typical` ceilings are cited ranges only and NEVER determine the weak-link verdict.
- Conversions to requests/s require a measured fan-out; none is measured in v1, so ALL req/s figures are conditional, rendered with the assumption set {1, 3, 10} queries/request and labeled conditional.
- Unavailable probe ⇒ ceiling omitted with a reason (never fabricated); zero computable ceilings ⇒ the section says exactly that.
- Ceilings and weak-link NEVER change `ReadinessReport.score`/`verdict` or any rule finding.
- Read-only end to end; redis/pg clients closed on every exit path (follow the Task-6 try/finally precedent from the readiness plan).
- Named constants with rationale comments; exact-boundary tests for every threshold/branch (established branch convention).
- SPDX header (`// SPDX-License-Identifier: Apache-2.0` + `// Copyright 2026 CrisisMode Contributors`) on every new file; `import type`; `.js` extensions; named exports; Conventional Commits.
- Network egress comes ONLY from declared config (`network.egressMbps` in crisismode.yaml) — never measured from the operator's machine.

---

### Task 1: Ceiling types and computeCeilings core

**Files:**
- Modify: `src/readiness/types.ts` (append ceiling types; add optional probe members to `ReadinessSources`)
- Create: `src/readiness/ceilings.ts`
- Test: `src/__tests__/readiness-ceilings.test.ts`

**Interfaces:**
- Consumes: existing `ReadinessSources`, `ReadinessContext`, `ConnectionUsage`
- Produces (exact names later tasks rely on):
  - types: `EvidenceClass`, `CapacityCeiling { id, title, value, unit, rangeLow?, rangeHigh?, evidenceClasses, evidence, caveat }`, `OmittedCeiling { id, reason }`, `CeilingsResult { ceilings, omitted }`
  - `ReadinessSources` optional members: `statementAggregate?(): Promise<StatementAggregate | null>`, `redisLimits?(): Promise<RedisLimits | null>`, `fdLimit?(): Promise<number | null>`, `declaredEgressMbps?(): Promise<number | null>`
  - `StatementAggregate { meanMs: number; calls: number }`, `RedisLimits { maxmemoryBytes: number; usedMemoryBytes: number; maxclients: number; connectedClients: number }`
  - `computeCeilings(sources: ReadinessSources, ctx: ReadinessContext): Promise<CeilingsResult>`

- [ ] **Step 1: Append types to `src/readiness/types.ts`**

```typescript
export type EvidenceClass = 'declared' | 'measured' | 'typical';

/** Aggregate over ALL of pg_stat_statements — the true mean, not the top-N-slowest mean. */
export interface StatementAggregate {
  meanMs: number;
  calls: number;
}

export interface RedisLimits {
  maxmemoryBytes: number;
  usedMemoryBytes: number;
  maxclients: number;
  connectedClients: number;
}

/**
 * An honest upper bound on one stack component. `value` is "at most" in
 * `unit`; typical-range ceilings carry rangeLow/rangeHigh instead of value.
 */
export interface CapacityCeiling {
  id: string;
  title: string;
  value: number | null;
  unit: string;
  rangeLow?: number | undefined;
  rangeHigh?: number | undefined;
  evidenceClasses: EvidenceClass[];
  /** One line per input, each naming its class: "max_connections = 100 (declared)" */
  evidence: string[];
  caveat: string;
}

export interface OmittedCeiling {
  id: string;
  reason: string;
}

export interface CeilingsResult {
  ceilings: CapacityCeiling[];
  omitted: OmittedCeiling[];
}
```

And extend `ReadinessSources` (existing three members unchanged):

```typescript
export interface ReadinessSources {
  connectionUsage(): Promise<ConnectionUsage | null>;
  tableStats(): Promise<TableStat[] | null>;
  statementStats(): Promise<StatementStat[] | null>;
  /** Optional ceiling probes — absent member ⇒ that ceiling is omitted with a reason. */
  statementAggregate?(): Promise<StatementAggregate | null>;
  redisLimits?(): Promise<RedisLimits | null>;
  fdLimit?(): Promise<number | null>;
  declaredEgressMbps?(): Promise<number | null>;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/__tests__/readiness-ceilings.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { computeCeilings } from '../readiness/ceilings.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';

const ctx = (over: Partial<{ serverless: boolean; framework: string | null }> = {}): ReadinessContext =>
  ({
    serverless: over.serverless ?? false,
    target: { host: 'db', port: 5432 },
    stack: {
      services: [], envHints: [], aiProviders: [], derivedTargets: [], derivedNotes: {}, confidence: 0,
      platform: { platform: null, detected: false, signals: [] },
      appStack: { framework: over.framework ?? null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    },
  }) as ReadinessContext;

const sources = (over: Partial<ReadinessSources> = {}): ReadinessSources => ({
  connectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => null,
  statementStats: async () => null,
  ...over,
});

describe('computeCeilings', () => {
  it('db-connections ceiling from max_connections (declared)', async () => {
    const { ceilings } = await computeCeilings(sources(), ctx());
    const c = ceilings.find((x) => x.id === 'db-connections');
    expect(c?.value).toBe(100);
    expect(c?.unit).toBe('connections');
    expect(c?.evidenceClasses).toEqual(['declared']);
    expect(c?.evidence.join(' ')).toContain('max_connections = 100');
    expect(c?.caveat).toContain('at most');
  });

  it('db-throughput via Little: 100 conns / 50ms = 2000 q/s (declared+measured)', async () => {
    const { ceilings } = await computeCeilings(
      sources({ statementAggregate: async () => ({ meanMs: 50, calls: 10_000 }) }), ctx());
    const c = ceilings.find((x) => x.id === 'db-throughput');
    expect(c?.value).toBe(2000);
    expect(c?.unit).toBe('queries/s');
    expect(c?.evidenceClasses).toEqual(['declared', 'measured']);
  });

  it('db-throughput omitted with reason when aggregate unavailable', async () => {
    const { ceilings, omitted } = await computeCeilings(sources(), ctx());
    expect(ceilings.some((x) => x.id === 'db-throughput')).toBe(false);
    expect(omitted.find((o) => o.id === 'db-throughput')?.reason).toContain('pg_stat_statements');
  });

  it('redis ceilings from limits probe', async () => {
    const { ceilings } = await computeCeilings(
      sources({ redisLimits: async () => ({ maxmemoryBytes: 1024, usedMemoryBytes: 512, maxclients: 10000, connectedClients: 5 }) }), ctx());
    expect(ceilings.find((x) => x.id === 'redis-memory')?.value).toBe(1024);
    expect(ceilings.find((x) => x.id === 'redis-clients')?.value).toBe(10000);
  });

  it('fd-limit reported for non-serverless, suppressed for serverless', async () => {
    const withFd = sources({ fdLimit: async () => 1024 });
    const local = await computeCeilings(withFd, ctx({ serverless: false }));
    expect(local.ceilings.find((x) => x.id === 'fd-limit')?.value).toBe(1024);
    const sls = await computeCeilings(withFd, ctx({ serverless: true }));
    expect(sls.ceilings.some((x) => x.id === 'fd-limit')).toBe(false);
    expect(sls.omitted.find((o) => o.id === 'fd-limit')?.reason).toContain('serverless');
  });

  it('network-egress from declared Mbps only', async () => {
    const { ceilings } = await computeCeilings(
      sources({ declaredEgressMbps: async () => 30 }), ctx());
    const c = ceilings.find((x) => x.id === 'network-egress');
    expect(c?.value).toBe(3_750_000); // 30 Mbps = 3.75 MB/s
    expect(c?.unit).toBe('bytes/s');
    expect(c?.evidenceClasses).toEqual(['declared']);
  });

  it('node-typical range appears only for Node frameworks and is typical-class', async () => {
    const { ceilings } = await computeCeilings(sources(), ctx({ framework: 'express' }));
    const c = ceilings.find((x) => x.id === 'node-typical');
    expect(c?.value).toBeNull();
    expect(c?.rangeLow).toBeGreaterThan(0);
    expect(c?.evidenceClasses).toEqual(['typical']);
    const none = await computeCeilings(sources(), ctx({ framework: null }));
    expect(none.ceilings.some((x) => x.id === 'node-typical')).toBe(false);
  });

  it('connectionUsage null omits both db ceilings with reasons', async () => {
    const { ceilings, omitted } = await computeCeilings(
      sources({ connectionUsage: async () => null }), ctx());
    expect(ceilings.filter((x) => x.id.startsWith('db-'))).toHaveLength(0);
    expect(omitted.map((o) => o.id)).toEqual(expect.arrayContaining(['db-connections', 'db-throughput']));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-ceilings.test.ts`
Expected: FAIL — cannot resolve `../readiness/ceilings.js`

- [ ] **Step 4: Implement `src/readiness/ceilings.ts`**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Capacity ceilings: honest per-component upper bounds computed from
 * declared config and measured latency. Ceilings are report CONTEXT —
 * they never affect the readiness score or verdict.
 */

import type {
  CapacityCeiling, CeilingsResult, OmittedCeiling, ReadinessContext, ReadinessSources,
} from './types.js';

/** Every Little-derived bound is optimistic: residence time inflates under load. */
const AT_MOST_CAVEAT =
  'This is an upper bound ("at most") — latency grows with utilization, so real capacity is lower; systems degrade well before the ceiling (~80% is the practical wall).';

/** 1 Mbps = 125_000 bytes/s. */
const BYTES_PER_MBPS = 125_000;

/** Cited community range for a single Node.js instance on light handlers. */
const NODE_TYPICAL_LOW_RPS = 1_000;
const NODE_TYPICAL_HIGH_RPS = 5_000;
const NODE_FRAMEWORKS = new Set(['express', 'fastify', 'next', 'remix', 'nest']);

export async function computeCeilings(
  sources: ReadinessSources,
  ctx: ReadinessContext,
): Promise<CeilingsResult> {
  const ceilings: CapacityCeiling[] = [];
  const omitted: OmittedCeiling[] = [];

  const usage = await sources.connectionUsage();
  if (usage) {
    ceilings.push({
      id: 'db-connections',
      title: 'Database concurrent queries',
      value: usage.max,
      unit: 'connections',
      evidenceClasses: ['declared'],
      evidence: [`max_connections = ${usage.max} (declared)`],
      caveat: AT_MOST_CAVEAT,
    });

    const agg = (await sources.statementAggregate?.()) ?? null;
    if (agg && agg.meanMs > 0) {
      // Little's law: λ_max = C / W
      ceilings.push({
        id: 'db-throughput',
        title: 'Database throughput',
        value: Math.round(usage.max * (1000 / agg.meanMs)),
        unit: 'queries/s',
        evidenceClasses: ['declared', 'measured'],
        evidence: [
          `max_connections = ${usage.max} (declared)`,
          `mean query time = ${agg.meanMs.toFixed(1)}ms over ${agg.calls} calls (measured, pg_stat_statements)`,
        ],
        caveat: AT_MOST_CAVEAT,
      });
    } else {
      omitted.push({ id: 'db-throughput', reason: 'mean query time unavailable (pg_stat_statements absent or empty)' });
    }
  } else {
    omitted.push({ id: 'db-connections', reason: 'could not read max_connections' });
    omitted.push({ id: 'db-throughput', reason: 'could not read max_connections' });
  }

  const redis = (await sources.redisLimits?.()) ?? null;
  if (redis) {
    ceilings.push({
      id: 'redis-memory',
      title: 'Redis memory',
      value: redis.maxmemoryBytes,
      unit: 'bytes',
      evidenceClasses: ['declared'],
      evidence: [
        `maxmemory = ${redis.maxmemoryBytes} bytes (declared)`,
        `used_memory = ${redis.usedMemoryBytes} bytes (measured)`,
      ],
      caveat: AT_MOST_CAVEAT,
    });
    ceilings.push({
      id: 'redis-clients',
      title: 'Redis client connections',
      value: redis.maxclients,
      unit: 'connections',
      evidenceClasses: ['declared'],
      evidence: [
        `maxclients = ${redis.maxclients} (declared)`,
        `connected_clients = ${redis.connectedClients} (measured)`,
      ],
      caveat: AT_MOST_CAVEAT,
    });
  } else {
    omitted.push({ id: 'redis-limits', reason: 'no Redis target or limits unreadable' });
  }

  if (ctx.serverless) {
    omitted.push({ id: 'fd-limit', reason: 'suppressed on serverless platforms — the local file-descriptor limit is not the app host’s limit' });
  } else {
    const fd = (await sources.fdLimit?.()) ?? null;
    if (fd !== null) {
      ceilings.push({
        id: 'fd-limit',
        title: 'File descriptors (this machine)',
        value: fd,
        unit: 'open sockets/files',
        evidenceClasses: ['declared'],
        evidence: [`open-files soft limit = ${fd} (declared, this machine)`],
        caveat: AT_MOST_CAVEAT,
      });
    } else {
      omitted.push({ id: 'fd-limit', reason: 'file-descriptor limit unreadable' });
    }
  }

  const mbps = (await sources.declaredEgressMbps?.()) ?? null;
  if (mbps !== null) {
    ceilings.push({
      id: 'network-egress',
      title: 'Network egress',
      value: mbps * BYTES_PER_MBPS,
      unit: 'bytes/s',
      evidenceClasses: ['declared'],
      evidence: [`network.egressMbps = ${mbps} (declared in crisismode.yaml)`],
      caveat: AT_MOST_CAVEAT,
    });
  } else {
    omitted.push({ id: 'network-egress', reason: 'no declared link speed (set network.egressMbps in crisismode.yaml)' });
  }

  const fw = ctx.stack.appStack.framework;
  if (fw && NODE_FRAMEWORKS.has(fw)) {
    ceilings.push({
      id: 'node-typical',
      title: 'Node.js single instance (typical range)',
      value: null,
      unit: 'requests/s',
      rangeLow: NODE_TYPICAL_LOW_RPS,
      rangeHigh: NODE_TYPICAL_HIGH_RPS,
      evidenceClasses: ['typical'],
      evidence: [
        `framework = ${fw}; typical single-instance Node.js HTTP throughput for light handlers (community benchmarks) — NOT a measurement of this system`,
      ],
      caveat: 'Cited range only; CPU-bound handlers serialize on the event loop and land far lower.',
    });
  }

  return { ceilings, omitted };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-ceilings.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run typecheck
git add src/readiness/types.ts src/readiness/ceilings.ts src/__tests__/readiness-ceilings.test.ts
git commit -m "feat(readiness): capacity ceiling types and computeCeilings"
```

---

### Task 2: Weak-link ranking

**Files:**
- Create: `src/readiness/weak-link.ts`
- Test: `src/__tests__/readiness-weak-link.test.ts`

**Interfaces:**
- Consumes: `CeilingsResult`, `CapacityCeiling` (Task 1)
- Produces: `FANOUT_ASSUMPTIONS`, `ConditionalBinding { queriesPerRequest, bindingCeilingId, requestsPerSec }`, `WeakLinkVerdict { binding, conditional, note }`, `rankWeakLink(result: CeilingsResult): WeakLinkVerdict`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/readiness-weak-link.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { rankWeakLink, FANOUT_ASSUMPTIONS } from '../readiness/weak-link.js';
import type { CapacityCeiling, CeilingsResult } from '../readiness/types.js';

const ceiling = (over: Partial<CapacityCeiling>): CapacityCeiling => ({
  id: 'x', title: 'X', value: 100, unit: 'connections',
  evidenceClasses: ['declared'], evidence: [], caveat: 'at most', ...over,
});
const result = (ceilings: CapacityCeiling[]): CeilingsResult => ({ ceilings, omitted: [] });

describe('rankWeakLink', () => {
  it('converts db-throughput per fan-out assumption {1,3,10}', () => {
    const v = rankWeakLink(result([ceiling({ id: 'db-throughput', value: 2000, unit: 'queries/s', evidenceClasses: ['declared', 'measured'] })]));
    expect(FANOUT_ASSUMPTIONS).toEqual([1, 3, 10]);
    expect(v.conditional).toEqual([
      { queriesPerRequest: 1, bindingCeilingId: 'db-throughput', requestsPerSec: 2000 },
      { queriesPerRequest: 3, bindingCeilingId: 'db-throughput', requestsPerSec: 667 },
      { queriesPerRequest: 10, bindingCeilingId: 'db-throughput', requestsPerSec: 200 },
    ]);
    expect(v.binding).toBe('db-throughput');
    expect(v.note).toContain('conditional');
  });

  it('typical-class ceilings never determine the verdict', () => {
    const v = rankWeakLink(result([
      ceiling({ id: 'db-throughput', value: 2000, unit: 'queries/s', evidenceClasses: ['declared', 'measured'] }),
      ceiling({ id: 'node-typical', value: null, unit: 'requests/s', rangeLow: 10, rangeHigh: 20, evidenceClasses: ['typical'] }),
    ]));
    expect(v.binding).toBe('db-throughput');
    expect(v.conditional.every((c) => c.bindingCeilingId !== 'node-typical')).toBe(true);
  });

  it('no convertible ceilings -> binding null with explanatory note', () => {
    const v = rankWeakLink(result([ceiling({ id: 'redis-clients', value: 10000, unit: 'connections' })]));
    expect(v.binding).toBeNull();
    expect(v.conditional).toEqual([]);
    expect(v.note).toContain('no ceiling convertible');
  });

  it('note always states constraint migration', () => {
    const v = rankWeakLink(result([ceiling({ id: 'db-throughput', value: 300, unit: 'queries/s' })]));
    expect(v.note).toContain('next');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-weak-link.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/readiness/weak-link.ts`**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Weak-link verdict: rank the ceilings convertible to requests/sec. No
 * fan-out is measured in v1, so every conversion is CONDITIONAL on an
 * assumed queries-per-request from FANOUT_ASSUMPTIONS. `typical`-class
 * ceilings never participate in the verdict.
 */

import type { CeilingsResult } from './types.js';

/** Default conditional fan-out set from the spec (queries per request). */
export const FANOUT_ASSUMPTIONS: readonly number[] = [1, 3, 10];

export interface ConditionalBinding {
  queriesPerRequest: number;
  bindingCeilingId: string;
  requestsPerSec: number;
}

export interface WeakLinkVerdict {
  /** Ceiling id that binds across ALL assumptions, or null when it varies / nothing is convertible. */
  binding: string | null;
  conditional: ConditionalBinding[];
  note: string;
}

const MIGRATION_NOTE =
  'Fixing the first bottleneck promotes the next one — re-run after any change.';

export function rankWeakLink(result: CeilingsResult): WeakLinkVerdict {
  // v1: only queries/s ceilings are convertible to requests/s (÷ fan-out).
  const convertible = result.ceilings.filter(
    (c) => c.unit === 'queries/s' && c.value !== null && !c.evidenceClasses.includes('typical'),
  );

  if (convertible.length === 0) {
    return {
      binding: null,
      conditional: [],
      note: `no ceiling convertible to requests/s yet (needs a measured or declared throughput input). ${MIGRATION_NOTE}`,
    };
  }

  const conditional: ConditionalBinding[] = FANOUT_ASSUMPTIONS.map((q) => {
    let best = convertible[0]!;
    let bestRps = Math.round((best.value ?? 0) / q);
    for (const c of convertible.slice(1)) {
      const rps = Math.round((c.value ?? 0) / q);
      if (rps < bestRps) {
        best = c;
        bestRps = rps;
      }
    }
    return { queriesPerRequest: q, bindingCeilingId: best.id, requestsPerSec: bestRps };
  });

  const ids = new Set(conditional.map((c) => c.bindingCeilingId));
  return {
    binding: ids.size === 1 ? conditional[0]!.bindingCeilingId : null,
    conditional,
    note: `conditional — queries-per-request is assumed, not measured. ${MIGRATION_NOTE}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-weak-link.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readiness/weak-link.ts src/__tests__/readiness-weak-link.test.ts
git commit -m "feat(readiness): conditional weak-link ranking"
```

---

### Task 3: pg statement-aggregate probe

**Files:**
- Modify: `src/agent/pg-replication/backend.ts` (optional method on `PgBackend`, after `queryStatementStats`)
- Modify: `src/agent/pg-replication/live-client.ts`
- Modify: `src/agent/pg-replication/simulator.ts`
- Test: `src/__tests__/readiness-pg-aggregate.test.ts`

**Interfaces:**
- Consumes: `StatementAggregate` (Task 1)
- Produces: `PgBackend.queryStatementAggregate?(): Promise<StatementAggregate | null>`; simulator setter `setStatementAggregate(agg: StatementAggregate | null)`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/readiness-pg-aggregate.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('PgSimulator statement aggregate fixture', () => {
  it('defaults to null (extension absent)', async () => {
    expect(await new PgSimulator().queryStatementAggregate()).toBeNull();
  });
  it('returns configured aggregate', async () => {
    const sim = new PgSimulator();
    sim.setStatementAggregate({ meanMs: 42.5, calls: 90_000 });
    expect(await sim.queryStatementAggregate()).toEqual({ meanMs: 42.5, calls: 90_000 });
  });
});
```

(If the simulator's exported class name differs from `PgSimulator`, use the actual name — same adaptation as the prior plan's Task 2.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-pg-aggregate.test.ts`
Expected: FAIL — `queryStatementAggregate` is not a function

- [ ] **Step 3: Implement all three files**

`backend.ts` (after `queryStatementStats?`; extend the existing `import type` from `../../readiness/types.js` with `StatementAggregate`):

```typescript
  /**
   * Calls-weighted mean over ALL of pg_stat_statements (readiness capacity
   * ceiling — the true mean, unlike the top-N-slowest queryStatementStats).
   * Optional; null when the extension is absent.
   */
  queryStatementAggregate?(): Promise<StatementAggregate | null>;
```

`live-client.ts` (after `queryStatementStats`, same null-on-error pattern; note `::float8` casts per the CodeRabbit bigint fix on this branch — `sum(calls)` is bigint):

```typescript
  async queryStatementAggregate(): Promise<StatementAggregate | null> {
    try {
      const result = await this.primaryPool.query<{ mean_ms: number | null; calls: number | null }>(`
        SELECT sum(total_exec_time) / NULLIF(sum(calls), 0) AS mean_ms,
               sum(calls)::float8 AS calls
        FROM pg_stat_statements
      `);
      const row = result.rows[0];
      if (!row || row.mean_ms === null || row.calls === null) return null;
      return { meanMs: row.mean_ms, calls: row.calls };
    } catch {
      return null; // extension absent or no privilege — ceiling reports omitted
    }
  }
```

`simulator.ts` (next to the existing stats fixtures):

```typescript
  private statementAggregate: StatementAggregate | null = null;

  setStatementAggregate(agg: StatementAggregate | null): void { this.statementAggregate = agg; }

  async queryStatementAggregate(): Promise<StatementAggregate | null> { return this.statementAggregate; }
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run src/__tests__/readiness-pg-aggregate.test.ts   # PASS (2 tests)
pnpm run typecheck && pnpm test
git add src/agent/pg-replication/ src/__tests__/readiness-pg-aggregate.test.ts
git commit -m "feat(pg-replication): optional statement-aggregate query for capacity ceilings"
```

---

### Task 4: redis server-limits probe

**Files:**
- Modify: `src/agent/redis/backend.ts` (optional method on `RedisBackend`)
- Modify: `src/agent/redis/live-client.ts`
- Modify: `src/agent/redis/simulator.ts`
- Test: `src/__tests__/readiness-redis-limits.test.ts`

**Interfaces:**
- Consumes: `RedisLimits` (Task 1)
- Produces: `RedisBackend.queryServerLimits?(): Promise<RedisLimits | null>`; simulator setter `setServerLimits(limits: RedisLimits | null)`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/readiness-redis-limits.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { RedisSimulator } from '../agent/redis/simulator.js';

describe('RedisSimulator server-limits fixture', () => {
  it('defaults to null', async () => {
    expect(await new RedisSimulator().queryServerLimits()).toBeNull();
  });
  it('returns configured limits', async () => {
    const sim = new RedisSimulator();
    sim.setServerLimits({ maxmemoryBytes: 104_857_600, usedMemoryBytes: 52_428_800, maxclients: 10_000, connectedClients: 12 });
    const l = await sim.queryServerLimits();
    expect(l?.maxclients).toBe(10_000);
  });
});
```

(Adapt the simulator class name to the actual export if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-redis-limits.test.ts`
Expected: FAIL — `setServerLimits` is not a function

- [ ] **Step 3: Implement**

`backend.ts` — optional member on `RedisBackend` with `import type { RedisLimits } from '../../readiness/types.js';`:

```typescript
  /** Declared server limits + current usage for capacity ceilings. Null when unreadable. */
  queryServerLimits?(): Promise<RedisLimits | null>;
```

`live-client.ts` — the class already parses `INFO` into sections (see the existing `maxmemory` handling around its INFO parsing) and can issue `CONFIG GET`. Implement with the same null-on-error contract, reusing the client's existing INFO/CONFIG helpers rather than new raw calls where they exist:

```typescript
  async queryServerLimits(): Promise<RedisLimits | null> {
    try {
      const info = await this.client.info();               // reuse existing info-section parser if the class has one
      const sections = parseInfoSections(info);            // whatever helper the class already uses for INFO
      const maxclientsReply = await this.client.config('GET', 'maxclients');
      const maxclients = Number(Array.isArray(maxclientsReply) ? maxclientsReply[1] : (maxclientsReply as Record<string, string>)['maxclients']);
      const maxmemoryBytes = Number(sections['maxmemory'] ?? 0);
      const usedMemoryBytes = Number(sections['used_memory'] ?? 0);
      const connectedClients = Number(sections['connected_clients'] ?? 0);
      if (!Number.isFinite(maxclients)) return null;
      return { maxmemoryBytes, usedMemoryBytes, maxclients, connectedClients };
    } catch {
      return null;
    }
  }
```

IMPORTANT adaptation: read `src/agent/redis/live-client.ts` first and reuse ITS actual INFO-parsing helper and CONFIG call shape (it already does `this.client.config('GET', 'maxmemory-policy')` and parses INFO into a sections map) — mirror those exact call/return shapes instead of the sketch's guesses. `node-redis` v4 returns `CONFIG GET` as an object map; ioredis returns a flat array — match whichever the file actually uses.

`simulator.ts`:

```typescript
  private serverLimits: RedisLimits | null = null;

  setServerLimits(limits: RedisLimits | null): void { this.serverLimits = limits; }

  async queryServerLimits(): Promise<RedisLimits | null> { return this.serverLimits; }
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run src/__tests__/readiness-redis-limits.test.ts   # PASS (2 tests)
pnpm run typecheck && pnpm test
git add src/agent/redis/ src/__tests__/readiness-redis-limits.test.ts
git commit -m "feat(redis): optional server-limits query for capacity ceilings"
```

---

### Task 5: Config field `network.egressMbps`

**Files:**
- Modify: `src/config/schema.ts` (optional `network` block on `SiteConfig`)
- Modify: the config loader/validator (find it: `src/config/loader.ts` — mirror how other optional top-level blocks are validated)
- Modify: `src/cli/commands/init.ts` template IF the generated template documents optional blocks (inspect first; if the template only emits required fields, leave it and note that in the report)
- Test: `src/__tests__/config-network.test.ts`

**Interfaces:**
- Produces: `SiteConfig.network?: { egressMbps?: number }` — consumed by Task 6's `declaredEgressMbps` wiring

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config-network.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';

const MINIMAL = `apiVersion: crisismode/v1
kind: SiteConfig
metadata:
  name: t
  environment: test
targets: []
`;

describe('network config block', () => {
  it('parses network.egressMbps when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-net-'));
    const p = join(dir, 'crisismode.yaml');
    writeFileSync(p, MINIMAL + 'network:\n  egressMbps: 30\n');
    const cfg = loadConfig(p);
    expect(cfg.network?.egressMbps).toBe(30);
  });

  it('absent network block yields undefined (not an error)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-net-'));
    const p = join(dir, 'crisismode.yaml');
    writeFileSync(p, MINIMAL);
    const cfg = loadConfig(p);
    expect(cfg.network).toBeUndefined();
  });

  it('rejects non-positive egressMbps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-net-'));
    const p = join(dir, 'crisismode.yaml');
    writeFileSync(p, MINIMAL + 'network:\n  egressMbps: -5\n');
    expect(() => loadConfig(p)).toThrow(/egressMbps/);
  });
});
```

Adaptation: `loadConfig`'s exact signature/return comes from `src/config/loader.ts` — if it takes options or returns `{config, source}`, adjust the test calls accordingly; if minimal-config fixtures already exist in another config test, reuse their fixture shape instead of MINIMAL.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/config-network.test.ts`
Expected: FAIL — `network` not on SiteConfig / validation missing

- [ ] **Step 3: Implement**

`schema.ts` — on `SiteConfig`:

```typescript
  /** Declared infrastructure facts that cannot be probed (capacity ceilings). */
  network?: {
    /** Declared egress link speed in Mbps — used as a declared ceiling, never measured. */
    egressMbps?: number;
  } | undefined;
```

Loader validation, following the file's existing validation style: when `network.egressMbps` is present it must be a finite number > 0, else throw with a message naming `network.egressMbps`.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run src/__tests__/config-network.test.ts   # PASS (3 tests)
pnpm run typecheck && pnpm test
git add src/config/ src/__tests__/config-network.test.ts
git commit -m "feat(config): declared network.egressMbps for capacity ceilings"
```

---

### Task 6: Runner integration

**Files:**
- Modify: `src/readiness/run.ts`
- Modify: `src/readiness/types.ts` (append optional `ceilings`/`weakLink`/`ceilingsOmitted` to `ReadinessReport`)
- Modify: `src/readiness/report.ts` (pass-through only — score untouched)
- Test: extend `src/__tests__/readiness-run.test.ts`

**Interfaces:**
- Consumes: `computeCeilings` (Task 1), `rankWeakLink` (Task 2), probes (Tasks 3-5)
- Produces: `ReadinessReport.ceilings?: CapacityCeiling[]`, `.ceilingsOmitted?: OmittedCeiling[]`, `.weakLink?: WeakLinkVerdict` — populated by `connectAndRunReadiness`; `buildReport` signature unchanged

Key wiring decisions (binding):
- `ReadinessPgClient` (the narrow interface in run.ts) gains `queryStatementAggregate(): Promise<StatementAggregate | null>` — required on the interface (PgLiveClient provides it; test fakes add one line).
- Redis: a `ReadinessRedisClient { queryServerLimits(): Promise<RedisLimits | null>; close(): Promise<void> }` narrow interface + injectable `RedisClientFactory` defaulting to the real `RedisLiveClient` (constructed from the first redis-kind derived target via `resolveCredentials`, mirroring the pg construction in the same file; `connectTimeoutMs: 2000` like `src/agent/redis/registration.ts`). Connect lazily INSIDE `sources.redisLimits` and close in the same outer `finally` that closes the pg client — a redis failure returns null (ceiling omitted), it must NOT fail the report.
- `fdLimit` reads `process.report.getReport().userLimits.open_files.soft`, returning null when unavailable or `'unlimited'` (verified shape on this platform: `{"soft":1048576,"hard":"unlimited"}`). Wrap in try/catch → null.
- `declaredEgressMbps` reads the loaded config's `network.egressMbps` (the runner must load config the same way the CLI does — check how `runReadiness` currently gets targets: it uses `discoverStack()`; config comes via `loadConfigWithDetection()` from `src/config/loader.js` — reuse whichever config accessor is already imported in the CLI readiness path, threading the value into `connectAndRunReadiness` as a parameter rather than re-loading inside).
- Ceilings computed AFTER `runRules`, inside the same try/finally (same live pg client), then `rankWeakLink`; attach all three fields to the report object returned by `buildReport` via spread: `return { ...buildReport(findings), ceilings, ceilingsOmitted: omitted, weakLink }`.
- Score/verdict: assert unchanged by ceilings in tests.

- [ ] **Step 1: Write the failing tests (extend readiness-run.test.ts)**

```typescript
  it('report carries ceilings and weakLink without affecting score', async () => {
    const closeSpy = vi.fn(async () => {});
    const fake = {
      queryConnectionCount: async () => 1,
      queryConnectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
      queryTableStats: async () => null,
      queryStatementStats: async () => null,
      queryStatementAggregate: async () => ({ meanMs: 50, calls: 1000 }),
      close: closeSpy,
    };
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => fake);
    expect(report.ceilings?.find((c) => c.id === 'db-throughput')?.value).toBe(2000);
    expect(report.weakLink?.binding).toBe('db-throughput');
    expect(report.score).toBe(buildReport(report.findings).score); // ceilings never move the score
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('redis probe failure omits the ceiling without failing the report', async () => {
    const redisClose = vi.fn(async () => {});
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient(), {
      createRedisClient: () => ({ queryServerLimits: async () => { throw new Error('conn refused'); }, close: redisClose }),
      redisTarget: REDIS_TARGET,
    });
    expect(report.verdict).not.toBe(undefined);
    expect(report.ceilingsOmitted?.some((o) => o.id === 'redis-limits')).toBe(true);
    expect(redisClose).toHaveBeenCalledTimes(1);
  });
```

(Reuse the file's existing `PG_TARGET`/ctx fixtures and fake-client helper; add `REDIS_TARGET` and `okFakePgClient` helpers in the same style. The exact options-parameter shape for redis injection is the implementer's choice — an options object as sketched, or extending the existing factory parameter — but both the redis close-on-failure and omit-not-fail behaviors must be asserted.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/__tests__/readiness-run.test.ts`
Expected: FAIL — `ceilings` undefined on report

- [ ] **Step 3: Implement per the wiring decisions above**

Follow run.ts's existing structure: the single outer try/finally gains redis-client cleanup; `sources` gains the four optional members; after `const findings = await runRules(...)`, add:

```typescript
    const { ceilings, omitted } = await computeCeilings(sources, ctx);
    const weakLink = rankWeakLink({ ceilings, omitted });
    return { ...buildReport(findings), ceilings, ceilingsOmitted: omitted, weakLink };
```

- [ ] **Step 4: Run tests, full suite, commit**

```bash
pnpm vitest run src/__tests__/readiness-run.test.ts   # PASS (7 tests)
pnpm run typecheck && pnpm test
git add src/readiness/ src/__tests__/readiness-run.test.ts
git commit -m "feat(readiness): wire capacity ceilings and weak-link into the pipeline"
```

---

### Task 7: Renderer — ceilings section and weak-link sentence

**Files:**
- Modify: `src/cli/commands/readiness.ts` (`renderReadinessReport`)
- Test: extend `src/__tests__/readiness-cli.test.ts`

**Interfaces:**
- Consumes: `ReadinessReport.ceilings/ceilingsOmitted/weakLink` (Task 6)
- Produces: renderer output; MCP needs no change (`toResult(await runReadiness())` already serializes the new fields)

Rendering rules (binding):
- Section header: `Capacity ceilings (upper bounds — real capacity is lower):`
- Value ceilings: `  <title>: at most <value> <unit> [<classes joined with ×>: <evidence joined with '; '>]`
- Range ceilings: `  <title>: typically <rangeLow>–<rangeHigh> <unit> (cited range, not a measurement) [typical: ...]`
- Omitted: `  Could not assess: <id> — <reason>` one line each
- Weak link, only when `weakLink.conditional` non-empty: `Weak link (conditional — fan-out assumed, not measured): if each request runs 1 query → <id> binds at ~N req/s; 3 → ~N; 10 → ~N` followed by the migration note line. When `binding` is null with conditionals present, prefix `varies by assumption:`. When no conditionals: `Weak link: <note>`.
- Section renders ONLY when `report.ceilings` is defined (old reports without the field render exactly as before).

- [ ] **Step 1: Write the failing tests** — extend the existing describe with a fixture report carrying two ceilings (one value w/ `['declared','measured']`, one range w/ `['typical']`), one omitted entry, and a weakLink with 3 conditionals; assert: header present; `at most 2000 queries/s` present; `declared×measured` label present; `cited range, not a measurement` present; `Could not assess: network-egress` present; weak-link line contains all three fan-outs; a report WITHOUT `ceilings` renders no `Capacity ceilings` header. (Write the fixture and assertions as real code in the test file, following the file's existing fixture style.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/__tests__/readiness-cli.test.ts` → FAIL on missing section

- [ ] **Step 3: Implement** in `renderReadinessReport`, appending after the findings loop:

```typescript
  if (report.ceilings) {
    lines.push('');
    lines.push('Capacity ceilings (upper bounds — real capacity is lower):');
    for (const c of report.ceilings) {
      const label = `[${c.evidenceClasses.join('×')}: ${c.evidence.join('; ')}]`;
      if (c.value !== null) {
        lines.push(`  ${c.title}: at most ${c.value} ${c.unit} ${label}`);
      } else {
        lines.push(`  ${c.title}: typically ${c.rangeLow}–${c.rangeHigh} ${c.unit} (cited range, not a measurement) ${label}`);
      }
    }
    for (const o of report.ceilingsOmitted ?? []) {
      lines.push(`  Could not assess: ${o.id} — ${o.reason}`);
    }
    const wl = report.weakLink;
    if (wl) {
      if (wl.conditional.length > 0) {
        const parts = wl.conditional.map((c) => `${c.queriesPerRequest} → ~${c.requestsPerSec} req/s (${c.bindingCeilingId})`);
        const prefix = wl.binding === null ? 'varies by assumption: ' : '';
        lines.push(`Weak link (conditional — fan-out assumed, not measured): ${prefix}queries/request ${parts.join('; ')}`);
        lines.push(`  ${wl.note}`);
      } else {
        lines.push(`Weak link: ${wl.note}`);
      }
    }
  }
```

- [ ] **Step 4: Run tests, smoke, commit**

```bash
pnpm vitest run src/__tests__/readiness-cli.test.ts
npx tsx src/cli/index.ts readiness    # expect ceilings section or honest omissions — never a crash
pnpm run typecheck
git add src/cli/commands/readiness.ts src/__tests__/readiness-cli.test.ts
git commit -m "feat(cli): render capacity ceilings and weak-link in readiness report"
```

---

### Task 8: Docs and gates

**Files:**
- Modify: `README.md` — extend the `crisismode readiness` CLI-reference comment to mention capacity ceilings; in the Evidence-Bundles-adjacent readiness prose (if any) no change; add one sentence to the MCP `crisismode_readiness` row: "includes capacity ceilings and a conditional weak-link verdict".
- Modify: `CLAUDE.md` — extend the `src/readiness/` Key Files row: "rule registry + capacity ceilings/weak-link".
- Modify: `QUICKSTART.md` — no change (per its sample-commands convention).
- No new tests.

- [ ] **Step 1: Make the two doc edits**, matching each file's existing wording style (both files were freshness-audited 2026-07-18 — no collateral rewording).

- [ ] **Step 2: Full verification gates**

```bash
pnpm run typecheck        # clean
pnpm run lint             # clean
pnpm test                 # all pass except the 6 known sandbox-EPERM failures (cli-detect, check-plugin-integration)
pnpm run build && pnpm run build:bundle
grep -rn "computeCeilings\|rankWeakLink\|ceilings" src/framework/evidence-bundle-respond.ts && echo LEAK || echo DISJOINT
# expect DISJOINT — no diagnosis-path change, eval gate does not need a paid re-run (record this in the report)
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: capacity ceilings in readiness command and MCP tool references"
```

---

## Self-Review Notes

- Spec coverage: honesty rules 1-5 → Tasks 1 (caveat/evidence classes/omissions), 2 (conditional conversions, typical exclusion, migration note), 7 (labels always rendered, conditional never unconditional); ceiling inventory rows → db (T1+T3), redis (T1+T4), fd w/ serverless suppression (T1+T6), network declared-only (T1+T5+T6), node typical (T1); kafka correctly absent per amended spec; "ceilings do not affect score" → T6 assertion; MCP `ceilings` field → rides report serialization (T6/T7 note); error-handling contract → omitted-with-reason throughout.
- Adaptation pointers (not placeholders — each names the exact file to mirror): redis INFO/CONFIG helper shapes (T4), loadConfig signature (T5), config accessor threading + redis injection parameter shape (T6), test-fixture reuse (T6/T7 Step 1 prose specs with binding assertion lists).
- Type consistency: `StatementAggregate`/`RedisLimits`/`CapacityCeiling`/`OmittedCeiling`/`CeilingsResult`/`WeakLinkVerdict`/`ConditionalBinding` names and fields match across Tasks 1-7; `evidenceClasses.join('×')` (T7) renders the `['declared','measured']` pair as `declared×measured` per the spec's class notation.
