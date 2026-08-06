# Vector/RAG Layer Implementation Plan (PR 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CrisisMode eyes on the retrieval layer — two pgvector readiness rules on the already-validated PostgreSQL core, plus a small read-only `vector-store` agent covering Pinecone and Upstash Vector.

**Architecture:** Part A extends the readiness pipeline only. `PgLiveClient` gains an optional `getPgvectorInventory()` catalog probe; `src/readiness/run.ts` calls it **once, before rule evaluation**, and puts the result on `ReadinessContext.pgvector`. Two new rules gate on that context field via the existing synchronous `applicable(ctx)` mechanism, which is the only way a rule can be skipped *silently* (a rule returning `status: 'unknown'` still renders in the report). Part B adds `src/agent/vector-store/` following the standard agent pattern (backend interface → simulator → live client → manifest → agent → registration), using raw `fetch` against provider REST endpoints.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `pg` (already a dependency), raw `fetch` (Node 20 global). **Zero new dependencies.**

## Global Constraints

- **TypeScript strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** (`tsconfig.base.json`). Never assign `undefined` to an optional property — omit the key entirely (see the `...(cond ? { key } : {})` spread pattern already used in `src/readiness/run.ts:224-235`).
- **ESM / NodeNext:** every relative import ends in `.js`, including type-only imports. Use `import type { ... }` for type-only imports (`verbatimModuleSyntax` is on).
- **No default exports.** Named exports only.
- **Zero new runtime dependencies.** No provider SDKs — raw `fetch` against REST endpoints. This protects the 256Mi spoke memory target.
- **`process.env` only.** No `.env` file parsing (explicit non-goal of the series).
- **Key material never appears in output, logs, plans, or forensics.** Credentials are referenced by provider name plus a last-4 fingerprint only.
- **Readiness honesty contract** (`docs/readiness.md`): thresholds appear verbatim in finding output; row counts are labelled "(estimated)"; a rule that cannot evaluate returns `status: 'unknown'` with a non-empty `reason` — never a guessed status, never a throw. Unknown findings move neither score nor verdict.
- **Every threshold gets exact-boundary tests** — one test at the boundary value and one on the other side, pinning comparison inclusivity (`docs/readiness.md` "Two conventions are load-bearing").
- **No mutation anywhere in this PR.** Both new readiness rules and the whole `vector-store` agent are read-only; escalation level is Diagnose (2) at most. Index creation is *guidance text only*.
- **Maturity claims must match what was actually validated live.** The `vector-store` manifest ships `maturity: 'simulator_only'` and is only promoted to `'live_validated'` in Task 10 if live validation against a real account actually passes.
- **Inherited from PR 1 (merged):** `metadata.plugin.maturity` on every agent manifest drives the scan visibility buckets. A new agent must declare it.
- **Inherited from PR 3 (merged) — reuse, never reimplement.** Three things come from `llm-provider` and are *imported*, not copied. A second copy is how two masking rules or two offline gates drift apart, and only one of them stays honest:
  - `fingerprintKey(key: string): string` (`src/agent/llm-provider/provider-table.js`) — `'…' + last 4` (U+2026), or `'(key too short to fingerprint)'` for keys under 8 characters. The **only** permitted rendering of a credential.
  - `OfflineGate`, `ObserverOffline`, `defaultOfflineGate` (`src/agent/llm-provider/offline-gate.js`) — reads PR 2's **cached** `getTriageReport()`; defers only on a `local`/`network` verdict; never calls `runTriage()`.
  - `checkId` on findings, **including** the finding-level `ScanFinding.checkId` derived by `dominantCheckId`. Task 7 Step 1 verifies and adds if missing.
- **Check ids are a keyed `as const` object**, matching PR 3's `LLM_PROVIDER_CHECK_IDS`: `VECTOR_STORE_CHECK_IDS.{reachable,authValid,indexStatus}`. PR 5's guidance registry enumerates them with `Object.values()`.
- **Offline is decided once, on the agent.** Backends have no offline concept — no `getNetworkProfile()` check, no `offline` simulator scenario. PR 3 rejects the network-profile signal explicitly because it cannot tell "this machine" from "this network", which is the distinction the deferral exists to report.
- **Network timeouts ≤ 1500ms.** Scan races `assessHealth` against a 2000ms per-agent budget, and a timed-out assessment returns a signal-less `unknown` — discarding every `checkId` PR 5 anchors guidance to.
- **Commands:** `pnpm vitest run src/__tests__/<file>.test.ts` for one file, `pnpm test` for all, `pnpm run typecheck`, `pnpm run lint`.
- **Commits:** Conventional Commits. Scope `readiness` for Part A, `vector-store` for Part B. Commit at the end of every task. **Do not create branches** — work on the current branch.
- **Every new source file starts with the two-line license header** used everywhere in this repo:
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```

---

## File Structure

**Part A — pgvector on the readiness surface**

| File | Responsibility |
|---|---|
| `src/readiness/types.ts` (modify) | `PgvectorTable`, `PgvectorIndex`, `PgvectorInventory`; `ReadinessSources.getPgvectorInventory?`; `ReadinessContext.pgvector?` |
| `src/agent/pg-replication/pgvector-catalog.ts` (create) | The three catalog SQL statements + pure row→inventory mapping + `lists` reloption parsing. Pure, so it is unit-testable without a database. |
| `src/agent/pg-replication/backend.ts` (modify) | Optional `getPgvectorInventory()` on `PgBackend` |
| `src/agent/pg-replication/live-client.ts` (modify) | Runs the catalog SQL under the existing read-only pool, null-on-error |
| `src/agent/pg-replication/simulator.ts` (modify) | `setPgvectorInventory()` fixture setter, defaults to `'absent'` |
| `src/readiness/rules/vector-index-missing.ts` (create) | Rule 1 |
| `src/readiness/rules/ivfflat-lists-mismatch.ts` (create) | Rule 2 |
| `src/readiness/rules/index.ts` (modify) | Register both rules |
| `src/readiness/run.ts` (modify) | Fetch the inventory once and place it on the context before `runRules` |

**Part B — the `vector-store` agent**

| File | Responsibility |
|---|---|
| `src/agent/vector-store/provider-table.ts` (create) | Per-provider static config; source of truth for vector-store env vars. Credential masking is imported from PR 3, not redefined here. |
| `src/agent/vector-store/check-ids.ts` (create) | `VECTOR_STORE_CHECK_IDS` keyed `as const` object + `VectorStoreCheckId`; dependency-free so PR 5 can import it alone |
| `src/agent/vector-store/backend.ts` (create) | `VectorStoreBackend` interface + report/check/index types |
| `src/agent/vector-store/simulator.ts` (create) | In-memory scenarios |
| `src/agent/vector-store/live-client.ts` (create) | `fetch`-based probes for Pinecone and Upstash Vector |
| `src/agent/vector-store/manifest.ts` (create) | `kind: 'vector-store'`, `maxRiskLevel: 'routine'` |
| `src/agent/vector-store/agent.ts` (create) | `RecoveryAgent` implementation |
| `src/agent/vector-store/registration.ts` (create) | Lazy factory via `createLiveRegistration` |
| `src/config/builtin-agents.ts` (modify) | Register the agent |
| `src/framework/capability-registry.ts` (modify) | Register `vectorstore.index.read` |
| `src/framework/signal-explanations.ts` (modify) | `/^vector_store_/` knowledge-map entry — required by `explanation-coverage.test.ts` |
| `src/__tests__/explanation-coverage.test.ts` (modify) | `REPRESENTATIVE_SOURCES['vector-store']` — the test iterates `builtinAgents`, so registering without this fails it |
| `src/cli/autodiscovery.ts` (modify) | Derive a `vector-store` target from env keys |

**Fixtures, tests, docs**

| File | Responsibility |
|---|---|
| `test/podman/compose.yaml` (modify) | Add a `pg-vector` service (pgvector image) on host port 5434 |
| `test/failures/inject-pgvector-unindexed.sh` (create) | Seed an unindexed 100k-row vector table + a badly-tuned ivfflat index |
| `test/failures/reset-pgvector.sh` (create) | Drop the fixture tables |
| `src/__tests__/readiness-pgvector-inventory.test.ts` (create) | Catalog parsing/mapping + simulator fixture |
| `src/__tests__/readiness-vector-rules.test.ts` (create) | Both rules, all statuses, exact boundaries |
| `src/__tests__/readiness-run.test.ts` (modify) | Runner wiring + rule-registry roster |
| `src/__tests__/vector-store-provider-table.test.ts` (create) | Connection building + fingerprinting |
| `src/__tests__/vector-store-simulator.test.ts` (create) | Simulator scenarios |
| `src/__tests__/vector-store-live-client.test.ts` (create) | Mocked-`fetch` request shape, status classification, timeout budget, no-key-leak |
| `src/__tests__/vector-store-agent.test.ts` (create) | Health mapping, diagnosis, plan, harness validation |
| `src/__tests__/autodiscovery-vector-store.test.ts` (create) | Env detection derives the target |
| `docs/readiness.md` (modify) | Eight rules; pgvector section |
| `CLAUDE.md` (modify) | Key-files table entry for the new agent |

---

## Task 1: pgvector catalog probe (types, SQL, live client, simulator)

**Files:**
- Modify: `src/readiness/types.ts`
- Create: `src/agent/pg-replication/pgvector-catalog.ts`
- Modify: `src/agent/pg-replication/backend.ts:51-96`
- Modify: `src/agent/pg-replication/live-client.ts:248-261` (add after `queryStatementAggregate`)
- Modify: `src/agent/pg-replication/simulator.ts:22-84`
- Test: `src/__tests__/readiness-pgvector-inventory.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Current shapes it mirrors: `TableStat`/`StatementStat` already live in `src/readiness/types.ts` and are imported by `src/agent/pg-replication/backend.ts:5` — the new pgvector types follow that same direction.
- Produces:
  - `PgvectorTable { schema: string; table: string; column: string; rowEstimate: number | null }`
  - `PgvectorIndex { schema: string; indexName: string; table: string; column: string | null; accessMethod: 'ivfflat' | 'hnsw'; lists: number | null }`
  - `PgvectorInventory { extensionVersion: string; tables: PgvectorTable[]; indexes: PgvectorIndex[] }`
  - `ReadinessSources.getPgvectorInventory?(): Promise<PgvectorInventory | 'absent' | null>`
  - `ReadinessContext.pgvector?: PgvectorInventory | 'absent' | null | undefined`
  - `parseIvfflatLists(reloptions: string[] | null): number | null`
  - `buildPgvectorInventory(extensionVersion: string, tableRows: PgvectorTableRow[], indexRows: PgvectorIndexRow[]): PgvectorInventory`
  - `PgSimulator.setPgvectorInventory(inventory: PgvectorInventory | 'absent' | null): void`

- [ ] **Step 1: Add the pgvector types to `src/readiness/types.ts`**

Insert after the `StatementStat` interface (currently ends at line 46), before `export type EvidenceClass`:

```typescript
/** One table column typed `vector` (pgvector), with the planner's row estimate. */
export interface PgvectorTable {
  /** Schema (pg_namespace.nspname). Same-named tables in different schemas are distinct. */
  schema: string;
  table: string;
  column: string;
  /**
   * pg_class.reltuples — an ESTIMATE maintained by ANALYZE/autovacuum.
   * null when PostgreSQL has no estimate yet (reltuples = -1, never analyzed);
   * the vector rules report that as unknown rather than assuming zero rows.
   */
  rowEstimate: number | null;
}

/** One approximate-nearest-neighbour index (ivfflat or hnsw) on a vector column. */
export interface PgvectorIndex {
  /** Schema (pg_namespace.nspname) of the indexed table. Must match the table's schema to count as coverage. */
  schema: string;
  indexName: string;
  table: string;
  /** First indexed column; null when the index is built on an expression. */
  column: string | null;
  accessMethod: 'ivfflat' | 'hnsw';
  /**
   * ivfflat `lists` read from pg_class.reloptions. null when the index was
   * created without an explicit `WITH (lists = ...)` — pgvector's built-in
   * default is deliberately NOT substituted (omit, never fabricate).
   */
  lists: number | null;
}

/** Read-only snapshot of the pgvector catalog on one database. */
export interface PgvectorInventory {
  extensionVersion: string;
  tables: PgvectorTable[];
  indexes: PgvectorIndex[];
}
```

Add to `ReadinessSources` (after `declaredEgressMbps?`, line 99):

```typescript
  /**
   * pgvector catalog inventory. Three-way return keeps the causes distinct:
   * an inventory (extension installed), 'absent' (confirmed not installed —
   * the vector rules skip silently), null (the catalog read failed — the
   * vector rules run and report 'unknown').
   */
  getPgvectorInventory?(): Promise<PgvectorInventory | 'absent' | null>;
```

Add to `ReadinessContext` (after `target?`, line 107):

```typescript
  /**
   * pgvector inventory, fetched ONCE by the runner before rule evaluation.
   * `applicable(ctx)` is synchronous and cannot query the database, and it is
   * the only mechanism that skips a rule silently — a rule returning
   * status 'unknown' still renders in the report. undefined ⇒ no source at
   * all (non-PG path); 'absent' ⇒ extension not installed; null ⇒ read failed.
   */
  pgvector?: PgvectorInventory | 'absent' | null | undefined;
```

- [ ] **Step 2: Write the failing test for the catalog mapping**

Create `src/__tests__/readiness-pgvector-inventory.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import {
  parseIvfflatLists,
  buildPgvectorInventory,
} from '../agent/pg-replication/pgvector-catalog.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('parseIvfflatLists', () => {
  it('reads lists from reloptions', () => {
    expect(parseIvfflatLists(['lists=100'])).toBe(100);
  });
  it('reads lists when other reloptions are present', () => {
    expect(parseIvfflatLists(['fillfactor=90', 'lists=316'])).toBe(316);
  });
  it('returns null when reloptions are absent (never assume pgvector defaults)', () => {
    expect(parseIvfflatLists(null)).toBeNull();
  });
  it('returns null when lists was not set explicitly', () => {
    expect(parseIvfflatLists(['fillfactor=90'])).toBeNull();
  });
});

describe('buildPgvectorInventory', () => {
  it('maps table rows and preserves the estimate', () => {
    const inv = buildPgvectorInventory(
      '0.7.0',
      [{ schema_name: 'public', table_name: 'documents', column_name: 'embedding', row_estimate: 100_000 }],
      [],
    );
    expect(inv.extensionVersion).toBe('0.7.0');
    expect(inv.tables).toEqual([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }]);
  });

  it('maps reltuples = -1 (never analyzed) to a null estimate, not zero', () => {
    const inv = buildPgvectorInventory(
      '0.7.0',
      [{ schema_name: 'public', table_name: 'documents', column_name: 'embedding', row_estimate: -1 }],
      [],
    );
    expect(inv.tables[0]?.rowEstimate).toBeNull();
  });

  it('maps ivfflat indexes with their lists value', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'documents_embedding_idx', table_name: 'documents',
        access_method: 'ivfflat', column_name: 'embedding', reloptions: ['lists=100'],
      },
    ]);
    expect(inv.indexes).toEqual([{
      schema: 'public', indexName: 'documents_embedding_idx', table: 'documents',
      column: 'embedding', accessMethod: 'ivfflat', lists: 100,
    }]);
  });

  it('maps hnsw indexes with a null lists value (no equivalent tuning knob)', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'chunks_embedding_idx', table_name: 'chunks',
        access_method: 'hnsw', column_name: 'embedding', reloptions: ['m=16'],
      },
    ]);
    expect(inv.indexes[0]?.accessMethod).toBe('hnsw');
    expect(inv.indexes[0]?.lists).toBeNull();
  });

  it('drops index rows with an unrecognised access method', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'documents_pkey', table_name: 'documents',
        access_method: 'btree', column_name: 'id', reloptions: null,
      },
    ]);
    expect(inv.indexes).toEqual([]);
  });
});

describe('PgSimulator pgvector fixture', () => {
  it("defaults to 'absent' (the common case: a database with no pgvector)", async () => {
    expect(await new PgSimulator().getPgvectorInventory()).toBe('absent');
  });

  it('returns the configured inventory', async () => {
    const sim = new PgSimulator();
    sim.setPgvectorInventory({
      extensionVersion: '0.7.0',
      tables: [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 50_000 }],
      indexes: [],
    });
    const inv = await sim.getPgvectorInventory();
    expect(inv).not.toBe('absent');
    expect(inv).not.toBeNull();
    expect(typeof inv === 'object' && inv?.tables[0]?.table).toBe('documents');
  });

  it('can simulate a failed catalog read', async () => {
    const sim = new PgSimulator();
    sim.setPgvectorInventory(null);
    expect(await sim.getPgvectorInventory()).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-pgvector-inventory.test.ts`
Expected: FAIL — cannot resolve `../agent/pg-replication/pgvector-catalog.js`.

- [ ] **Step 4: Create `src/agent/pg-replication/pgvector-catalog.ts`**

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * pgvector catalog probe: the read-only SQL plus the pure row→inventory
 * mapping. Kept out of PgLiveClient so the mapping and the reloption parsing
 * are unit-testable without a database.
 */

import type { PgvectorIndex, PgvectorInventory, PgvectorTable } from '../../readiness/types.js';

/** Is the `vector` extension installed, and at what version? */
export const PGVECTOR_EXTENSION_SQL = `
  SELECT extversion FROM pg_extension WHERE extname = 'vector'
`;

/** Every user-table column typed `vector`, with the planner's row estimate. */
export const PGVECTOR_TABLES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname AS column_name,
         c.reltuples::float8 AS row_estimate
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE t.typname = 'vector'
    -- relkind = 'r' is ordinary tables only. Partitioned parents ('p') are a
    -- known v1 gap: their reltuples is 0 and the vector column lives on the
    -- children, so including them would report a phantom empty table. Under
    -- the honesty contract a partitioned vector table is invisible to these
    -- rules rather than misreported.
    AND c.relkind = 'r'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY n.nspname, c.relname, a.attname
`;

/**
 * Every ivfflat/hnsw index, with its first indexed column and its reloptions.
 * Restricted to indexes that are actually usable for a query planner right
 * now: `indisvalid`/`indisready` excludes an index stuck mid-CREATE INDEX
 * CONCURRENTLY (or invalidated by a failed build), and `indpred IS NULL`
 * excludes partial indexes — a predicate index only covers a subset of rows,
 * so treating it as full coverage of the column would be a false "ready".
 */
export const PGVECTOR_INDEXES_SQL = `
  SELECT n.nspname AS schema_name,
         ic.relname AS index_name,
         tc.relname AS table_name,
         am.amname AS access_method,
         a.attname AS column_name,
         ic.reloptions AS reloptions
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = i.indkey[0]
  WHERE am.amname IN ('ivfflat', 'hnsw')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND i.indisvalid
    AND i.indisready
    AND i.indpred IS NULL
  ORDER BY n.nspname, ic.relname
`;

export interface PgvectorTableRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  row_estimate: number;
}

export interface PgvectorIndexRow {
  schema_name: string;
  index_name: string;
  table_name: string;
  access_method: string;
  column_name: string | null;
  reloptions: string[] | null;
}

/**
 * `lists` from an index's pg_class.reloptions (e.g. `['lists=100']`). Returns
 * null when the option was never set explicitly: pgvector's built-in default
 * is not substituted, because an unstated value is unknown, not assumed.
 */
export function parseIvfflatLists(reloptions: string[] | null): number | null {
  if (!reloptions) return null;
  for (const option of reloptions) {
    const match = /^lists=(\d+)$/.exec(option.trim());
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

function isVectorAccessMethod(name: string): name is PgvectorIndex['accessMethod'] {
  return name === 'ivfflat' || name === 'hnsw';
}

export function buildPgvectorInventory(
  extensionVersion: string,
  tableRows: PgvectorTableRow[],
  indexRows: PgvectorIndexRow[],
): PgvectorInventory {
  const tables: PgvectorTable[] = tableRows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.column_name,
    // PostgreSQL 14+ uses reltuples = -1 for "never analyzed" — that is an
    // absence of information, not a row count of zero.
    rowEstimate: row.row_estimate < 0 ? null : row.row_estimate,
  }));

  const indexes: PgvectorIndex[] = [];
  for (const row of indexRows) {
    if (!isVectorAccessMethod(row.access_method)) continue;
    indexes.push({
      schema: row.schema_name,
      indexName: row.index_name,
      table: row.table_name,
      column: row.column_name,
      accessMethod: row.access_method,
      lists: row.access_method === 'ivfflat' ? parseIvfflatLists(row.reloptions) : null,
    });
  }

  return { extensionVersion, tables, indexes };
}
```

- [ ] **Step 5: Add the optional method to `PgBackend`**

In `src/agent/pg-replication/backend.ts`, change the type import on line 5 to include the inventory type:

```typescript
import type { TableStat, StatementStat, StatementAggregate, PgvectorInventory } from '../../readiness/types.js';
```

and add this member after `queryStatementAggregate?()` (line 92), before `transition`:

```typescript
  /**
   * pgvector catalog inventory (readiness: vector rules). Optional so
   * simulators and non-PG backends are unaffected. 'absent' means the
   * extension is confirmed not installed; null means the read failed.
   */
  getPgvectorInventory?(): Promise<PgvectorInventory | 'absent' | null>;
```

- [ ] **Step 6: Implement it on `PgLiveClient`**

In `src/agent/pg-replication/live-client.ts`, extend the readiness type import on line 16:

```typescript
import type { TableStat, StatementStat, StatementAggregate, PgvectorInventory } from '../../readiness/types.js';
```

and add a new import below it:

```typescript
import {
  PGVECTOR_EXTENSION_SQL, PGVECTOR_TABLES_SQL, PGVECTOR_INDEXES_SQL,
  buildPgvectorInventory,
  type PgvectorTableRow, type PgvectorIndexRow,
} from './pgvector-catalog.js';
```

Add this method directly after `queryStatementAggregate()` (which ends at line 261):

```typescript
  /**
   * pgvector catalog inventory — feeds the readiness vector rules. Read-only,
   * on the existing primary pool. Returns 'absent' when the extension is not
   * installed (a definite answer, so the rules can skip silently) and null on
   * any query failure, per this client's null-on-error convention — the rules
   * turn that into an honest 'unknown' finding.
   */
  async getPgvectorInventory(): Promise<PgvectorInventory | 'absent' | null> {
    try {
      const extension = await this.primaryPool.query<{ extversion: string }>(PGVECTOR_EXTENSION_SQL);
      const version = extension.rows[0]?.extversion;
      if (version === undefined) return 'absent';

      const [tables, indexes] = await Promise.all([
        this.primaryPool.query<PgvectorTableRow>(PGVECTOR_TABLES_SQL),
        this.primaryPool.query<PgvectorIndexRow>(PGVECTOR_INDEXES_SQL),
      ]);
      return buildPgvectorInventory(version, tables.rows, indexes.rows);
    } catch {
      return null; // connection or permission failure — rules report unknown
    }
  }
```

- [ ] **Step 7: Add the simulator fixture**

In `src/agent/pg-replication/simulator.ts`, extend the readiness type import to include `PgvectorInventory` (it already imports `TableStat`, `StatementStat`, `StatementAggregate` from `../../readiness/types.js`), then add a field after `private statementAggregate` (line 24):

```typescript
  private pgvectorInventory: PgvectorInventory | 'absent' | null = 'absent';
```

and these members after `setStatementAggregate` / `queryStatementAggregate` (lines 74 and 84):

```typescript
  /**
   * Configure the pgvector fixture. 'absent' (the default) simulates a
   * database without the extension; null simulates a failed catalog read.
   */
  setPgvectorInventory(inventory: PgvectorInventory | 'absent' | null): void {
    this.pgvectorInventory = inventory;
  }

  async getPgvectorInventory(): Promise<PgvectorInventory | 'absent' | null> {
    return this.pgvectorInventory;
  }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/readiness-pgvector-inventory.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add src/readiness/types.ts src/agent/pg-replication/pgvector-catalog.ts \
  src/agent/pg-replication/backend.ts src/agent/pg-replication/live-client.ts \
  src/agent/pg-replication/simulator.ts src/__tests__/readiness-pgvector-inventory.test.ts
git commit -m "feat(readiness): add read-only pgvector catalog inventory probe"
```

---

## Task 2: `vector-index-missing` readiness rule

**Files:**
- Create: `src/readiness/rules/vector-index-missing.ts`
- Modify: `src/readiness/rules/index.ts`
- Test: `src/__tests__/readiness-vector-rules.test.ts`
- Modify: `src/__tests__/readiness-run.test.ts:62-67` (the rule-roster test)

**Interfaces:**
- Consumes (from Task 1): `ReadinessContext.pgvector?: PgvectorInventory | 'absent' | null | undefined`, and the types `PgvectorInventory { extensionVersion: string; tables: PgvectorTable[]; indexes: PgvectorIndex[] }`, `PgvectorTable { schema: string; table: string; column: string; rowEstimate: number | null }`, `PgvectorIndex { schema: string; indexName: string; table: string; column: string | null; accessMethod: 'ivfflat' | 'hnsw'; lists: number | null }`.
- Produces:
  - `vectorIndexMissingRule: ReadinessRule` with `id: 'vector-index-missing'`
  - `VECTOR_MIN_ROWS = 10_000` (exported; Task 3 imports it)
  - `PGVECTOR_UNREADABLE_REASON = 'could not read pgvector catalog (connection or permission issue)'` (exported; Task 3 imports it)
  - `vectorRuleApplicable(ctx: ReadinessContext): boolean` (exported; Task 3 imports it)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/readiness-vector-rules.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { vectorIndexMissingRule, VECTOR_MIN_ROWS } from '../readiness/rules/vector-index-missing.js';
import type {
  PgvectorIndex, PgvectorInventory, PgvectorTable, ReadinessContext, ReadinessSources,
} from '../readiness/types.js';

/** Rules read pgvector from the context; the sources surface is unused by them. */
const sources: ReadinessSources = {
  connectionUsage: async () => null,
  tableStats: async () => null,
  statementStats: async () => null,
};

function ctxWith(pgvector: PgvectorInventory | 'absent' | null | undefined): ReadinessContext {
  const base = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;
  return pgvector === undefined ? base : { ...base, pgvector };
}

function inventory(tables: PgvectorTable[], indexes: PgvectorIndex[] = []): PgvectorInventory {
  return { extensionVersion: '0.7.0', tables, indexes };
}

const hnswOn = (table: string, column: string): PgvectorIndex => ({
  schema: 'public', indexName: `${table}_${column}_idx`, table, column, accessMethod: 'hnsw', lists: null,
});

describe('vectorIndexMissingRule applicability', () => {
  it('is not applicable when no pgvector source exists at all', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(undefined))).toBe(false);
  });
  it("is not applicable when the extension is absent (silent skip)", () => {
    expect(vectorIndexMissingRule.applicable(ctxWith('absent'))).toBe(false);
  });
  it('IS applicable when the catalog read failed, so it can report unknown', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(null))).toBe(true);
  });
  it('is applicable when an inventory is present', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(inventory([])))).toBe(true);
  });
  it('is not applicable without a postgres target', () => {
    const noTarget = { serverless: false, pgvector: inventory([]) } as ReadinessContext;
    expect(vectorIndexMissingRule.applicable(noTarget)).toBe(false);
  });
});

describe('vectorIndexMissingRule evaluation', () => {
  it('flags a large unindexed vector column', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('documents.embedding');
    expect(f.evidence.join(' ')).toContain('(estimated)');
    expect(f.evidence.join(' ')).toContain('10,000');
  });

  it('is ready when an hnsw index covers the column', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [hnswOn('documents', 'embedding')],
    )));
    expect(f.status).toBe('ready');
  });

  it('is ready when an ivfflat index covers the column', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [{ schema: 'public', indexName: 'i', table: 'documents', column: 'embedding', accessMethod: 'ivfflat', lists: 316 }],
    )));
    expect(f.status).toBe('ready');
  });

  it('flags when the index is on a different column of the same table', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [hnswOn('documents', 'title_embedding')],
    )));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: flags at exactly VECTOR_MIN_ROWS', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 't', column: 'e', rowEstimate: VECTOR_MIN_ROWS }])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready just below VECTOR_MIN_ROWS', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 't', column: 'e', rowEstimate: VECTOR_MIN_ROWS - 1 }])));
    expect(f.status).toBe('ready');
  });

  it('reports unknown with the generic reason when the catalog read failed', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(null));
    expect(f.status).toBe('unknown');
    expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
  });

  it('reports unknown when the only vector table has never been analyzed', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: null }])));
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('ANALYZE');
  });

  it('an unanalyzed table does not mask a real offender', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory([
      { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 },
      { schema: 'public', table: 'chunks', column: 'embedding', rowEstimate: null },
    ])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('chunks.embedding');
  });

  it('is ready with no vector tables at all', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory([])));
    expect(f.status).toBe('ready');
  });

  it('recommends HNSW and the EXPLAIN caveat', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }])));
    expect(f.fix).toContain('hnsw');
    expect(f.fix).toContain('EXPLAIN');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-vector-rules.test.ts`
Expected: FAIL — cannot resolve `../readiness/rules/vector-index-missing.js`.

- [ ] **Step 3: Implement the rule**

Create `src/readiness/rules/vector-index-missing.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgvectorIndex, PgvectorTable, ReadinessContext, ReadinessRule } from '../types.js';

/**
 * Below ~10k vectors an exhaustive scan is fast enough — do not nag about a
 * demo-sized table. Same threshold as the missing-index rule, for the same
 * reason: cost grows with data, not with traffic.
 */
export const VECTOR_MIN_ROWS = 10_000;

/**
 * The PG live client's convention is null-on-any-error without classification,
 * so the reason cannot promise precise permission detection.
 */
export const PGVECTOR_UNREADABLE_REASON =
  'could not read pgvector catalog (connection or permission issue)';

/**
 * Shared gate for the vector rules. Returns false when there is no pgvector
 * source at all, or when the extension is confirmed absent — both are silent
 * skips (no finding is produced), which is the only way the framework can stay
 * quiet on a non-pgvector database. A failed read (null) IS applicable so the
 * rule can report an honest 'unknown'.
 */
export function vectorRuleApplicable(ctx: ReadinessContext): boolean {
  return ctx.target !== undefined && ctx.pgvector !== undefined && ctx.pgvector !== 'absent';
}

/** A table whose row estimate PostgreSQL actually has. */
type SizedTable = PgvectorTable & { rowEstimate: number };

function isSized(table: PgvectorTable): table is SizedTable {
  return table.rowEstimate !== null;
}

/** Does this index provide approximate search for that schema/table/column? */
export function coversColumn(index: PgvectorIndex, table: PgvectorTable): boolean {
  return index.schema === table.schema && index.table === table.table && index.column === table.column;
}

function unanalyzedEvidence(table: PgvectorTable): string {
  return `${table.table}.${table.column}: row estimate unavailable (never analyzed — run ANALYZE ${table.table})`;
}

export const vectorIndexMissingRule: ReadinessRule = {
  id: 'vector-index-missing',
  title: 'Vector columns without an approximate index',
  applicable: vectorRuleApplicable,
  async evaluate(_sources, ctx) {
    const threshold = VECTOR_MIN_ROWS.toLocaleString('en-US');
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'Without an ivfflat or hnsw index, every similarity search reads and scores every row in the table. ' +
        'That is instant on a demo-sized table and an outage once real documents arrive — the cost grows with ' +
        'your data even if traffic stays flat.',
      fix:
        'Create an hnsw index on the vector column — for example ' +
        'CREATE INDEX ON <table> USING hnsw (<column> vector_cosine_ops). Match the operator class to the ' +
        'distance function your queries actually use, then confirm with EXPLAIN that the index is being used.',
      learnMoreUrl: 'https://github.com/pgvector/pgvector#indexing',
    };

    const inventory = ctx.pgvector;
    if (inventory === undefined || inventory === 'absent' || inventory === null) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: PGVECTOR_UNREADABLE_REASON };
    }

    const unanalyzed = inventory.tables.filter((t) => !isSized(t));
    const sized = inventory.tables.filter(isSized);
    const large = sized.filter((t) => t.rowEstimate >= VECTOR_MIN_ROWS);
    const offenders = large.filter((t) => !inventory.indexes.some((i) => coversColumn(i, t)));

    if (offenders.length > 0) {
      return {
        ...base,
        status: 'at_risk' as const,
        evidence: [
          ...offenders.map(
            (t) =>
              `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
              `no ivfflat or hnsw index — threshold is ${threshold} rows`,
          ),
          ...unanalyzed.map(unanalyzedEvidence),
        ],
      };
    }

    if (unanalyzed.length > 0) {
      return {
        ...base,
        status: 'unknown' as const,
        evidence: unanalyzed.map(unanalyzedEvidence),
        reason:
          `PostgreSQL has no row estimate yet for ${unanalyzed.map((t) => t.table).join(', ')} ` +
          '(never analyzed) — run ANALYZE and re-run readiness',
      };
    }

    return {
      ...base,
      status: 'ready' as const,
      evidence: sized.map((t) => {
        const covering = inventory.indexes.find((i) => coversColumn(i, t));
        if (covering) {
          return `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
            `indexed by ${covering.indexName} (${covering.accessMethod})`;
        }
        return `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
          `below the ${threshold}-row threshold`;
      }),
    };
  },
};
```

- [ ] **Step 4: Register the rule**

In `src/readiness/rules/index.ts`, add the import and the array entry:

```typescript
import { vectorIndexMissingRule } from './vector-index-missing.js';
```

```typescript
export const allRules: ReadinessRule[] = [
  connectionHeadroomRule,
  connectionLimitTierRule,
  longTransactionsRule,
  missingIndexRule,
  slowQueriesRule,
  serverlessPoolingRule,
  vectorIndexMissingRule,
];
```

- [ ] **Step 5: Update the rule-roster test**

In `src/__tests__/readiness-run.test.ts`, replace the `'registry contains the six v1 rules'` test (lines 62-67) with:

```typescript
  it('registry contains the seven rules', () => {
    expect(allRules.map((r) => r.id).sort()).toEqual([
      'connection-headroom', 'connection-limit-tier', 'long-transactions',
      'missing-index', 'serverless-pooling', 'slow-queries', 'vector-index-missing',
    ]);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-vector-rules.test.ts src/__tests__/readiness-run.test.ts`
Expected: PASS. The existing `readiness-run.test.ts` cases still pass because their fake clients have no `getPgvectorInventory`, so `ctx.pgvector` stays `undefined` and the new rule is skipped.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/readiness/rules/vector-index-missing.ts src/readiness/rules/index.ts \
  src/__tests__/readiness-vector-rules.test.ts src/__tests__/readiness-run.test.ts
git commit -m "feat(readiness): add vector-index-missing rule for unindexed pgvector columns"
```

---

## Task 3: `ivfflat-lists-mismatch` readiness rule

**Files:**
- Create: `src/readiness/rules/ivfflat-lists-mismatch.ts`
- Modify: `src/readiness/rules/index.ts`
- Modify: `src/__tests__/readiness-vector-rules.test.ts` (append a describe block)
- Modify: `src/__tests__/readiness-run.test.ts` (rule roster → eight)

**Interfaces:**
- Consumes (from Task 2): `VECTOR_MIN_ROWS`, `PGVECTOR_UNREADABLE_REASON`, `vectorRuleApplicable(ctx)` — all exported from `../readiness/rules/vector-index-missing.js`.
- Produces:
  - `ivfflatListsMismatchRule: ReadinessRule` with `id: 'ivfflat-lists-mismatch'`
  - `LISTS_TOLERANCE_FACTOR = 4`
  - `idealLists(rowEstimate: number): number` (returns `Math.sqrt(rowEstimate)`)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/readiness-vector-rules.test.ts` (the `sources`, `ctxWith`, and `inventory` helpers from Task 2 are reused, and the import block gains the new rule):

```typescript
import {
  ivfflatListsMismatchRule, LISTS_TOLERANCE_FACTOR, idealLists,
} from '../readiness/rules/ivfflat-lists-mismatch.js';

const ivfflatOn = (table: string, lists: number | null): PgvectorIndex => ({
  schema: 'public', indexName: `${table}_embedding_idx`, table, column: 'embedding', accessMethod: 'ivfflat', lists,
});

describe('idealLists', () => {
  it('is the square root of the row estimate', () => {
    expect(idealLists(100_000)).toBeCloseTo(316.227, 3);
  });
});

describe('ivfflatListsMismatchRule', () => {
  // 10,000 rows ⇒ sqrt = 100 ⇒ accepted band is 25..400 at a 4x tolerance.
  const tenKTable: PgvectorTable = { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 10_000 };

  it('shares the vector-rule applicability gate', () => {
    expect(ivfflatListsMismatchRule.applicable(ctxWith('absent'))).toBe(false);
    expect(ivfflatListsMismatchRule.applicable(ctxWith(undefined))).toBe(false);
    expect(ivfflatListsMismatchRule.applicable(ctxWith(null))).toBe(true);
  });

  it('flags lists far below the sqrt(rows) heuristic', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 4)])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('lists = 4');
    expect(f.evidence.join(' ')).toContain('100');
  });

  it('flags lists far above the sqrt(rows) heuristic', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 5_000)])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready at exactly 4x the ideal (400 for 10,000 rows)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 400)])));
    expect(f.status).toBe('ready');
  });

  it('boundary: at_risk just above 4x the ideal (401)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 401)])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready at exactly ideal/4 (25 for 10,000 rows)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 25)])));
    expect(f.status).toBe('ready');
  });

  it('boundary: at_risk just below ideal/4 (24)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 24)])));
    expect(f.status).toBe('at_risk');
  });

  it('ignores ivfflat indexes on tables below the row threshold', async () => {
    const small: PgvectorTable = { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 9_999 };
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([small], [ivfflatOn('documents', 4)])));
    expect(f.status).toBe('ready');
  });

  it('exempts hnsw indexes — there is no equivalent tuning invariant to check', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory([tenKTable], [
      { schema: 'public', indexName: 'h', table: 'documents', column: 'embedding', accessMethod: 'hnsw', lists: null },
    ])));
    expect(f.status).toBe('ready');
    expect(f.evidence.join(' ')).toContain('hnsw');
  });

  it('reports unknown when an ivfflat index does not record its lists value', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', null)])));
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('lists');
  });

  it('a real mismatch outranks an unreadable sibling index', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory(
      [tenKTable, { schema: 'public', table: 'chunks', column: 'embedding', rowEstimate: 10_000 }],
      [ivfflatOn('documents', null), ivfflatOn('chunks', 4)],
    )));
    expect(f.status).toBe('at_risk');
  });

  it('reports unknown with the generic reason when the catalog read failed', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(null));
    expect(f.status).toBe('unknown');
    expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
  });

  it('is ready when there are no ivfflat indexes at all', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory([tenKTable])));
    expect(f.status).toBe('ready');
  });

  it('exposes the tolerance factor used in its evidence', () => {
    expect(LISTS_TOLERANCE_FACTOR).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-vector-rules.test.ts`
Expected: FAIL — cannot resolve `../readiness/rules/ivfflat-lists-mismatch.js`.

- [ ] **Step 3: Implement the rule**

Create `src/readiness/rules/ivfflat-lists-mismatch.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgvectorIndex, ReadinessRule } from '../types.js';
import {
  PGVECTOR_UNREADABLE_REASON, VECTOR_MIN_ROWS, vectorRuleApplicable,
} from './vector-index-missing.js';

/**
 * How far `lists` may stray from sqrt(rows) before it is worth reporting.
 * The heuristic is a starting point, not a law — a 4x band in either
 * direction keeps the rule quiet about ordinary tuning choices.
 */
export const LISTS_TOLERANCE_FACTOR = 4;

/** pgvector's published starting point for the ivfflat `lists` parameter. */
export function idealLists(rowEstimate: number): number {
  return Math.sqrt(rowEstimate);
}

interface Candidate {
  index: PgvectorIndex;
  rowEstimate: number;
}

export const ivfflatListsMismatchRule: ReadinessRule = {
  id: 'ivfflat-lists-mismatch',
  title: 'ivfflat index tuned for the wrong table size',
  applicable: vectorRuleApplicable,
  async evaluate(_sources, ctx) {
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'An ivfflat index splits vectors into `lists` clusters and searches only a few of them. Too few lists ' +
        'and every cluster is huge, so queries stay slow; too many and each cluster is tiny, so the search ' +
        'misses true nearest neighbours and recall silently drops. The published starting point is ' +
        'lists ≈ sqrt(number of rows).',
      fix:
        'Recreate the index with lists close to sqrt(rows) — CREATE INDEX ON <table> USING ivfflat ' +
        '(<column> vector_cosine_ops) WITH (lists = N) — or switch to hnsw, which needs no row-count-dependent ' +
        'tuning. Confirm with EXPLAIN that the new index is used.',
      learnMoreUrl: 'https://github.com/pgvector/pgvector#ivfflat',
    };

    const inventory = ctx.pgvector;
    if (inventory === undefined || inventory === 'absent' || inventory === null) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: PGVECTOR_UNREADABLE_REASON };
    }

    // Only tables PostgreSQL has an estimate for, and only above the threshold:
    // below it the whole tuning question is moot.
    const rowsByTable = new Map<string, number>();
    for (const table of inventory.tables) {
      if (table.rowEstimate !== null && table.rowEstimate >= VECTOR_MIN_ROWS) {
        rowsByTable.set(table.table, table.rowEstimate);
      }
    }

    const candidates: Candidate[] = [];
    for (const index of inventory.indexes) {
      if (index.accessMethod !== 'ivfflat') continue;
      const rowEstimate = rowsByTable.get(index.table);
      if (rowEstimate === undefined) continue;
      candidates.push({ index, rowEstimate });
    }

    const mismatched: string[] = [];
    const unreadable: PgvectorIndex[] = [];
    const withinBand: string[] = [];

    for (const { index, rowEstimate } of candidates) {
      if (index.lists === null) {
        unreadable.push(index);
        continue;
      }
      const ideal = idealLists(rowEstimate);
      const low = ideal / LISTS_TOLERANCE_FACTOR;
      const high = ideal * LISTS_TOLERANCE_FACTOR;
      const line =
        `${index.indexName} on ${index.table}.${index.column ?? '(expression)'}: lists = ${index.lists}, ` +
        `sqrt(~${rowEstimate.toLocaleString('en-US')} rows estimated) ≈ ${Math.round(ideal)} ` +
        `(accepted band at ${LISTS_TOLERANCE_FACTOR}x: ${Math.round(low)}–${Math.round(high)})`;
      if (index.lists < low || index.lists > high) mismatched.push(line);
      else withinBand.push(line);
    }

    if (mismatched.length > 0) {
      return { ...base, status: 'at_risk' as const, evidence: mismatched };
    }

    if (unreadable.length > 0) {
      return {
        ...base,
        status: 'unknown' as const,
        evidence: unreadable.map(
          (i) => `${i.indexName} on ${i.table}: no lists value recorded in the index options`,
        ),
        reason:
          `${unreadable.map((i) => i.indexName).join(', ')} was created without an explicit ` +
          'WITH (lists = ...), so PostgreSQL records no value to check against the sqrt(rows) heuristic',
      };
    }

    const hnswExempt = inventory.indexes
      .filter((i) => i.accessMethod === 'hnsw')
      .map((i) => `${i.indexName} on ${i.table}: hnsw — exempt (no row-count-dependent tuning parameter)`);

    return { ...base, status: 'ready' as const, evidence: [...withinBand, ...hnswExempt] };
  },
};
```

- [ ] **Step 4: Register the rule**

In `src/readiness/rules/index.ts` add the import and array entry:

```typescript
import { ivfflatListsMismatchRule } from './ivfflat-lists-mismatch.js';
```

```typescript
export const allRules: ReadinessRule[] = [
  connectionHeadroomRule,
  connectionLimitTierRule,
  longTransactionsRule,
  missingIndexRule,
  slowQueriesRule,
  serverlessPoolingRule,
  vectorIndexMissingRule,
  ivfflatListsMismatchRule,
];
```

- [ ] **Step 5: Update the rule-roster test to eight**

In `src/__tests__/readiness-run.test.ts`:

```typescript
  it('registry contains the eight rules', () => {
    expect(allRules.map((r) => r.id).sort()).toEqual([
      'connection-headroom', 'connection-limit-tier', 'ivfflat-lists-mismatch',
      'long-transactions', 'missing-index', 'serverless-pooling', 'slow-queries',
      'vector-index-missing',
    ]);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-vector-rules.test.ts src/__tests__/readiness-run.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/readiness/rules/ivfflat-lists-mismatch.ts src/readiness/rules/index.ts \
  src/__tests__/readiness-vector-rules.test.ts src/__tests__/readiness-run.test.ts
git commit -m "feat(readiness): add ivfflat-lists-mismatch rule with a 4x sqrt(rows) band"
```

---

## Task 4: Wire the pgvector inventory into the readiness runner

**Files:**
- Modify: `src/readiness/run.ts:94-101` (the `ReadinessPgClient` surface), `:214-237` (sources + rule invocation)
- Modify: `src/__tests__/readiness-run.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `PgvectorInventory` (Task 1), `ReadinessSources.getPgvectorInventory?`, `ReadinessContext.pgvector?`, both new rules (Tasks 2-3).
- Produces: `connectAndRunReadiness` populates `ctx.pgvector` before rule evaluation. No signature change — `connectAndRunReadiness(pgTarget: TargetConfig, ctx: ReadinessContext, createClient?: PgClientFactory, options?: ConnectAndRunReadinessOptions): Promise<ReadinessReport>` is unchanged, so existing callers and test fakes keep working.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/readiness-run.test.ts` (inside the file, after the `connectAndRunReadiness` describe block):

```typescript
describe('connectAndRunReadiness pgvector wiring', () => {
  const VECTOR_RULE_IDS = ['vector-index-missing', 'ivfflat-lists-mismatch'];
  const vectorFindings = (report: { findings: Array<{ ruleId: string }> }) =>
    report.findings.filter((f) => VECTOR_RULE_IDS.includes(f.ruleId));

  it('produces zero vector output when the client cannot probe pgvector', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient());
    expect(vectorFindings(report)).toHaveLength(0);
  });

  it("produces zero vector output on a database without the extension ('absent')", async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => 'absent' as const,
    }));
    expect(vectorFindings(report)).toHaveLength(0);
  });

  it('reports both vector rules as unknown when the catalog read fails', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => null,
    }));
    const findings = vectorFindings(report);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.status).toBe('unknown');
      expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
    }
    // Unknown never moves the score (honesty contract).
    expect(report.score).toBe(100);
  });

  it('flags a large unindexed vector table end to end', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => ({
        extensionVersion: '0.7.0',
        tables: [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
        indexes: [],
      }),
    }));
    const missing = report.findings.find((f) => f.ruleId === 'vector-index-missing');
    expect(missing?.status).toBe('at_risk');
    expect(report.verdict).toBe('at-risk');
  });

  it('probes the pgvector catalog exactly once per run', async () => {
    const probe = vi.fn(async () => 'absent' as const);
    await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: probe,
    }));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the caller-supplied context', async () => {
    const callerCtx = { ...ctx };
    await connectAndRunReadiness(PG_TARGET, callerCtx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => 'absent' as const,
    }));
    expect(callerCtx.pgvector).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/__tests__/readiness-run.test.ts`
Expected: FAIL — the `'absent'`/`null`/inventory cases all produce zero vector findings because `ctx.pgvector` is never populated, so "reports both vector rules as unknown" and "flags a large unindexed vector table end to end" fail.

- [ ] **Step 3: Extend the narrow pg-client surface**

In `src/readiness/run.ts`, add `PgvectorInventory` to the type import from `./types.js` (currently lines 23-26), then add this optional member to `interface ReadinessPgClient` (line 94-101), after `queryStatementAggregate`:

```typescript
  /** Optional: older/leaner clients and test fakes may omit it entirely. */
  getPgvectorInventory?(): Promise<PgvectorInventory | 'absent' | null>;
```

- [ ] **Step 4: Expose the probe on `ReadinessSources` and populate the context**

In `connectAndRunReadiness`, immediately before the `const sources: ReadinessSources = {` literal (line 215), add:

```typescript
    // Bound once: `activeClient` is captured by the closure below, and the
    // optional member may be absent entirely under exactOptionalPropertyTypes.
    const pgvectorProbe = activeClient.getPgvectorInventory?.bind(activeClient);
```

Add this entry to the sources literal, next to the existing conditional Redis spread (lines 224-235):

```typescript
      ...(pgvectorProbe ? { getPgvectorInventory: pgvectorProbe } : {}),
```

Then replace the single `runRules` call (line 237) with:

```typescript
    // The pgvector inventory is fetched ONCE, before rule evaluation, and put
    // on the context. `applicable(ctx)` is synchronous and cannot query the
    // database, and it is the only mechanism that skips a rule *silently* — a
    // rule returning 'unknown' still renders. A non-pgvector database
    // therefore produces zero vector-related output. A fresh object is built
    // rather than mutating the caller's ctx.
    const pgvector = pgvectorProbe ? await pgvectorProbe() : undefined;
    const ruleCtx: ReadinessContext = pgvector === undefined ? ctx : { ...ctx, pgvector };
    const findings = await runRules(allRules, sources, ruleCtx);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/__tests__/readiness-run.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole readiness suite plus typecheck and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green. `src/__tests__/readiness-cli.test.ts` and `src/__tests__/mcp-readiness.test.ts` render whole reports, so they are the ones to watch — but every existing fake client omits `getPgvectorInventory`, so `ctx.pgvector` stays `undefined`, both rules are skipped, and their expected output is unchanged. If either does fail, the cause is a fake that gained the method, not a rendering change.

- [ ] **Step 7: Commit**

```bash
git add src/readiness/run.ts src/__tests__/readiness-run.test.ts
git commit -m "feat(readiness): fetch the pgvector inventory once before rule evaluation"
```

---

## Task 5: Vector-store provider table, check ids, backend contract, simulator

**Files:**
- Create: `src/agent/vector-store/provider-table.ts`
- Create: `src/agent/vector-store/check-ids.ts`
- Create: `src/agent/vector-store/backend.ts`
- Create: `src/agent/vector-store/simulator.ts`
- Test: `src/__tests__/vector-store-provider-table.test.ts`
- Test: `src/__tests__/vector-store-simulator.test.ts`

**Interfaces:**
- Consumes: `ExecutionBackend` from `../../framework/backend.js` — `{ executeCommand(command: Command): Promise<unknown>; evaluateCheck(check: CheckExpression): Promise<boolean>; listCapabilityProviders?(): CapabilityProviderDescriptor[]; transition?(to: string): void; close(): Promise<void> }`. `compareCheckValue` from `../../framework/check-helpers.js`. `fingerprintKey(key: string): string` from PR 3's `src/agent/llm-provider/provider-table.js` — `'…' + last 4` (U+2026), or `'(key too short to fingerprint)'` for keys under 8 characters.
- Produces:
  - `type VectorStoreProvider = 'pinecone' | 'upstash-vector'`
  - `VECTOR_STORE_PROVIDERS: VectorStoreProviderSpec[]`
  - `VECTOR_STORE_ENV_VARS: Array<{ envVar: string; provider: VectorStoreProvider }>`
  - `buildVectorStoreConnections(env: NodeJS.ProcessEnv): VectorStoreConnection[]`
  - `VECTOR_STORE_CHECK_IDS` — a keyed `as const` object `{ reachable, authValid, indexStatus }`, plus `type VectorStoreCheckId`; both re-exported from `backend.ts`
  - `VectorStoreBackend` with `queryVectorStores(): Promise<VectorStoreReport[]>`
  - `VectorStoreReport { provider; keyFingerprint; checks: VectorStoreCheck[]; indexes: VectorStoreIndexInfo[] }`
  - `VectorStoreCheck { checkId: VectorStoreCheckId; status: 'pass' | 'fail' | 'unknown'; detail: string }`
  - `VectorStoreIndexInfo { name: string; ready: boolean; dimension: number | null; recordCount: number | null }`
  - `VectorStoreSimulator` with `transition(to: string): void` (the `ExecutionBackend` signature) validating against `VectorStoreScenario` = `'healthy' | 'unreachable' | 'bad_key' | 'index_not_ready' | 'no_indexes'`

**Note on offline:** there is deliberately no `offline` scenario here and no offline logic in the backend. Offline deferral is the agent's job via PR 3's `OfflineGate` (Task 7) — modelling it twice would let the simulator claim an offline observer the gate never saw.

- [ ] **Step 1: Write the failing provider-table test**

Create `src/__tests__/vector-store-provider-table.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import {
  VECTOR_STORE_ENV_VARS, buildVectorStoreConnections,
} from '../agent/vector-store/provider-table.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';

describe('VECTOR_STORE_CHECK_IDS', () => {
  it('is a keyed object of the exact contract strings (PR 5 reads Object.values)', () => {
    expect(VECTOR_STORE_CHECK_IDS).toEqual({
      reachable: 'vector-store.reachable',
      authValid: 'vector-store.auth_valid',
      indexStatus: 'vector-store.index_status',
    });
  });

  it('is re-exported from backend.ts so consumers need only one import', async () => {
    const backend = await import('../agent/vector-store/backend.js');
    expect(backend.VECTOR_STORE_CHECK_IDS).toBe(VECTOR_STORE_CHECK_IDS);
  });
});

describe('VECTOR_STORE_ENV_VARS', () => {
  it('lists every credential env var the agent knows about', () => {
    expect(VECTOR_STORE_ENV_VARS.map((v) => v.envVar).sort()).toEqual([
      'PINECONE_API_KEY', 'UPSTASH_VECTOR_REST_TOKEN', 'UPSTASH_VECTOR_REST_URL',
    ]);
  });
});

describe('buildVectorStoreConnections', () => {
  it('builds a pinecone connection from the api key alone', () => {
    const conns = buildVectorStoreConnections({ PINECONE_API_KEY: 'pc-secret-1234' });
    expect(conns).toEqual([
      { provider: 'pinecone', baseUrl: 'https://api.pinecone.io', apiKey: 'pc-secret-1234' },
    ]);
  });

  it('builds an upstash connection from url + token', () => {
    const conns = buildVectorStoreConnections({
      UPSTASH_VECTOR_REST_URL: 'https://example-vector.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret-5678',
    });
    expect(conns).toEqual([
      { provider: 'upstash-vector', baseUrl: 'https://example-vector.upstash.io', apiKey: 'up-secret-5678' },
    ]);
  });

  it('strips a trailing slash from the upstash url', () => {
    const conns = buildVectorStoreConnections({
      UPSTASH_VECTOR_REST_URL: 'https://example-vector.upstash.io/',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret-5678',
    });
    expect(conns[0]?.baseUrl).toBe('https://example-vector.upstash.io');
  });

  it('skips upstash when only the token is set (never probe a guessed url)', () => {
    expect(buildVectorStoreConnections({ UPSTASH_VECTOR_REST_TOKEN: 'up-secret' })).toEqual([]);
  });

  it('skips upstash when only the url is set', () => {
    expect(buildVectorStoreConnections({ UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io' })).toEqual([]);
  });

  it('returns an empty list with no credentials at all', () => {
    expect(buildVectorStoreConnections({})).toEqual([]);
  });

  it('builds both providers when both are configured', () => {
    const conns = buildVectorStoreConnections({
      PINECONE_API_KEY: 'pc',
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up',
    });
    expect(conns.map((c) => c.provider)).toEqual(['pinecone', 'upstash-vector']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/__tests__/vector-store-provider-table.test.ts`
Expected: FAIL — cannot resolve `../agent/vector-store/provider-table.js`.

- [ ] **Step 3: Implement the provider table**

Create `src/agent/vector-store/provider-table.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static table for managed vector stores: which env vars carry credentials
 * and which REST endpoint answers the reachability/auth/index checks. Single
 * source of truth for both the live client and autodiscovery detection.
 *
 * SECURITY: the values of these env vars are credentials. They are read at
 * backend-construction time, handed straight to the live client, and never
 * logged, stored on a finding, or written to forensics — only the provider
 * name and a last-4 fingerprint ever appear in output.
 */

export type VectorStoreProvider = 'pinecone' | 'upstash-vector';

export interface VectorStoreProviderSpec {
  provider: VectorStoreProvider;
  /** Env var carrying the API key / bearer token. */
  keyEnvVar: string;
  /** Env var carrying the base REST URL; omitted when the endpoint is fixed. */
  urlEnvVar?: string;
  /** Fixed control-plane base URL; omitted when the URL comes from `urlEnvVar`. */
  baseUrl?: string;
}

export const VECTOR_STORE_PROVIDERS: VectorStoreProviderSpec[] = [
  { provider: 'pinecone', keyEnvVar: 'PINECONE_API_KEY', baseUrl: 'https://api.pinecone.io' },
  {
    provider: 'upstash-vector',
    keyEnvVar: 'UPSTASH_VECTOR_REST_TOKEN',
    urlEnvVar: 'UPSTASH_VECTOR_REST_URL',
  },
];

/** Env-var detection list for autodiscovery, derived from the table above. */
export const VECTOR_STORE_ENV_VARS: Array<{ envVar: string; provider: VectorStoreProvider }> =
  VECTOR_STORE_PROVIDERS.flatMap((spec) => [
    { envVar: spec.keyEnvVar, provider: spec.provider },
    ...(spec.urlEnvVar ? [{ envVar: spec.urlEnvVar, provider: spec.provider }] : []),
  ]);

export interface VectorStoreConnection {
  provider: VectorStoreProvider;
  baseUrl: string;
  apiKey: string;
}

/**
 * One connection per provider that is FULLY configured in `env`. Upstash needs
 * both its URL and its token — a half-configured provider is skipped rather
 * than probed against a guessed URL.
 */
export function buildVectorStoreConnections(env: NodeJS.ProcessEnv): VectorStoreConnection[] {
  const connections: VectorStoreConnection[] = [];
  for (const spec of VECTOR_STORE_PROVIDERS) {
    const apiKey = env[spec.keyEnvVar];
    if (!apiKey) continue;
    const baseUrl = spec.baseUrl ?? (spec.urlEnvVar ? env[spec.urlEnvVar] : undefined);
    if (!baseUrl) continue;
    connections.push({
      provider: spec.provider,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
    });
  }
  return connections;
}
```

Credential masking is **not** reimplemented here. PR 3 owns `fingerprintKey` in
`src/agent/llm-provider/provider-table.ts`, and one masking rule across the series
is the point — a second implementation is how the two drift and one of them starts
leaking more of the key than the other. Import it where needed:

```typescript
import { fingerprintKey } from '../llm-provider/provider-table.js';
```

Task 6 Step 5 names it as the first thing to move if the shared-module extraction fires.

- [ ] **Step 4: Create the check-id constants**

Create `src/agent/vector-store/check-ids.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check identifiers for every finding this agent emits. These are a
 * public contract: guidance is anchored to them, so they are additive-only —
 * renaming one breaks every consumer downstream.
 *
 * Shape matches PR 3's LLM_PROVIDER_CHECK_IDS: a keyed `as const` object, so
 * call sites read as `VECTOR_STORE_CHECK_IDS.authValid` and PR 5's guidance
 * registry can enumerate the strings with Object.values(). This file stays
 * dependency-free so that registry can import it without pulling in the agent.
 */

export const VECTOR_STORE_CHECK_IDS = {
  reachable: 'vector-store.reachable',
  authValid: 'vector-store.auth_valid',
  indexStatus: 'vector-store.index_status',
} as const;

export type VectorStoreCheckId =
  (typeof VECTOR_STORE_CHECK_IDS)[keyof typeof VECTOR_STORE_CHECK_IDS];
```

- [ ] **Step 5: Create the backend contract**

Create `src/agent/vector-store/backend.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * VectorStoreBackend — the read-only contract both the simulator and the live
 * client implement. There are no mutating methods: this agent diagnoses a
 * managed vector store, it never changes one.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { VectorStoreProvider } from './provider-table.js';
import type { VectorStoreCheckId } from './check-ids.js';

// Re-exported so consumers (agent, live client, PR 5's guidance registry) can
// take the ids and the contract from one import.
export { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
export type { VectorStoreCheckId } from './check-ids.js';

export type VectorStoreCheckStatus = 'pass' | 'fail' | 'unknown';

export interface VectorStoreCheck {
  checkId: VectorStoreCheckId;
  status: VectorStoreCheckStatus;
  /** Plain-language result. Never contains key material. */
  detail: string;
}

export interface VectorStoreIndexInfo {
  name: string;
  ready: boolean;
  /** null when the provider did not report it — never guessed. */
  dimension: number | null;
  /** null when the provider did not report it — never guessed. */
  recordCount: number | null;
}

export interface VectorStoreReport {
  provider: VectorStoreProvider;
  /** Masked credential reference (last 4 characters) — never the key itself. */
  keyFingerprint: string;
  checks: VectorStoreCheck[];
  indexes: VectorStoreIndexInfo[];
}

export interface VectorStoreBackend extends ExecutionBackend {
  /**
   * One report per configured provider. A provider-level failure is reported
   * as a failing/unknown check inside its report — this never throws for a
   * network or auth problem.
   */
  queryVectorStores(): Promise<VectorStoreReport[]>;

  /** Simulator-only state transitions. */
  transition?(to: string): void;
}
```

- [ ] **Step 6: Write the failing simulator test**

Create `src/__tests__/vector-store-simulator.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { VectorStoreSimulator, SIMULATOR_FIXTURE_KEY } from '../agent/vector-store/simulator.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { VectorStoreCheckStatus, VectorStoreReport } from '../agent/vector-store/backend.js';

const statusOf = (report: VectorStoreReport, checkId: string): VectorStoreCheckStatus | undefined =>
  report.checks.find((c) => c.checkId === checkId)?.status;

describe('VectorStoreSimulator', () => {
  it('healthy: all three checks pass and an index is reported ready', async () => {
    const [report] = await new VectorStoreSimulator().queryVectorStores();
    expect(report).toBeDefined();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]?.ready).toBe(true);
    expect(report!.indexes[0]?.dimension).toBe(1536);
  });

  it('unreachable: reachability fails and the dependent checks are unknown', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('unreachable');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('bad_key: reachable but auth fails', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('bad_key');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('index_not_ready: index status fails while auth passes', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('index_not_ready');
    const [report] = await sim.queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes[0]?.ready).toBe(false);
  });

  it('no_indexes: auth passes and index status is a failure with no indexes listed', async () => {
    const sim = new VectorStoreSimulator();
    sim.transition('no_indexes');
    const [report] = await sim.queryVectorStores();
    expect(report!.indexes).toEqual([]);
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
  });

  it('never exposes key material — only a PR 3-shaped fingerprint', async () => {
    const [report] = await new VectorStoreSimulator().queryVectorStores();
    expect(report!.keyFingerprint).toBe('…0000');
    expect(JSON.stringify(report)).not.toContain(SIMULATOR_FIXTURE_KEY);
  });

  it('rejects an unknown scenario rather than silently doing nothing', () => {
    expect(() => new VectorStoreSimulator().transition('nonsense')).toThrow();
  });

  it('has no offline scenario — offline deferral belongs to the agent gate', () => {
    expect(() => new VectorStoreSimulator().transition('offline')).toThrow();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run src/__tests__/vector-store-simulator.test.ts`
Expected: FAIL — cannot resolve `../agent/vector-store/simulator.js`.

- [ ] **Step 8: Implement the simulator**

Create `src/agent/vector-store/simulator.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import type {
  VectorStoreBackend, VectorStoreCheck, VectorStoreIndexInfo, VectorStoreReport,
} from './backend.js';
import { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
import { fingerprintKey } from '../llm-provider/provider-table.js';

export type VectorStoreScenario =
  | 'healthy'
  | 'unreachable'
  | 'bad_key'
  | 'index_not_ready'
  | 'no_indexes';

const SCENARIOS: VectorStoreScenario[] = [
  'healthy', 'unreachable', 'bad_key', 'index_not_ready', 'no_indexes',
];

/**
 * Obviously-fake key: the simulator has no real credential and must not imply
 * one. Exported so the secrecy test can assert the raw value never escapes.
 */
export const SIMULATOR_FIXTURE_KEY = 'vs-simulator-fixture-key-0000';

const SIMULATOR_FINGERPRINT = fingerprintKey(SIMULATOR_FIXTURE_KEY);

const READY_INDEX: VectorStoreIndexInfo = {
  name: 'documents', ready: true, dimension: 1536, recordCount: 42_000,
};

export class VectorStoreSimulator implements VectorStoreBackend {
  private scenario: VectorStoreScenario = 'healthy';

  getScenario(): VectorStoreScenario {
    return this.scenario;
  }

  /**
   * `to: string` is the ExecutionBackend signature, so the value is validated
   * rather than cast. This is deliberately stricter than PgSimulator, which
   * casts blindly (`this.state = to as SimulatorState`) and so accepts a typo'd
   * scenario silently — a test that then asserts healthy behaviour passes for
   * the wrong reason.
   */
  transition(to: string): void {
    if (!SCENARIOS.includes(to as VectorStoreScenario)) {
      throw new Error(
        `Invalid vector-store simulator scenario: ${to} (expected one of ${SCENARIOS.join(', ')})`,
      );
    }
    this.scenario = to as VectorStoreScenario;
  }

  async queryVectorStores(): Promise<VectorStoreReport[]> {
    return [{
      provider: 'pinecone',
      keyFingerprint: SIMULATOR_FINGERPRINT,
      checks: this.checks(),
      indexes: this.indexes(),
    }];
  }

  private indexes(): VectorStoreIndexInfo[] {
    switch (this.scenario) {
      case 'healthy':
        return [READY_INDEX];
      case 'index_not_ready':
        return [{ name: 'documents', ready: false, dimension: 1536, recordCount: 0 }];
      case 'unreachable':
      case 'bad_key':
      case 'no_indexes':
        return [];
    }
  }

  private checks(): VectorStoreCheck[] {
    switch (this.scenario) {
      case 'healthy':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 41ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'pass', detail: '1 index ready: documents (dimension 1536, 42000 records).' },
        ];
      case 'unreachable':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'fail', detail: 'pinecone control plane did not answer (network error).' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
        ];
      case 'bad_key':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 38ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'fail', detail: `pinecone rejected the key ${SIMULATOR_FINGERPRINT} (HTTP 401).` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the key was rejected.' },
        ];
      case 'index_not_ready':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 44ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail', detail: 'index documents is not ready (state: Initializing).' },
        ];
      case 'no_indexes':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 36ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail', detail: 'the account has no indexes — retrieval has nothing to query.' },
        ];
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported vector-store simulator command type: ${command.type}`);
    }
    if (command.operation === 'query_vector_stores') {
      return { reports: await this.queryVectorStores() };
    }
    return { simulated: true, operation: command.operation, parameters: command.parameters };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const [report] = await this.queryVectorStores();
    if (!report) return false;

    if (statement.includes('auth_valid')) {
      const status = report.checks.find((c) => c.checkId === VECTOR_STORE_CHECK_IDS.authValid)?.status ?? 'unknown';
      return compareCheckValue(status, check.expect.operator, check.expect.value);
    }
    if (statement.includes('ready_index_count')) {
      const count = report.indexes.filter((i) => i.ready).length;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [{
      id: 'vector-store-simulator-reader',
      kind: 'capability_provider',
      name: 'Vector Store Simulator Reader',
      maturity: 'simulator_only',
      capabilities: ['vectorstore.index.read'],
      executionContexts: ['vector_store_read'],
      targetKinds: ['vector-store'],
      commandTypes: ['structured_command'],
      supportsDryRun: true,
      supportsExecute: true,
    }];
  }

  async close(): Promise<void> {}
}
```

- [ ] **Step 9: Run both tests to verify they pass**

Run: `pnpm vitest run src/__tests__/vector-store-provider-table.test.ts src/__tests__/vector-store-simulator.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add src/agent/vector-store/provider-table.ts src/agent/vector-store/check-ids.ts \
  src/agent/vector-store/backend.ts src/agent/vector-store/simulator.ts \
  src/__tests__/vector-store-provider-table.test.ts src/__tests__/vector-store-simulator.test.ts
git commit -m "feat(vector-store): add provider table, check ids, backend contract, and simulator"
```

---

## Task 6: Vector-store live client (Pinecone + Upstash Vector)

**Files:**
- Create: `src/agent/vector-store/live-client.ts`
- Test: `src/__tests__/vector-store-live-client.test.ts`

**Interfaces:**
- Consumes (Task 5): `VectorStoreBackend`, `VectorStoreReport`, `VectorStoreCheck`, `VectorStoreIndexInfo`, `VectorStoreConnection { provider; baseUrl; apiKey }`, `VECTOR_STORE_CHECK_IDS`. Plus `fingerprintKey` from PR 3's `../llm-provider/provider-table.js`.
- Produces:
  - `VectorStoreLiveClient` implementing `VectorStoreBackend`
  - `VectorStoreLiveConfig { connections: VectorStoreConnection[]; timeoutMs?: number }`
  - `DEFAULT_TIMEOUT_MS = 1500` (exported, so the registration and its test reference one number)

**The client has no offline concept.** Offline deferral lives on the agent, behind PR 3's async `OfflineGate` (Task 7). Do not add a `getNetworkProfile()` check here: PR 3's plan rejects that signal explicitly because it cannot distinguish "this machine" from "this network", which is the whole distinction the deferral exists to report.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/vector-store-live-client.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi, afterEach } from 'vitest';
import { VectorStoreLiveClient, DEFAULT_TIMEOUT_MS } from '../agent/vector-store/live-client.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { VectorStoreConnection } from '../agent/vector-store/provider-table.js';

const PINECONE: VectorStoreConnection = {
  provider: 'pinecone', baseUrl: 'https://api.pinecone.io', apiKey: 'pcsk-supersecret-9876',
};
const UPSTASH: VectorStoreConnection = {
  provider: 'upstash-vector', baseUrl: 'https://demo-vector.upstash.io', apiKey: 'up-supersecret-5432',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function client(connections: VectorStoreConnection[]) {
  return new VectorStoreLiveClient({ connections });
}

const statusOf = (
  report: { checks: Array<{ checkId: string; status: string }> }, checkId: string,
): string | undefined => report.checks.find((c) => c.checkId === checkId)?.status;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VectorStoreLiveClient — pinecone', () => {
  it('lists indexes from the control plane with the Api-Key header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [report] = await client([PINECONE]).queryVectorStores();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('https://api.pinecone.io/indexes');
    expect((firstCall[1].headers as Record<string, string>)['Api-Key']).toBe('pcsk-supersecret-9876');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]).toMatchObject({ name: 'documents', ready: true, dimension: 1536 });
  });

  it('classifies HTTP 401 as reachable-but-unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('classifies HTTP 403 as an auth failure too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
  });

  it('classifies HTTP 503 as reachable with honest unknowns, not an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 503)));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('classifies a network error as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('unknown');
  });

  it('reports an index that is not ready as a failing index_status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      indexes: [{ name: 'documents', dimension: 1536, status: { ready: false, state: 'Initializing' } }],
    })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes[0]?.ready).toBe(false);
  });

  it('reports an empty account as a failing index_status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ indexes: [] })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('fail');
    expect(report!.indexes).toEqual([]);
  });

  it('leaves recordCount null when the data-plane stats call fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('describe_index_stats')) throw new TypeError('fetch failed');
      return jsonResponse({
        indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(report!.indexes[0]?.recordCount).toBeNull();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
  });

  it('reads recordCount from the data plane when available', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('describe_index_stats')) return jsonResponse({ totalVectorCount: 42_000 });
      return jsonResponse({
        indexes: [{ name: 'documents', dimension: 1536, host: 'documents-abc.svc.pinecone.io', status: { ready: true, state: 'Ready' } }],
      });
    }));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(report!.indexes[0]?.recordCount).toBe(42_000);
  });
});

describe('VectorStoreLiveClient — upstash-vector', () => {
  it('reads /info with a bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      result: { vectorCount: 1_200, pendingVectorCount: 0, dimension: 384, similarityFunction: 'COSINE' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [report] = await client([UPSTASH]).queryVectorStores();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('https://demo-vector.upstash.io/info');
    expect((firstCall[1].headers as Record<string, string>)['Authorization'])
      .toBe('Bearer up-supersecret-5432');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('pass');
    expect(report!.indexes[0]).toEqual({
      name: 'demo-vector.upstash.io', ready: true, dimension: 384, recordCount: 1_200,
    });
  });

  it('classifies a rejected token as an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('fail');
  });
});

describe('VectorStoreLiveClient — degradation contract', () => {
  it('one provider failing never suppresses the other', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://api.pinecone.io')) throw new TypeError('fetch failed');
      return jsonResponse({ result: { vectorCount: 5, pendingVectorCount: 0, dimension: 384 } });
    }));
    const reports = await client([PINECONE, UPSTASH]).queryVectorStores();
    expect(reports).toHaveLength(2);
    expect(statusOf(reports[0]!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('fail');
    expect(statusOf(reports[1]!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
  });

  it('returns an empty report list when no provider is configured', async () => {
    expect(await client([]).queryVectorStores()).toEqual([]);
  });

  it('degrades a malformed pinecone body to unknown, not a false "no indexes" fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ notIndexes: 'unexpected shape' })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('degrades an unparseable pinecone body to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    const [report] = await client([PINECONE]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });

  it('degrades a missing upstash result field to unknown, not a false "ready" pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.reachable)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.authValid)).toBe('pass');
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
    expect(report!.indexes).toEqual([]);
  });

  it('degrades a malformed upstash result field to unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: 'not-an-object' })));
    const [report] = await client([UPSTASH]).queryVectorStores();
    expect(statusOf(report!, VECTOR_STORE_CHECK_IDS.indexStatus)).toBe('unknown');
  });
});

describe('VectorStoreLiveClient — timeout budget', () => {
  it('defaults to a timeout that fits inside scan\'s per-agent budget', () => {
    // scan races assessHealth against AGENT_TIMEOUT_MS (2000ms). A slower
    // default would let a hanging provider blow that budget, and a timed-out
    // assessHealth returns a signal-less 'unknown' — wiping every checkId PR 5
    // anchors guidance to. Two sequential requests (Pinecone control plane then
    // data plane) must still fit, so this is the ceiling, not a preference.
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  it('passes the configured timeout to the request signal', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ indexes: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await new VectorStoreLiveClient({ connections: [PINECONE], timeoutMs: 50 }).queryVectorStores();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('VectorStoreLiveClient — secrecy', () => {
  it('no key material appears anywhere in the emitted reports', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    const reports = await client([PINECONE, UPSTASH]).queryVectorStores();
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain(PINECONE.apiKey);
    expect(serialized).not.toContain(UPSTASH.apiKey);
    expect(serialized).toContain('…9876');
    expect(serialized).toContain('…5432');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/__tests__/vector-store-live-client.test.ts`
Expected: FAIL — cannot resolve `../agent/vector-store/live-client.js`.

- [ ] **Step 3: Implement the live client**

Create `src/agent/vector-store/live-client.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * VectorStoreLiveClient — read-only reachability/auth/index probes against
 * managed vector stores over raw fetch (no SDKs, no new dependencies).
 *
 * Degradation contract: a provider-level failure never throws and never
 * suppresses another provider's report; a check that cannot be evaluated
 * reports 'unknown' with the reason rather than guessing.
 *
 * Offline handling is deliberately NOT here — the agent's OfflineGate decides
 * whether to probe at all, using PR 2's triage verdict.
 *
 * SECURITY: keys are used only as request headers. Output carries the
 * provider name and a last-4 fingerprint, never the key.
 */

import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import type {
  VectorStoreBackend, VectorStoreCheck, VectorStoreIndexInfo, VectorStoreReport,
} from './backend.js';
import { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
import { fingerprintKey } from '../llm-provider/provider-table.js';
import type { VectorStoreConnection } from './provider-table.js';

/**
 * Per-request timeout. Scan races each agent's assessHealth against
 * AGENT_TIMEOUT_MS (2000ms) and a timed-out assessHealth returns a signal-less
 * 'unknown' — losing every checkId. Two sequential Pinecone requests (control
 * plane, then data plane) must fit inside that budget, so this is a ceiling
 * derived from scan's contract, not a tuning preference.
 */
export const DEFAULT_TIMEOUT_MS = 1_500;

export interface VectorStoreLiveConfig {
  connections: VectorStoreConnection[];
  /** Per-request timeout. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface PineconeIndexEntry {
  name?: unknown;
  dimension?: unknown;
  host?: unknown;
  status?: { ready?: unknown; state?: unknown } | undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class VectorStoreLiveClient implements VectorStoreBackend {
  private readonly connections: VectorStoreConnection[];
  private readonly timeoutMs: number;

  constructor(config: VectorStoreLiveConfig) {
    this.connections = config.connections;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async queryVectorStores(): Promise<VectorStoreReport[]> {
    return Promise.all(this.connections.map((connection) => this.probe(connection)));
  }

  private async probe(connection: VectorStoreConnection): Promise<VectorStoreReport> {
    const fingerprint = fingerprintKey(connection.apiKey);
    return connection.provider === 'pinecone'
      ? this.probePinecone(connection, fingerprint)
      : this.probeUpstash(connection, fingerprint);
  }

  /** Non-2xx that is neither 401 nor 403: reachable, but nothing else is known. */
  private nonAuthFailure(
    provider: string, status: number, fingerprint: string, latencyMs: number,
  ): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `${provider} answered in ${latencyMs}ms.` },
      {
        checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown',
        detail: `${provider} returned HTTP ${status} for key ${fingerprint} — the key was neither accepted nor rejected.`,
      },
      {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown',
        detail: `not checked — ${provider} returned HTTP ${status}.`,
      },
    ];
  }

  private unreachable(provider: string, message: string): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'fail', detail: `${provider} did not answer (${message}).` },
      { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
      { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
    ];
  }

  private rejectedKey(provider: string, status: number, fingerprint: string, latencyMs: number): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `${provider} answered in ${latencyMs}ms.` },
      {
        checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'fail',
        detail: `${provider} rejected the key ${fingerprint} (HTTP ${status}).`,
      },
      { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the key was rejected.' },
    ];
  }

  /**
   * A 2xx response whose body could not be parsed as JSON, or whose shape
   * does not match what this provider is documented to return. This is
   * distinct from a well-formed body reporting zero indexes: an un-evaluable
   * response degrades to 'unknown', never to a fabricated definitive status
   * (never counted as "no indexes" and never counted as "index ready").
   */
  private malformedBody(provider: string): VectorStoreCheck {
    return {
      checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown',
      detail: `${provider} returned a response body that could not be parsed into the expected shape — index status could not be determined.`,
    };
  }

  private indexStatusCheck(provider: string, indexes: VectorStoreIndexInfo[]): VectorStoreCheck {
    if (indexes.length === 0) {
      return {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail',
        detail: `${provider} reports no indexes — retrieval has nothing to query.`,
      };
    }
    const notReady = indexes.filter((index) => !index.ready);
    if (notReady.length > 0) {
      return {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail',
        detail: `not ready: ${notReady.map((i) => i.name).join(', ')}.`,
      };
    }
    return {
      checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'pass',
      detail: indexes
        .map((i) => `${i.name} ready (dimension ${i.dimension ?? 'unreported'}, ` +
          `${i.recordCount === null ? 'record count unreported' : `${i.recordCount} records`})`)
        .join('; ') + '.',
    };
  }

  private async request(url: string, headers: Record<string, string>, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async probePinecone(
    connection: VectorStoreConnection, fingerprint: string,
  ): Promise<VectorStoreReport> {
    const headers = {
      'Api-Key': connection.apiKey,
      'X-Pinecone-API-Version': '2025-04',
      accept: 'application/json',
    };
    const start = Date.now();
    let response: Response;
    try {
      response = await this.request(`${connection.baseUrl}/indexes`, headers);
    } catch (err) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.unreachable('pinecone', err instanceof Error ? err.message : String(err)),
      };
    }
    const latencyMs = Date.now() - start;

    if (response.status === 401 || response.status === 403) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.rejectedKey('pinecone', response.status, fingerprint, latencyMs),
      };
    }
    if (!response.ok) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.nonAuthFailure('pinecone', response.status, fingerprint, latencyMs),
      };
    }

    // `body.indexes` missing or not an array is a malformed response, not a
    // report of zero indexes — those two cases must not collapse into the
    // same 'fail: no indexes' outcome (see `malformedBody`).
    let entries: PineconeIndexEntry[] = [];
    let bodyMalformed = false;
    try {
      const body = (await response.json()) as { indexes?: unknown };
      if (Array.isArray(body.indexes)) {
        entries = body.indexes as PineconeIndexEntry[];
      } else {
        bodyMalformed = true;
      }
    } catch {
      bodyMalformed = true;
    }

    const indexes = await Promise.all(
      entries.map(async (entry): Promise<VectorStoreIndexInfo> => ({
        name: typeof entry.name === 'string' ? entry.name : 'unnamed',
        ready: entry.status?.ready === true,
        dimension: asNumber(entry.dimension),
        recordCount: typeof entry.host === 'string'
          ? await this.pineconeRecordCount(entry.host, connection.apiKey)
          : null,
      })),
    );

    return {
      provider: connection.provider,
      keyFingerprint: fingerprint,
      indexes,
      checks: [
        { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `pinecone answered in ${latencyMs}ms.` },
        {
          checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
          detail: `pinecone accepted the key ${fingerprint}.`,
        },
        bodyMalformed ? this.malformedBody('pinecone') : this.indexStatusCheck('pinecone', indexes),
      ],
    };
  }

  /**
   * Record count lives on the data plane, not the control plane. A failure
   * here leaves the count null (honest unreported) and never downgrades the
   * index_status check, which is a control-plane fact.
   */
  private async pineconeRecordCount(host: string, apiKey: string): Promise<number | null> {
    try {
      const response = await this.request(
        `https://${host}/describe_index_stats`,
        { 'Api-Key': apiKey, 'content-type': 'application/json' },
        { method: 'POST', body: '{}' },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { totalVectorCount?: unknown };
      return asNumber(body.totalVectorCount);
    } catch {
      return null;
    }
  }

  private async probeUpstash(
    connection: VectorStoreConnection, fingerprint: string,
  ): Promise<VectorStoreReport> {
    const headers = {
      Authorization: `Bearer ${connection.apiKey}`,
      accept: 'application/json',
    };
    const start = Date.now();
    let response: Response;
    try {
      response = await this.request(`${connection.baseUrl}/info`, headers);
    } catch (err) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.unreachable('upstash-vector', err instanceof Error ? err.message : String(err)),
      };
    }
    const latencyMs = Date.now() - start;

    if (response.status === 401 || response.status === 403) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.rejectedKey('upstash-vector', response.status, fingerprint, latencyMs),
      };
    }
    if (!response.ok) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.nonAuthFailure('upstash-vector', response.status, fingerprint, latencyMs),
      };
    }

    // A missing or non-object `result` is a malformed response, not "index
    // ready with unreported stats" — fabricating a synthetic ready index here
    // would turn an un-evaluable response into a false 'pass' (see
    // `malformedBody`).
    let result: { vectorCount?: unknown; dimension?: unknown } | undefined;
    try {
      const body = (await response.json()) as { result?: unknown };
      if (body.result !== null && typeof body.result === 'object') {
        result = body.result as { vectorCount?: unknown; dimension?: unknown };
      }
    } catch {
      result = undefined;
    }

    if (result === undefined) {
      return {
        provider: connection.provider,
        keyFingerprint: fingerprint,
        indexes: [],
        checks: [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `upstash-vector answered in ${latencyMs}ms.` },
          {
            checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
            detail: `upstash-vector accepted the token ${fingerprint}.`,
          },
          this.malformedBody('upstash-vector'),
        ],
      };
    }

    // One REST URL addresses exactly one Upstash index; the host is its name.
    const name = connection.baseUrl.replace(/^https?:\/\//, '');
    const indexes: VectorStoreIndexInfo[] = [{
      name,
      ready: true,
      dimension: asNumber(result.dimension),
      recordCount: asNumber(result.vectorCount),
    }];

    return {
      provider: connection.provider,
      keyFingerprint: fingerprint,
      indexes,
      checks: [
        { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `upstash-vector answered in ${latencyMs}ms.` },
        {
          checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
          detail: `upstash-vector accepted the token ${fingerprint}.`,
        },
        this.indexStatusCheck('upstash-vector', indexes),
      ],
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported vector-store command type: ${command.type}`);
    }
    if (command.operation === 'query_vector_stores') {
      return { reports: await this.queryVectorStores() };
    }
    throw new Error(`Unsupported vector-store operation: ${command.operation}`);
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const reports = await this.queryVectorStores();

    if (statement.includes('auth_valid')) {
      // `Array.prototype.every` is vacuously true on an empty array — a
      // client with zero configured providers must not satisfy `auth_valid`,
      // since nothing was actually verified.
      const allValid = reports.length > 0 && reports.every(
        (r) => r.checks.find((c) => c.checkId === VECTOR_STORE_CHECK_IDS.authValid)?.status === 'pass',
      );
      return compareCheckValue(allValid ? 'pass' : 'fail', check.expect.operator, check.expect.value);
    }
    if (statement.includes('ready_index_count')) {
      const count = reports.reduce((sum, r) => sum + r.indexes.filter((i) => i.ready).length, 0);
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    return false;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [{
      id: 'vector-store-rest-reader',
      kind: 'capability_provider',
      name: 'Vector Store REST Reader',
      maturity: 'live_validated',
      capabilities: ['vectorstore.index.read'],
      executionContexts: ['vector_store_read'],
      targetKinds: ['vector-store'],
      commandTypes: ['structured_command'],
      supportsDryRun: true,
      supportsExecute: true,
    }];
  }

  async close(): Promise<void> {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/vector-store-live-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Decide on sharing provider-check plumbing with PR 3 (the spec asks explicitly)**

The spec says to extract the common provider-check plumbing from PR 3's `llm-provider` into a small shared module **only if the duplication exceeds ~100 lines**; otherwise keep them separate and revisit.

Note that two of the four candidates are already shared rather than duplicated: this plan **imports** `fingerprintKey` and (in Task 7) `OfflineGate`/`defaultOfflineGate` from the `llm-provider` module instead of copying them. So measure only what is genuinely duplicated:

```bash
grep -c "" src/agent/llm-provider/live-client.ts src/agent/vector-store/live-client.ts
```

Read `src/agent/llm-provider/live-client.ts` and count the lines duplicated across these four candidates:

| Candidate | Currently |
|---|---|
| `fingerprintKey(key: string): string` | already imported from `llm-provider/provider-table.js` — 0 duplicated lines |
| `OfflineGate` / `defaultOfflineGate` | already imported from `llm-provider/offline-gate.js` — 0 duplicated lines |
| the timeout-wrapped fetch (`VectorStoreLiveClient#request`) | duplicated |
| HTTP status classification (401/403 vs other non-2xx vs network error) | duplicated |

If the total is **under ~100 lines**, change nothing and record the measured count in the commit message body. That is the spec's default outcome, and premature extraction across two agents with genuinely different response shapes costs more than it saves.

If it exceeds ~100 lines, create `src/agent/provider-common.ts` (mirroring how `src/agent/pg-common.ts` already shares pool helpers between the PostgreSQL agents) and move exactly these, with these signatures:

```typescript
/** Timeout-bounded GET/POST against a provider REST endpoint. Never throws for a non-2xx. */
export async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response>;

/** How a provider's HTTP response should be read, before any body parsing. */
export type ProviderOutcome =
  | { kind: 'unreachable'; message: string }
  | { kind: 'auth_rejected'; status: number }
  | { kind: 'other_error'; status: number }
  | { kind: 'ok'; response: Response };

/** 401/403 ⇒ auth_rejected; any other non-2xx ⇒ other_error; 2xx ⇒ ok. */
export function classifyProviderResponse(response: Response): ProviderOutcome;

/** Re-exported so provider agents take one import, not three. */
export { fingerprintKey } from './llm-provider/provider-table.js';
export { defaultOfflineGate, type OfflineGate, type ObserverOffline } from './llm-provider/offline-gate.js';
```

Then update both live clients to import from it and re-run both live-client test files. Moving `fingerprintKey` and the offline gate into `provider-common.ts` is a re-export change only — no call site in this plan changes, because they were never copied.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/agent/vector-store/live-client.ts src/__tests__/vector-store-live-client.test.ts
git commit -m "feat(vector-store): add fetch-based live client for pinecone and upstash vector"
```

(If Step 5 led to an extraction, add `src/agent/provider-common.ts`, `src/agent/llm-provider/live-client.ts`, and `src/__tests__/llm-provider-live-client.test.ts` to the same commit.)

---

## Task 7: Vector-store agent, manifest, capability, registration

**Files:**
- Create: `src/agent/vector-store/manifest.ts`
- Create: `src/agent/vector-store/agent.ts`
- Create: `src/agent/vector-store/registration.ts`
- Modify: `src/config/builtin-agents.ts`
- Modify: `src/framework/capability-registry.ts` (append after the IaC Drift block, currently ending at line 555)
- Modify: `src/framework/signal-explanations.ts` (new `EXPLANATIONS` entry)
- Modify: `src/__tests__/explanation-coverage.test.ts` (`REPRESENTATIVE_SOURCES`)
- Modify (only if PR 3 did not already): `packages/agent-sdk/src/types/health.ts`, `src/cli/output.ts:437-448`, `src/cli/commands/scan.ts:230`
- Test: `src/__tests__/vector-store-agent.test.ts`

**Interfaces:**
- Consumes: `VectorStoreBackend`/`VectorStoreReport`/`VectorStoreCheck`/`VECTOR_STORE_CHECK_IDS` (Task 5), `VectorStoreSimulator` (Task 5), `VectorStoreLiveClient` + `DEFAULT_TIMEOUT_MS` (Task 6), `buildVectorStoreConnections` (Task 5). From PR 3: `type OfflineGate = () => Promise<ObserverOffline | null>`, `const defaultOfflineGate: OfflineGate`, and `interface ObserverOffline { verdict: 'local' | 'network'; explanation: string }` — all from `src/agent/llm-provider/offline-gate.js`. Framework helpers with their current signatures:
  - `buildHealthAssessment(opts: { status; signals; confidence; summary: Record<'healthy'|'recovering'|'unhealthy', string>; actions: Record<'healthy'|'recovering'|'unhealthy', string[]> }): HealthAssessment`
  - `createPlanEnvelope(opts: { planIdSuffix; agentName; agentVersion; scenario; estimatedDuration; summary; sequence?; supersedes? }): Pick<RecoveryPlan, 'apiVersion' | 'kind' | 'metadata'>`
  - `createLiveRegistration(opts: { kind; name; manifest; loadAgent; loadSimulator; buildLiveBackend }): AgentRegistration` — routes `host === 'simulator'` (or no `primary`) to the simulator and everything else to the live backend.
- Produces:
  - `vectorStoreManifest: AgentManifest` (`kind: 'vector-store'`, `maxRiskLevel: 'routine'`, `maturity: 'simulator_only'`)
  - `VectorStoreAgent implements RecoveryAgent`, constructor `(backend?: VectorStoreBackend, offlineGate?: OfflineGate)`
  - `vectorStoreRegistration: AgentRegistration` with `kind: 'vector-store'`, `name: 'vector-store-diagnosis'`
  - Signal sources emitted: `vector_store_reachable`, `vector_store_auth`, `vector_store_index` — each carrying the matching `checkId`
  - `dominantCheckId` and `ScanFinding.checkId` (verified or added in Step 1)

- [ ] **Step 1: Verify the PR 3 `checkId` plumbing exists (the agent depends on it)**

Run:

```bash
grep -n "dominantCheckId" src/cli/commands/scan.ts
grep -n "checkId" packages/agent-sdk/src/types/health.ts src/cli/output.ts
```

Expected (PR 3's Task 11 merged): `dominantCheckId` exported from `scan.ts` and applied in `checkTargetHealth`; `checkId?: string` on `HealthSignal`; both `ScanFinding.checkId?` and `ScanFinding.signals[].checkId?` in `output.ts`.

The `dominantCheckId` grep is the load-bearing one. The per-signal field alone is not enough: PR 5 reads the **finding-level** `finding.checkId` to anchor guidance, so shipping only the signal field leaves PR 5 reading `undefined`.

If any part is missing, add PR 3's Task 11 changes exactly as written there:

`packages/agent-sdk/src/types/health.ts`, inside `interface HealthSignal` after `entityId?: string;`:

```typescript
  /** Stable check identifier (e.g. 'vector-store.auth_valid') that guidance anchors to. */
  checkId?: string;
```

`src/cli/output.ts` — two **additive** edits to `ScanFinding`. Do not retype the interface: PR 1 added `bestEffort?: boolean` and PR 2 added `possiblyObserverCaused?: boolean`, and both must survive.

```typescript
  signals: Array<{ status: string; detail: string; source?: string; checkId?: string }>;
```

```typescript
  /** Stable id of the check behind the dominant signal (e.g. 'vector-store.auth_valid'). Present only for agents that emit check ids. */
  checkId?: string;
```

`src/cli/commands/scan.ts` — add the helper next to `enrichScanFinding`:

```typescript
/**
 * The check id a finding should carry: the first failing signal's, falling
 * back to the first signal that has one. Mirrors how enrichScanFinding picks
 * the dominant signal for the plain-language explanation, so the explanation
 * and the check id always describe the same signal.
 */
export function dominantCheckId(
  signals: Array<{ status: string; checkId?: string }>,
): string | undefined {
  const failing = signals.find((s) => s.status !== 'healthy' && s.checkId !== undefined);
  if (failing) return failing.checkId;
  return signals.find((s) => s.checkId !== undefined)?.checkId;
}
```

and in `checkTargetHealth`, change the signal mapping and add the finding-level id (success path only — the catch path has no signals):

```typescript
    const signals = health.signals.map((s) => ({
      status: s.status,
      detail: s.detail,
      source: s.source,
      ...(s.checkId !== undefined ? { checkId: s.checkId } : {}),
    }));
    const checkId = dominantCheckId(signals);

    return {
      kind: target.kind,
      health,
      agentAvailable,
      finding: {
        service: `${target.kind} (${target.name})`,
        status: health.status,
        summary: health.summary,
        confidence: health.confidence,
        escalationLevel: health.status === 'healthy' ? 1 : 2,
        signals,
        ...(checkId !== undefined ? { checkId } : {}),
      },
    };
```

Then run `pnpm run typecheck` to confirm the SDK rebuild picked up the field (`typecheck` builds `@crisismode/agent-sdk` first).

- [ ] **Step 2: Verify `crisismode triage` is a real command before quoting it**

The offline copy written in Step 8 tells the user to run `crisismode triage`. PR 2 ships that command ahead of this PR, but copy naming a command that does not exist is worse than no copy:

```bash
grep -n "triage" src/cli/index.ts
```

Expected: a registered `triage` subcommand. If it is absent, **stop and report** rather than shipping the string — do not silently reword it, because its absence means PR 2 landed differently and the `OfflineGate` this task depends on may not exist either.

- [ ] **Step 3: Write the failing agent test**

Create `src/__tests__/vector-store-agent.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi } from 'vitest';
import { VectorStoreAgent } from '../agent/vector-store/agent.js';
import { VectorStoreSimulator, SIMULATOR_FIXTURE_KEY } from '../agent/vector-store/simulator.js';
import { vectorStoreManifest } from '../agent/vector-store/manifest.js';
import { vectorStoreRegistration } from '../agent/vector-store/registration.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { assembleContext } from '../framework/context.js';
import { validateAgent } from '../framework/agent-test-harness.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';
import { VECTOR_STORE_CHECK_IDS } from '../agent/vector-store/check-ids.js';
import type { OfflineGate } from '../agent/llm-provider/offline-gate.js';
import type { AgentContext } from '../types/agent-context.js';

function context(): AgentContext {
  return assembleContext(
    {
      type: 'health_check',
      source: 'cli-scan',
      payload: { alertname: 'vector-storeScanCheck', instance: 'derived-vector-store', severity: 'info' },
      receivedAt: new Date().toISOString(),
    },
    vectorStoreManifest,
  );
}

/** Default gate returns null — "triage saw nothing", so the checks run. */
function agentWith(scenario: string, gate: OfflineGate = async () => null): VectorStoreAgent {
  const backend = new VectorStoreSimulator();
  backend.transition(scenario);
  return new VectorStoreAgent(backend, gate);
}

describe('vectorStoreManifest', () => {
  it('is a routine, read-only agent', () => {
    expect(vectorStoreManifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(vectorStoreManifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(vectorStoreManifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares a maturity value (PR 1 visibility contract)', () => {
    expect(vectorStoreManifest.metadata.plugin.maturity).toBe('simulator_only');
  });

  it('declares only read execution contexts', () => {
    for (const ec of vectorStoreManifest.spec.executionContexts) {
      expect(ec.privilege).toBe('read');
    }
  });

  it('uses a capability registered in the global registry', () => {
    expect(isKnownCapability('vectorstore.index.read')).toBe(true);
  });
});

describe('signal explanations', () => {
  // explanation-coverage.test.ts enforces this across every built-in agent;
  // asserting it here too means the agent's own test fails first, next to the
  // sources it names, rather than in a file the implementer is not editing.
  it('every emitted signal source resolves to a knowledge-map entry', () => {
    for (const source of ['vector_store_reachable', 'vector_store_auth', 'vector_store_index']) {
      expect(explainSource(source), `no EXPLANATIONS entry matches '${source}'`).toBeDefined();
    }
  });
});

describe('VectorStoreAgent.assessHealth', () => {
  it('healthy when every check passes', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.status).toBe('healthy');
  });

  it('unhealthy when the key is rejected', async () => {
    const health = await agentWith('bad_key').assessHealth(context());
    expect(health.status).toBe('unhealthy');
    expect(health.summary).toContain('pinecone');
  });

  it('unhealthy when the store is unreachable', async () => {
    const health = await agentWith('unreachable').assessHealth(context());
    expect(health.status).toBe('unhealthy');
  });

  it('recovering when an index exists but is not ready', async () => {
    const health = await agentWith('index_not_ready').assessHealth(context());
    expect(health.status).toBe('recovering');
  });

  it('stamps every signal with its checkId', async () => {
    const health = await agentWith('healthy').assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      VECTOR_STORE_CHECK_IDS.reachable,
      VECTOR_STORE_CHECK_IDS.authValid,
      VECTOR_STORE_CHECK_IDS.indexStatus,
    ]);
  });

  it('never leaks key material into health output', async () => {
    const health = await agentWith('bad_key').assessHealth(context());
    expect(JSON.stringify(health)).not.toContain(SIMULATOR_FIXTURE_KEY);
  });
});

describe('VectorStoreAgent offline deferral', () => {
  const localVerdict: OfflineGate = async () => ({
    verdict: 'local',
    explanation: 'this machine has no network interface with an address',
  });

  it("reports unknown and repeats triage's explanation rather than 'the store is down'", async () => {
    const health = await agentWith('unreachable', localVerdict).assessHealth(context());
    expect(health.status).toBe('unknown');
    for (const signal of health.signals) {
      expect(signal.status).toBe('unknown');
      expect(signal.detail).toContain('this machine has no network interface with an address');
    }
    expect(health.summary).not.toContain('unavailable');
  });

  it('still carries every checkId when deferring, so guidance still resolves', async () => {
    const health = await agentWith('unreachable', localVerdict).assessHealth(context());
    expect(health.signals.map((s) => s.checkId)).toEqual([
      VECTOR_STORE_CHECK_IDS.reachable,
      VECTOR_STORE_CHECK_IDS.authValid,
      VECTOR_STORE_CHECK_IDS.indexStatus,
    ]);
  });

  it('does not touch the backend when the gate fires', async () => {
    const backend = new VectorStoreSimulator();
    const probe = vi.spyOn(backend, 'queryVectorStores');
    await new VectorStoreAgent(backend, localVerdict).assessHealth(context());
    expect(probe).not.toHaveBeenCalled();
  });

  it('a null verdict is not evidence of being offline — the checks run', async () => {
    const health = await agentWith('healthy', async () => null).assessHealth(context());
    expect(health.status).toBe('healthy');
  });
});

describe('VectorStoreAgent.diagnose', () => {
  it('identifies a rejected key with a critical finding', async () => {
    const diagnosis = await agentWith('bad_key').diagnose(context());
    expect(diagnosis.status).toBe('identified');
    expect(diagnosis.scenario).toBe('auth_rejected');
    expect(diagnosis.findings.some((f) => f.severity === 'critical')).toBe(true);
  });

  it('is inconclusive when everything is healthy', async () => {
    const diagnosis = await agentWith('healthy').diagnose(context());
    expect(diagnosis.status).toBe('inconclusive');
  });
});

describe('VectorStoreAgent.plan', () => {
  it('produces a read-only plan with a rollback strategy and no mutations', async () => {
    const agent = agentWith('bad_key');
    const ctx = context();
    const plan = await agent.plan(ctx, await agent.diagnose(ctx));
    expect(plan.rollbackStrategy).toBeDefined();
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    expect(new Set(plan.steps.map((s) => s.stepId)).size).toBe(plan.steps.length);
  });
});

describe('agent test harness', () => {
  it('passes contract validation', async () => {
    const result = await validateAgent(agentWith('bad_key'), context());
    expect(result.passed).toBe(true);
  });
});

describe('registration', () => {
  it('is registered as a built-in agent', () => {
    expect(builtinAgents.map((r) => r.kind)).toContain('vector-store');
  });

  it("name matches the manifest's metadata name", () => {
    expect(vectorStoreRegistration.name).toBe(vectorStoreManifest.metadata.name);
  });

  it('a simulator target gets the simulator backend', async () => {
    const instance = await vectorStoreRegistration.createAgent({
      name: 'sim', kind: 'vector-store', primary: { host: 'simulator', port: 0 },
    } as never);
    expect(instance.backend).toBeInstanceOf(VectorStoreSimulator);
    await instance.backend.close();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run src/__tests__/vector-store-agent.test.ts`
Expected: FAIL — cannot resolve `../agent/vector-store/agent.js`.

- [ ] **Step 5: Register the capability**

In `src/framework/capability-registry.ts`, append to the `CAPABILITIES` array (after the `iac.state.read` entry that currently ends the array at line 555):

```typescript
  // ── Vector Stores ──
  {
    id: 'vectorstore.index.read',
    actionKind: 'read',
    description: 'Read managed vector-store index metadata: reachability, credential validity, and index readiness.',
    targetKinds: ['vector-store'],
    manualFallback: "Open the provider console and confirm the index exists, is ready, and the API key is active.",
  },
```

- [ ] **Step 6: Add the signal-explanation entry and the coverage roster**

`src/__tests__/explanation-coverage.test.ts` iterates `builtinAgents` and fails for any kind missing from `REPRESENTATIVE_SOURCES`, then fails again for any listed source that no `EXPLANATIONS` regex matches. Registering the agent in Step 9 without both edits breaks that test — so make them now.

In `src/framework/signal-explanations.ts`, add this to the `EXPLANATIONS` array. Order matters (most-specific first); put it next to the other agent-specific entries, before the generic `/backup|snapshot|pitr|restore/` catch-all, following the `/^iac_/` precedent at lines 105-108:

```typescript
  {
    match: /^vector_store_/,
    explanation: 'A managed vector store (Pinecone, Upstash Vector) holds the embeddings your app searches to answer questions. If it is unreachable, the key is rejected, or the index is missing or still building, retrieval returns nothing — the app usually stays up and quietly answers without its own data.',
    learnMoreUrl: 'https://www.pinecone.io/learn/vector-database/',
  },
```

In `src/__tests__/explanation-coverage.test.ts`, add to `REPRESENTATIVE_SOURCES` next to the other entries:

```typescript
  'vector-store': ['vector_store_reachable', 'vector_store_auth', 'vector_store_index'],
```

These three strings must stay identical to the `SIGNAL_SOURCE` values in Step 8's agent — that is the whole coupling the coverage test exists to catch.

- [ ] **Step 7: Write the manifest**

Create `src/agent/vector-store/manifest.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const vectorStoreManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'vector-store-diagnosis',
    version: '1.0.0',
    description:
      'Checks managed vector stores (Pinecone, Upstash Vector) for reachability, credential validity, and ' +
      'index readiness. Read-only: it reports and suggests, never mutates an index.',
    ...defaultManifestMetadata(),
    tags: ['vector', 'rag', 'retrieval', 'pinecone', 'upstash'],
    plugin: {
      id: 'vector-store.domain-pack',
      kind: 'domain_pack',
      // Promoted to live_validated only after real-account validation (Task 10).
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'vector-store',
        versionConstraint: '*',
        components: ['control-plane', 'index'],
      },
    ],
    triggerConditions: [
      { type: 'health_check', name: 'vector_store_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated vector-store check' },
    ],
    failureScenarios: ['unreachable', 'auth_rejected', 'index_not_ready', 'no_indexes'],
    executionContexts: [
      {
        name: 'vector_store_read',
        type: 'api_call',
        privilege: 'read',
        target: 'vector-store',
        allowedOperations: ['query_vector_stores'],
        capabilities: ['vectorstore.index.read'],
      },
    ],
    observabilityDependencies: {
      required: ['vector_store_control_plane'],
      optional: ['vector_store_index_stats'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
```

- [ ] **Step 8: Write the agent**

Create `src/agent/vector-store/agent.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisFinding, DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { vectorStoreManifest } from './manifest.js';
import type { VectorStoreBackend, VectorStoreCheck, VectorStoreReport } from './backend.js';
import { VECTOR_STORE_CHECK_IDS, type VectorStoreCheckId } from './check-ids.js';
import { VectorStoreSimulator } from './simulator.js';
import { defaultOfflineGate, type OfflineGate } from '../llm-provider/offline-gate.js';

/**
 * Signal source names — the knowledge map (signal-explanations.ts) and the
 * correlation layer key on these. They are mirrored in
 * explanation-coverage.test.ts's REPRESENTATIVE_SOURCES; changing one without
 * the other fails that test.
 */
const SIGNAL_SOURCE: Record<VectorStoreCheckId, string> = {
  [VECTOR_STORE_CHECK_IDS.reachable]: 'vector_store_reachable',
  [VECTOR_STORE_CHECK_IDS.authValid]: 'vector_store_auth',
  [VECTOR_STORE_CHECK_IDS.indexStatus]: 'vector_store_index',
};

/** Check order in emitted signals — stable, so dominantCheckId is predictable. */
const CHECK_ORDER: VectorStoreCheckId[] = [
  VECTOR_STORE_CHECK_IDS.reachable,
  VECTOR_STORE_CHECK_IDS.authValid,
  VECTOR_STORE_CHECK_IDS.indexStatus,
];

/** Total over the check ids, so lookups need no fallback branch. */
const FIX_HINT: Record<VectorStoreCheckId, string> = {
  [VECTOR_STORE_CHECK_IDS.reachable]:
    'Confirm the provider is up on its status page, then re-run. If only this store is unreachable, the outage is on the provider side.',
  [VECTOR_STORE_CHECK_IDS.authValid]:
    'Rotate or re-issue the API key in the provider console and update the environment variable — a rejected key takes retrieval down entirely.',
  [VECTOR_STORE_CHECK_IDS.indexStatus]:
    'Open the provider console: an index that is missing or still initializing means every retrieval query returns nothing.',
};

/** A check that is absent was never run — that is not a failure. */
function failed(check: VectorStoreCheck | undefined): boolean {
  return check?.status === 'fail';
}

function checkOf(report: VectorStoreReport, checkId: string): VectorStoreCheck | undefined {
  return report.checks.find((c) => c.checkId === checkId);
}

export class VectorStoreAgent implements RecoveryAgent {
  manifest = vectorStoreManifest;
  backend: VectorStoreBackend;
  private readonly offlineGate: OfflineGate;

  constructor(backend?: VectorStoreBackend, offlineGate: OfflineGate = defaultOfflineGate) {
    this.backend = backend ?? new VectorStoreSimulator();
    this.offlineGate = offlineGate;
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();

    // Every check this agent runs is a network check, so a localised offline
    // verdict makes all of them unanswerable. Report that honestly and skip
    // the probe rather than blaming the provider for the operator's wifi.
    // The gate reads PR 2's CACHED triage report — it never probes.
    const offline = await this.offlineGate();
    if (offline) {
      // Built directly rather than via buildHealthAssessment: that helper keys
      // its summary/actions maps on healthy|recovering|unhealthy and has no
      // 'unknown' arm, so routing through it would yield "Status: unknown".
      const detail =
        `cannot verify while offline — ${offline.explanation}. ` +
        'Run `crisismode triage` for the full localization.';
      return {
        status: 'unknown',
        confidence: 0,
        summary:
          `Vector stores could not be checked: the ${offline.verdict === 'local' ? 'machine' : 'network'} ` +
          `is offline. ${offline.explanation}.`,
        observedAt,
        signals: CHECK_ORDER.map((checkId) => ({
          source: SIGNAL_SOURCE[checkId],
          checkId,
          status: 'unknown' as const,
          detail,
          observedAt,
        })),
        recommendedActions: [
          'Fix the connectivity problem triage identified, then re-run — the vector stores were never contacted.',
        ],
      };
    }

    const reports = await this.backend.queryVectorStores();

    const signals: HealthSignal[] = [];
    for (const report of reports) {
      for (const check of report.checks) {
        signals.push({
          source: SIGNAL_SOURCE[check.checkId],
          checkId: check.checkId,
          status: check.status === 'pass' ? 'healthy' : check.status === 'fail' ? 'critical' : 'unknown',
          detail: `${report.provider}: ${check.detail}`,
          observedAt,
          entityId: report.provider,
        });
      }
    }

    const down = reports.filter(
      (r) => failed(checkOf(r, VECTOR_STORE_CHECK_IDS.reachable)) || failed(checkOf(r, VECTOR_STORE_CHECK_IDS.authValid)),
    );
    const degraded = reports.filter((r) => failed(checkOf(r, VECTOR_STORE_CHECK_IDS.indexStatus)));
    const allUnknown = signals.length > 0 && signals.every((s) => s.status === 'unknown');

    let status: HealthStatus;
    if (reports.length === 0 || allUnknown) status = 'unknown';
    else if (down.length > 0) status = 'unhealthy';
    else if (degraded.length > 0) status = 'recovering';
    else status = 'healthy';

    const names = reports.map((r) => r.provider).join(', ');
    return buildHealthAssessment({
      status,
      signals,
      confidence: status === 'unknown' ? 0.2 : 0.9,
      summary: {
        healthy: `Vector stores reachable and authenticated: ${names}.`,
        recovering: `Vector store index not ready: ${degraded.map((r) => r.provider).join(', ')}.`,
        unhealthy: `Vector store unavailable: ${down.map((r) => r.provider).join(', ')} — retrieval is failing.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring vector-store reachability and index readiness.'],
        recovering: ['Check the index state in the provider console; retrieval returns nothing until it is ready.'],
        unhealthy: ['Verify the API key and the provider status page — RAG features are down while this persists.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const reports = await this.backend.queryVectorStores();
    const findings: DiagnosisFinding[] = [];
    let scenario: string | null = null;

    for (const report of reports) {
      for (const check of report.checks) {
        const severity = check.status === 'fail' ? 'critical' : check.status === 'unknown' ? 'warning' : 'info';
        findings.push({
          source: SIGNAL_SOURCE[check.checkId],
          observation: `${report.provider} (${report.keyFingerprint}): ${check.detail}`,
          severity,
          data: { provider: report.provider, checkId: check.checkId, status: check.status },
          explanation: FIX_HINT[check.checkId],
        });
      }
      if (scenario === null) {
        if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.reachable))) {
          scenario = 'unreachable';
        } else if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.authValid))) {
          scenario = 'auth_rejected';
        } else if (failed(checkOf(report, VECTOR_STORE_CHECK_IDS.indexStatus))) {
          scenario = report.indexes.length === 0 ? 'no_indexes' : 'index_not_ready';
        }
      }
    }

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence: scenario === null ? 0.6 : 0.9,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture current vector-store state',
        executionContext: 'vector_store_read',
        target: 'vector-store',
        command: { type: 'structured_command', operation: 'query_vector_stores', parameters: {} },
        outputCapture: {
          name: 'current_vector_store_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
    ];

    let sequence = 2;
    for (const finding of diagnosis.findings) {
      if (finding.severity !== 'critical') continue;
      const checkId = String(finding.data?.['checkId'] ?? '') as VectorStoreCheckId;
      steps.push({
        stepId: `step-${String(sequence).padStart(3, '0')}`,
        type: 'human_notification',
        name: `Vector store needs attention: ${String(finding.data?.['provider'] ?? 'unknown')}`,
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: finding.observation,
          detail: FIX_HINT[checkId] ?? 'Review the vector store in the provider console.',
          contextReferences: ['current_vector_store_state'],
          actionRequired: true,
        },
        channel: 'auto',
      });
      sequence += 1;
    }

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'vector-store',
        agentName: 'vector-store-diagnosis',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'healthy',
        estimatedDuration: 'PT5M',
        summary:
          `Vector-store findings: ${diagnosis.scenario ?? 'no issues detected'}. ` +
          'No mutations performed — operator action required.',
      }),
      impact: {
        affectedSystems: [],
        affectedServices: ['retrieval'],
        estimatedUserImpact: 'No action is taken by CrisisMode — suggestions only.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description:
          'Read-only plan: CrisisMode executes nothing that needs rolling back. Every remediation is operator-run in the provider console.',
      },
    };
  }

  replan = defaultReplan;
}
```

- [ ] **Step 9: Write the registration and register it**

Create `src/agent/vector-store/registration.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { vectorStoreManifest } from './manifest.js';
import { buildVectorStoreConnections, VECTOR_STORE_PROVIDERS } from './provider-table.js';

export const vectorStoreRegistration = createLiveRegistration({
  kind: 'vector-store',
  name: 'vector-store-diagnosis',
  manifest: vectorStoreManifest,
  loadAgent: async () => {
    const { VectorStoreAgent } = await import('./agent.js');
    return VectorStoreAgent as never;
  },
  loadSimulator: async () => {
    const { VectorStoreSimulator } = await import('./simulator.js');
    return VectorStoreSimulator as never;
  },
  buildLiveBackend: async () => {
    const connections = buildVectorStoreConnections(process.env);
    if (connections.length === 0) {
      // Fail loud: silently simulating would claim coverage that doesn't exist.
      const checked = VECTOR_STORE_PROVIDERS.flatMap((p) =>
        [p.keyEnvVar, ...(p.urlEnvVar ? [p.urlEnvVar] : [])]).join(', ');
      throw new Error(
        `No vector-store credentials found in environment (checked ${checked}). ` +
          'Upstash Vector needs both UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN.',
      );
    }
    const { VectorStoreLiveClient, DEFAULT_TIMEOUT_MS } = await import('./live-client.js');
    // Timeout set explicitly at the wiring point, not left to the default:
    // scan's per-agent budget is what makes this number correct, and that
    // constraint is invisible from inside the client.
    return new VectorStoreLiveClient({ connections, timeoutMs: DEFAULT_TIMEOUT_MS });
  },
});
```

In `src/config/builtin-agents.ts`, add the import next to the other AI-application agents:

```typescript
import { vectorStoreRegistration } from '../agent/vector-store/registration.js';
```

and add the entry at the end of the "AI application recovery agents" group in `builtinAgents`:

```typescript
  configDriftRegistration,
  vectorStoreRegistration,
];
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/vector-store-agent.test.ts src/__tests__/explanation-coverage.test.ts`
Expected: PASS. `explanation-coverage.test.ts` is the one that fails loudest if Step 6 was skipped or if a `SIGNAL_SOURCE` string drifted from the roster.

- [ ] **Step 11: Run the full suite (registry/manifest enforcement tests included)**

Run: `pnpm test`
Expected: all green. Three known places assert agent rosters: `explanation-coverage.test.ts` (handled in Step 6), any test asserting a built-in agent count, and `src/__tests__/safety-invariants.test.ts`, which registers extra capabilities for agents missing from the global registry — the `vectorstore.index.read` capability added in Step 5 means no entry is needed there.

- [ ] **Step 12: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

- [ ] **Step 13: Commit**

```bash
git add src/agent/vector-store/manifest.ts src/agent/vector-store/agent.ts \
  src/agent/vector-store/registration.ts src/config/builtin-agents.ts \
  src/framework/capability-registry.ts src/framework/signal-explanations.ts \
  src/__tests__/vector-store-agent.test.ts src/__tests__/explanation-coverage.test.ts \
  packages/agent-sdk/src/types/health.ts src/cli/output.ts src/cli/commands/scan.ts
git commit -m "feat(vector-store): add read-only vector-store agent, manifest, and registration"
```

(If Step 1 found the `checkId` plumbing already present, drop those last three paths from the `git add`.)

---

## Task 8: Autodiscovery derives the vector-store target

**Files:**
- Modify: `src/cli/autodiscovery.ts` (`deriveGatedTargets`)
- Test: `src/__tests__/autodiscovery-vector-store.test.ts`

**Anchor by content, not by line number.** PR 3 rewrites this file's import block and replaces the whole ai-provider derivation with per-provider `llm-provider` targets, so any line number or "after the ai-provider block" reference from before that merge is stale. Locate the insertion point by searching for the `// application-config:` comment inside `deriveGatedTargets`.

**Interfaces:**
- Consumes: `VECTOR_STORE_ENV_VARS`, `buildVectorStoreConnections` (Task 5); `deriveGatedTargets(appStack: AppStackInfo, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ targets: TargetConfig[]; notes: Record<string, string> }>` (existing, exported from `src/cli/autodiscovery.ts:335`). The `checkId` plumbing verified in Task 7 Step 1 is what makes Step 7's CLI check meaningful.
- Produces: a `TargetConfig` named `derived-vector-store`, `kind: 'vector-store'`, `primary: { host: 'auto', port: 0 }`, with a note naming the env var (never its value).

- [ ] **Step 1: Write the failing autodiscovery test**

Create `src/__tests__/autodiscovery-vector-store.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { deriveGatedTargets } from '../cli/autodiscovery.js';
import type { AppStackInfo } from '../cli/autodiscovery.js';

const EMPTY_STACK = { framework: null, dependencies: [] } as unknown as AppStackInfo;

/** cwd is a directory with no .env.example, so unrelated derivations stay quiet. */
const CWD = '/nonexistent-crisismode-test-dir';

describe('deriveGatedTargets — vector-store', () => {
  it('derives a vector-store target from PINECONE_API_KEY', async () => {
    const { targets, notes } = await deriveGatedTargets(EMPTY_STACK, CWD, { PINECONE_API_KEY: 'pc-secret' });
    const target = targets.find((t) => t.kind === 'vector-store');
    expect(target?.name).toBe('derived-vector-store');
    expect(target?.primary).toEqual({ host: 'auto', port: 0 });
    expect(notes['derived-vector-store']).toBe('from PINECONE_API_KEY');
  });

  it('derives from the upstash env vars too', async () => {
    const { notes } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(notes['derived-vector-store']).toContain('UPSTASH_VECTOR_REST');
  });

  it('the note names the env var but never its value', async () => {
    const { notes } = await deriveGatedTargets(EMPTY_STACK, CWD, { PINECONE_API_KEY: 'pc-supersecret' });
    expect(JSON.stringify(notes)).not.toContain('pc-supersecret');
  });

  it('derives nothing with no vector-store credentials', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {});
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });

  it('derives exactly one target even when both providers are configured', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      PINECONE_API_KEY: 'pc-secret',
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(targets.filter((t) => t.kind === 'vector-store')).toHaveLength(1);
  });

  it('derives nothing from a token-only upstash configuration (URL missing)', async () => {
    // buildVectorStoreConnections rejects a half-configured Upstash provider;
    // autodiscovery must agree, or registration.ts throws on a target that
    // was never actually connectable.
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_TOKEN: 'up-secret',
    });
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });

  it('derives nothing from a URL-only upstash configuration (token missing)', async () => {
    const { targets } = await deriveGatedTargets(EMPTY_STACK, CWD, {
      UPSTASH_VECTOR_REST_URL: 'https://x.upstash.io',
    });
    expect(targets.find((t) => t.kind === 'vector-store')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/__tests__/autodiscovery-vector-store.test.ts`
Expected: FAIL — no `vector-store` target is derived.

- [ ] **Step 3: Implement the derivation**

In `src/cli/autodiscovery.ts`, add an import alongside the other agent provider-table imports at the top of the file:

```typescript
import { VECTOR_STORE_ENV_VARS, buildVectorStoreConnections } from '../agent/vector-store/provider-table.js';
```

and add this block inside `deriveGatedTargets`, **immediately before the `// application-config:` block** (an order-independent anchor — PR 3 replaces the AI-provider derivation that sits above it):

```typescript
  // vector-store: a managed vector-store credential is present AND complete.
  // Reuses buildVectorStoreConnections — the same full validation
  // registration.ts applies — instead of a bare "is any env var set" check.
  // A single Upstash var (token without URL, or vice versa) must not derive
  // a target: buildVectorStoreConnections would produce zero connections for
  // it, and registration.ts throws loudly on zero connections rather than
  // silently simulating. Deriving nothing here is how that half-configured
  // case is skipped cleanly instead of surfacing as a crash later.
  const vectorConnections = buildVectorStoreConnections(env);
  if (vectorConnections.length > 0) {
    const configuredProviders = new Set(vectorConnections.map((c) => c.provider));
    const vectorEnvName = VECTOR_STORE_ENV_VARS.find(
      (v) => configuredProviders.has(v.provider) && env[v.envVar] !== undefined,
    )?.envVar;
    const target: TargetConfig = {
      name: 'derived-vector-store',
      kind: 'vector-store',
      primary: { host: 'auto', port: 0 },
    };
    targets.push(target);
    notes[target.name] = `from ${vectorEnvName}`;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/__tests__/autodiscovery-vector-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green. If an autodiscovery snapshot test asserts an exact derived-target list, update it to include `derived-vector-store`.

- [ ] **Step 6: Drive the real CLI surface**

```bash
pnpm run build:bundle
BUNDLE=$PWD/dist/crisismode.bundle.cjs
cd "$(mktemp -d)" && PINECONE_API_KEY=pc-not-a-real-key node "$BUNDLE" scan --json > scan.jsonl; echo "exit=$?"
node -e "
for (const line of require('fs').readFileSync('scan.jsonl','utf8').trim().split('\n')) {
  const rec = JSON.parse(line);
  if (rec.type !== 'scan') continue;
  for (const f of rec.findings.filter(f => f.service.startsWith('vector-store'))) {
    console.log('FINDING', f.service, f.status);
    for (const s of f.signals) console.log('  SIGNAL', s.checkId, s.status);
  }
}
"
grep -c 'pc-not-a-real-key' scan.jsonl   # must print 0
```

Expected: exactly one `vector-store (derived-vector-store)` finding; `vector-store.reachable` / `vector-store.auth_valid` / `vector-store.index_status` all present as signal `checkId`s; **zero** occurrences of the key. Because the key is invalid, `auth_valid` should be `critical` — that is the intended shape, not a failure of this step.

- [ ] **Step 7: Commit**

```bash
git add src/cli/autodiscovery.ts src/__tests__/autodiscovery-vector-store.test.ts
git commit -m "feat(vector-store): derive a vector-store target from provider env vars"
```

---

## Task 9: pgvector live fixture and Part A live validation

**Files:**
- Modify: `test/podman/compose.yaml`
- Create: `test/failures/inject-pgvector-unindexed.sh`
- Create: `test/failures/reset-pgvector.sh`

**Interfaces:**
- Consumes: everything from Tasks 1-4. `crisismode readiness` resolves its PostgreSQL target from `DATABASE_URL` when no `crisismode.yaml` is present (`docs/readiness.md` "Configuration").
- Produces: a `pg-vector` container on host port 5434 with pgvector installed, seeded with one 100k-row unindexed vector table and one 100k-row table carrying a deliberately mistuned ivfflat index.

- [ ] **Step 1: Add the pgvector service to the compose file**

In `test/podman/compose.yaml`, add this service after `pg-replica` (the volumes block also gains `pg-vector-data:`):

```yaml
  # --- PostgreSQL 16 + pgvector (readiness vector rules) ---
  pg-vector:
    image: docker.io/pgvector/pgvector:pg16
    container_name: cm-pg-vector
    networks:
      - crisismode-net
    ports:
      - "5434:5432"
    environment:
      POSTGRES_USER: crisismode
      POSTGRES_PASSWORD: crisismode
      POSTGRES_DB: crisismode
    volumes:
      - pg-vector-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crisismode"]
      interval: 5s
      timeout: 3s
      retries: 10
```

- [ ] **Step 2: Write the fixture script**

Create `test/failures/inject-pgvector-unindexed.sh` (then `chmod +x`):

```bash
#!/bin/bash
set -euo pipefail

# Seeds a pgvector fixture that trips both readiness vector rules:
#   documents — 100k rows, vector column, NO approximate index  → vector-index-missing
#   chunks    — 100k rows, ivfflat index with lists = 4          → ivfflat-lists-mismatch
#                (sqrt(100000) ≈ 316; the accepted 4x band is 79–1265)
#
# Target: the cm-pg-vector container (postgres:16 + pgvector) on host port 5434.

ROWS="${1:-100000}"

# SECURITY: $ROWS is interpolated directly into SQL below (generate_series(1,
# $ROWS)) inside a psql -c string. Validate it as a positive decimal integer
# BEFORE any psql command runs — an unvalidated argument here is a SQL
# injection vector (e.g. `1)); DROP TABLE documents; --`).
if ! [[ "$ROWS" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: rows argument must be a positive integer (got: '$ROWS')" >&2
    exit 1
fi

PSQL=(podman exec cm-pg-vector psql -U crisismode -v ON_ERROR_STOP=1)

echo "💉 Seeding pgvector fixture ($ROWS rows per table)..."

"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "   📄 documents — vector column, no index"
"${PSQL[@]}" -c "
    DROP TABLE IF EXISTS documents;
    CREATE TABLE documents (id bigserial PRIMARY KEY, embedding vector(3));
    INSERT INTO documents (embedding)
    SELECT ARRAY[random(), random(), random()]::vector
    FROM generate_series(1, $ROWS);
    ANALYZE documents;"

echo "   📄 chunks — ivfflat index with a deliberately wrong lists value"
"${PSQL[@]}" -c "
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (id bigserial PRIMARY KEY, embedding vector(3));
    INSERT INTO chunks (embedding)
    SELECT ARRAY[random(), random(), random()]::vector
    FROM generate_series(1, $ROWS);
    CREATE INDEX chunks_embedding_idx ON chunks
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 4);
    ANALYZE chunks;"

echo ""
echo "   📊 Seeded catalog state:"
"${PSQL[@]}" -c "
    SELECT c.relname AS table_name, c.reltuples::bigint AS row_estimate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname IN ('documents', 'chunks') AND n.nspname = 'public';"
"${PSQL[@]}" -c "
    SELECT ic.relname AS index_name, am.amname AS access_method, ic.reloptions
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    WHERE am.amname IN ('ivfflat', 'hnsw');"

echo ""
echo "   Run readiness against it:"
echo "     DATABASE_URL=postgresql://crisismode:crisismode@localhost:5434/crisismode node \$BUNDLE readiness --json"
echo "   To clear, run: ./reset-pgvector.sh"
```

- [ ] **Step 3: Write the reset script**

Create `test/failures/reset-pgvector.sh` (then `chmod +x`):

```bash
#!/bin/bash
set -euo pipefail

# Drops the pgvector fixture tables seeded by inject-pgvector-unindexed.sh.
# The extension itself is left installed — that is the state a real pgvector
# user is in, and the "extension present, no vector tables" case is worth
# being able to test on its own.

echo "🔄 Dropping pgvector fixture tables..."
podman exec cm-pg-vector psql -U crisismode -v ON_ERROR_STOP=1 -c \
    "DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS chunks;"
echo "   ✅ documents and chunks dropped"
```

- [ ] **Step 4: Make the scripts executable and start the container**

```bash
chmod +x test/failures/inject-pgvector-unindexed.sh test/failures/reset-pgvector.sh
cd test/podman && podman-compose up -d pg-vector && cd ../..
podman exec cm-pg-vector pg_isready -U crisismode
```

Expected: `accepting connections`.

- [ ] **Step 5: Validate the silent-skip path FIRST (the non-pgvector database)**

```bash
pnpm run build:bundle
BUNDLE=$PWD/dist/crisismode.bundle.cjs
cd "$(mktemp -d)"
DATABASE_URL=postgresql://crisismode:crisismode@localhost:5432/crisismode \
  node "$BUNDLE" readiness --json | tee readiness-plain.json | \
  grep -c 'vector-index-missing\|ivfflat-lists-mismatch'
```

Expected: `0`. The stock `postgres:16-alpine` primary has no `vector` extension, so both rules must be skipped silently — zero vector-related output. This is half of the spec's acceptance criteria, so record the actual output.

- [ ] **Step 6: Seed the fixture and validate both rules fire**

```bash
cd "$OLDPWD" && ./test/failures/inject-pgvector-unindexed.sh
cd "$(mktemp -d)"
DATABASE_URL=postgresql://crisismode:crisismode@localhost:5434/crisismode \
  node "$BUNDLE" readiness --json > readiness-vector.json
node -e "
const r = JSON.parse(require('fs').readFileSync('readiness-vector.json','utf8').trim().split('\n').pop());
for (const f of r.findings.filter(f => f.ruleId.includes('vector') || f.ruleId.includes('ivfflat'))) {
  console.log(f.ruleId, '=>', f.status);
  console.log('  evidence:', f.evidence.join(' | '));
  console.log('  explanation:', f.explanation);
}
console.log('verdict:', r.verdict, 'score:', r.score);
"
```

Expected: `vector-index-missing => at_risk` naming `documents.embedding` with `~100,000 rows (estimated)` and the `10,000` threshold visible; `ivfflat-lists-mismatch => at_risk` naming `chunks_embedding_idx`, `lists = 4`, and the `79–1265` band; verdict `at-risk`.

- [ ] **Step 7: Validate the human-readable surface**

```bash
DATABASE_URL=postgresql://crisismode:crisismode@localhost:5434/crisismode node "$BUNDLE" readiness
```

Expected: both findings render with their plain-language explanation and fix text, no truncation, no stack traces.

- [ ] **Step 8: Validate the extension-present-but-no-tables case**

```bash
cd "$OLDPWD" && ./test/failures/reset-pgvector.sh
cd "$(mktemp -d)"
DATABASE_URL=postgresql://crisismode:crisismode@localhost:5434/crisismode \
  node "$BUNDLE" readiness --json > readiness-empty.json
node -e "
const r = JSON.parse(require('fs').readFileSync('readiness-empty.json','utf8').trim().split('\n').pop());
for (const f of r.findings.filter(f => ['vector-index-missing','ivfflat-lists-mismatch'].includes(f.ruleId))) {
  console.log(f.ruleId, '=>', f.status);
}
"
```

Expected: both rules print `=> ready` — the extension is installed but there are no vector tables, so the rules run and report ready rather than being skipped. This is the case that distinguishes "extension absent" (silent skip, Step 5) from "extension present, nothing to flag".

- [ ] **Step 9: Re-seed so the fixture is left in its documented state, then commit**

```bash
cd "$OLDPWD" && ./test/failures/inject-pgvector-unindexed.sh
git add test/podman/compose.yaml test/failures/inject-pgvector-unindexed.sh test/failures/reset-pgvector.sh
git commit -m "test(readiness): add a podman pgvector fixture for the vector rules"
```

---

## Task 10: Vector-store live validation and maturity claim

**Files:**
- Modify (only if live validation passes): `src/agent/vector-store/manifest.ts`
- Modify (if a provider's current API differs from the table): `src/agent/vector-store/provider-table.ts`, `src/agent/vector-store/live-client.ts`
- Modify: `src/__tests__/vector-store-agent.test.ts` (the maturity assertion)

**Interfaces:**
- Consumes: `vectorStoreManifest.metadata.plugin.maturity` (Task 7), `VectorStoreLiveClient` (Task 6).
- Produces: a maturity value that matches what was actually exercised against a real account, and a README-style note recording per-provider validation status (written in Task 11).

- [ ] **Step 1: Confirm the endpoints against current provider documentation**

Use the Context7 MCP tools (per the repo's documentation policy) to fetch current docs before touching anything:

- `resolve-library-id` for "Pinecone", then `query-docs` for "list indexes REST API control plane authentication header and API version header".
- `resolve-library-id` for "Upstash Vector", then `query-docs` for "REST API /info endpoint authentication".

Verify four facts and write down what the docs actually say:
1. Pinecone list-indexes path and host (`GET https://api.pinecone.io/indexes`).
2. Pinecone auth header name (`Api-Key`) and whether a version header is required — the client sends `X-Pinecone-API-Version: 2025-04`; correct the value if the docs name a different current version.
3. Pinecone data-plane stats path (`POST https://{index-host}/describe_index_stats`).
4. Upstash `GET {REST_URL}/info` with `Authorization: Bearer {token}` and the `result` field names (`vectorCount`, `dimension`).

If any differ, update `provider-table.ts` / `live-client.ts` and the mocked-fetch tests in `src/__tests__/vector-store-live-client.test.ts` together, then re-run `pnpm vitest run src/__tests__/vector-store-live-client.test.ts`.

- [ ] **Step 2: Obtain free-tier credentials**

Both providers have a free tier. Create one index per provider (any dimension; an empty index is enough for reachability/auth and exercises the `no_indexes` path too). If an account cannot be obtained for a provider, record that and skip to Step 6 — shipping best-effort with an honest label is acceptable; claiming validation that did not happen is not.

- [ ] **Step 3: Validate the happy path at the CLI surface**

```bash
pnpm run build:bundle
BUNDLE=$PWD/dist/crisismode.bundle.cjs
cd "$(mktemp -d)"
PINECONE_API_KEY=<real-key> node "$BUNDLE" scan --json > pinecone-scan.jsonl
node -e "
for (const line of require('fs').readFileSync('pinecone-scan.jsonl','utf8').trim().split('\n')) {
  const rec = JSON.parse(line);
  if (rec.type !== 'scan') continue;
  for (const f of rec.findings.filter(f => f.service.includes('vector-store'))) {
    console.log(f.service, f.status, f.summary);
    for (const s of f.signals) console.log('  ', s.checkId, s.status, s.detail);
  }
}
"
grep -c '<real-key>' pinecone-scan.jsonl   # must print 0
```

Expected: one `vector-store` finding, `reachable` and `auth_valid` passing, `index_status` reflecting the real index; zero occurrences of the key.

Repeat with `UPSTASH_VECTOR_REST_URL` + `UPSTASH_VECTOR_REST_TOKEN`.

- [ ] **Step 4: Validate the failure path with a deliberately invalid key**

```bash
cd "$(mktemp -d)"
PINECONE_API_KEY=pcsk-definitely-invalid-0000 node "$BUNDLE" scan
```

Expected: a plain-language finding naming pinecone and the fix direction (rotate the key), with `…0000` as the only credential reference anywhere in the output.

- [ ] **Step 5: Validate the offline defer against a real triage verdict**

The gate reads PR 2's cached triage report, and only `scan` populates that cache (it runs triage as step 0). So this must be driven through `scan`, not `diagnose` — under `diagnose` the cache is empty, the gate correctly returns `null`, and the checks run and report their own per-check failures. Both behaviours are correct; only the first is what this step validates.

Disable networking (turn off wifi, or run in a network-isolated shell), then:

```bash
cd "$(mktemp -d)"
PINECONE_API_KEY=<real-key> node "$BUNDLE" scan
```

Expected: the vector-store signals read "cannot verify while offline — <triage's explanation>" and the run leads with the triage/observer framing — **not** "pinecone is down". Re-enable networking afterwards.

If triage reports `mixed` (it could not localize the fault), the gate deliberately does not defer and the checks run. That is the designed behaviour, not a failed validation — re-run once networking is more decisively down.

- [ ] **Step 6: Set the maturity claim to match reality**

If **both** providers were exercised live and Steps 3-5 passed, change `src/agent/vector-store/manifest.ts`:

```typescript
      maturity: 'live_validated',
```

and update the assertion in `src/__tests__/vector-store-agent.test.ts`:

```typescript
  it('declares a maturity value (PR 1 visibility contract)', () => {
    expect(vectorStoreManifest.metadata.plugin.maturity).toBe('live_validated');
  });
```

If only one provider could be validated, still set `'live_validated'` (the agent-level claim rests on what was exercised) and record the per-provider status in Task 11's docs. If **neither** could be validated, leave `'simulator_only'` unchanged — PR 1's machinery then labels it honestly in the "Watching (best-effort)" bucket, which is the correct outcome, not a failure.

- [ ] **Step 7: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/agent/vector-store/manifest.ts src/__tests__/vector-store-agent.test.ts \
  src/agent/vector-store/provider-table.ts src/agent/vector-store/live-client.ts \
  src/__tests__/vector-store-live-client.test.ts
git commit -m "feat(vector-store): set the maturity claim from live provider validation"
```

(Drop paths from the `git add` that Step 1 and Step 6 left unchanged.)

---

## Task 11: Documentation

**Files:**
- Modify: `docs/readiness.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the final shipped behaviour of Tasks 1-10, including the maturity value actually chosen in Task 10.
- Produces: no code interfaces. This task exists because `docs/readiness.md` documents an exact rule count, exact thresholds, and the honesty contract — all three are now wrong, and drift between the doc and the rules has been a recurring source of bugs in this repo.

- [ ] **Step 1: Update the rule count and heading in `docs/readiness.md`**

Change the section heading `## The Six Rules` to `## The Eight Rules`, and its first sentence from "Six rules live in `src/readiness/rules/`" to "Eight rules live in `src/readiness/rules/`".

- [ ] **Step 2: Add the two rules to the rules table**

Append these rows to the rules table (after `serverless-pooling`):

```markdown
| `vector-index-missing` | vector column on a table with ≥ 10,000 estimated rows and no `ivfflat`/`hnsw` index on that column → `at_risk`; no pgvector extension → rule skipped entirely | `ready`, `at_risk`, `unknown` | Without an approximate index every similarity search reads and scores every row — instant on a demo table, an outage once real documents arrive | "Create an hnsw index on the vector column — for example CREATE INDEX ON \<table\> USING hnsw (\<column\> vector_cosine_ops). Match the operator class to the distance function your queries actually use, then confirm with EXPLAIN that the index is being used." |
| `ivfflat-lists-mismatch` | `ivfflat` index on a table with ≥ 10,000 estimated rows whose `lists` is outside `sqrt(rows) / 4 .. sqrt(rows) × 4` → `at_risk`; `hnsw` exempt; `lists` not recorded in the index options → `unknown` | `ready`, `at_risk`, `unknown` | Too few lists and every cluster is huge, so queries stay slow; too many and each cluster is tiny, so recall silently drops | "Recreate the index with lists close to sqrt(rows) … or switch to hnsw, which needs no row-count-dependent tuning." |
```

- [ ] **Step 3: Add a pgvector section**

Insert this after the rules table, before the `### Verdict and Score` heading:

```markdown
### pgvector rules and silent skipping

The two vector rules are the only rules whose applicability depends on live
database state rather than the discovered stack. Because `applicable(ctx)` is
synchronous and cannot query anything, the runner
(`connectAndRunReadiness` in `src/readiness/run.ts`) reads the pgvector catalog
**once, before any rule runs**, and puts the result on `ReadinessContext.pgvector`.
The read is strictly read-only: `pg_extension`, then — only when the extension
is present — vector-typed columns from `pg_attribute`/`pg_class`, row estimates
from `pg_class.reltuples`, and `ivfflat`/`hnsw` indexes from `pg_index`/`pg_am`.

Three outcomes, three different behaviours:

| `ctx.pgvector` | Meaning | Behaviour |
|---|---|---|
| absent member | the client cannot probe pgvector at all | rules not applicable — no finding |
| `'absent'` | the `vector` extension is confirmed not installed | rules not applicable — **no finding at all**, not a `ready` one |
| `null` | the catalog read failed | rules run and report `unknown` with the reason `could not read pgvector catalog (connection or permission issue)` |
| an inventory | the extension is installed | rules evaluate normally |

The `unknown` reason is deliberately generic: the PostgreSQL live client's
convention is null-on-any-error without classification, so the report does not
promise precise permission-denied detection it cannot produce.

Two smaller honesty details fall out of the same policy. Row counts come from
`pg_class.reltuples` and are always labelled "(estimated)"; a table PostgreSQL
has never analyzed (`reltuples = -1`) is reported as `unknown` with an `ANALYZE`
instruction rather than being treated as empty. And an `ivfflat` index created
without an explicit `WITH (lists = ...)` records no value in `pg_class.reloptions`
— pgvector's built-in default is **not** substituted, so that index is reported
as `unknown` rather than checked against a number nobody wrote down.
```

- [ ] **Step 4: Add the vector-store agent to `CLAUDE.md`**

In the "Key Files" table, add a row next to the other agent directories (after `src/agent/iac-drift/`):

```markdown
| `src/agent/vector-store/` | Managed vector store (Pinecone, Upstash Vector) reachability agent |
```

If Task 10 validated only one provider live, add the per-provider status as a sentence in that row's description — e.g. "live-validated against Pinecone; Upstash implemented identically but validated best-effort".

- [ ] **Step 5: Verify the documented thresholds against the code**

Run:

```bash
grep -n "VECTOR_MIN_ROWS\s*=\|LISTS_TOLERANCE_FACTOR\s*=" src/readiness/rules/*.ts
grep -n "10,000\|sqrt(rows)" docs/readiness.md
```

Expected: `VECTOR_MIN_ROWS = 10_000` and `LISTS_TOLERANCE_FACTOR = 4` match the numbers written in the doc table. Fix whichever is wrong.

- [ ] **Step 6: Final full verification**

Run: `pnpm test && pnpm run typecheck && pnpm run lint`
Expected: all green, with the pre-existing test count plus the new tests.

- [ ] **Step 7: Commit**

```bash
git add docs/readiness.md CLAUDE.md
git commit -m "docs: document the pgvector readiness rules and the vector-store agent"
```

---

## Acceptance Criteria (from the spec)

| Criterion | Verified by |
|---|---|
| A Postgres with a 100k-row un-indexed vector table produces the `vector-index-missing` finding with a plain-language explanation | Task 9 Step 6 (live), Task 4 Step 1 (unit) |
| A non-pgvector database produces zero vector-related output | Task 9 Step 5 (live), Task 4 Step 1 (unit, both the `'absent'` and no-source cases) |
| `crisismode scan` with `PINECONE_API_KEY` set reports the store watched, with reachability and index status | Task 8 Step 7 (invalid key), Task 10 Step 3 (real key) |
| Maturity labels match what was actually validated live | Task 10 Step 6 |
| Vector-store findings carry `vector-store.*` `checkId`s | Task 8 Step 7 |
| No key material in any output mode | Task 6 secrecy test, Task 8 Step 7, Task 10 Step 3 |
| Offline defers to triage instead of reporting providers down | Task 7 offline-deferral tests (gate fires, backend untouched, `null` is not offline), Task 10 Step 5 |
| Signal sources resolve to plain-language explanations | Task 7 Step 6 + `explanation-coverage.test.ts` |
