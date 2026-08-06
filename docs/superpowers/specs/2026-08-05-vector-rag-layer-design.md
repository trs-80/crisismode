# PR 4 — Vector/RAG Layer: pgvector Rules + Vector Store Reachability

**Date:** 2026-08-05
**Series:** Reliability-first (PR 4 of 5). Depends on PR 1 (maturity contract). Independent of PR 3 but ships after it (same review pipeline). PR 5 anchors guidance to these finding types.

## Problem

AI apps built by the target user almost always have a retrieval layer: pgvector inside their managed Postgres, or a managed vector store (Pinecone, Upstash Vector). This layer fails in characteristic, deterministic ways — a missing approximate index turns retrieval into sequential scans that collapse under load; a bad token or deleted index takes RAG down entirely. Nothing in CrisisMode sees this layer today.

## Goals

1. **pgvector coverage on the validated PG core** — detection plus two invariant readiness rules.
2. **A lightweight `vector-store` agent** — reachability/auth/status for Pinecone and Upstash Vector.

Deliberately small: invariant checks only, no inference, no new correlation rules.

## Non-goals

- Vector data quality, embedding drift, or recall metrics (not deterministically checkable).
- Weaviate, Qdrant, Chroma, Milvus (deferred until the pattern proves out — depth over breadth).
- Any mutation (no index creation; index guidance text only, structured guidance in PR 5).

## Design

### Part A — pgvector on the readiness surface

**Where detection lives (decided):** the catalog queries live in the readiness pipeline only for v1 — scan/diagnose surfaces are unchanged. Readiness runs build their own sources (`src/readiness/run.ts`), separate from agent diagnosis, and that is the only consumer these rules need.

**Interface extensions (named):** `ReadinessSources` (src/readiness/types.ts) gains an optional member `getPgvectorInventory(): Promise<PgvectorInventory | 'absent' | null>`, wired in `run.ts` to a new optional `PgBackend` method of the same name (optional, so simulators and non-PG backends are unaffected). The three-way return keeps causes distinct: an inventory object (extension present), `'absent'` (extension confirmed not installed → silent skip), `null` (query failed → rules report `unknown`). The inventory query is read-only: `SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`, then — only when present — tables with `vector`-typed columns, row estimates from `pg_class.reltuples`, and existing `ivfflat`/`hnsw` indexes from `pg_indexes`/`pg_am`.

**Silent-skip mechanism (decided):** the readiness framework's `applicable(ctx)` is synchronous over the stack profile and cannot observe live DB state, and a rule returning `status: 'unknown'` renders in the report — the opposite of silence. So: `run.ts` fetches the pgvector inventory once (when the source exists) and places it on `ReadinessContext` as an optional `pgvector: PgvectorInventory | 'absent' | null` field **before rule evaluation** — the field's type matches `getPgvectorInventory()`'s three-way return exactly, so `'absent'` (extension confirmed not installed) stays distinguishable from `null` (query failed) and from the field being omitted entirely (no pgvector source on this backend); the two vector rules' `applicable(ctx)` return false when `ctx.pgvector` is `'absent'` or the field is `undefined`/missing. Silence for non-pgvector databases falls out of the existing applicability mechanism — no new status value, no framework semantics change beyond one context field populated asynchronously by the runner.

**Readiness rules** (`src/readiness/rules/`, following the existing rule shape):

1. **`vector-index-missing`** — a table with a vector column and estimated rows above a threshold (default 10,000) has no `ivfflat` or `hnsw` index on that column. Finding explains the consequence in plain language (every similarity query reads the whole table; works in the demo, falls over with users) and the fix direction (create an HNSW index), including the standard "verify with EXPLAIN" caveat.
2. **`ivfflat-lists-mismatch`** — an existing `ivfflat` index whose `lists` parameter is far from the `sqrt(rows)` heuristic (outside 4x in either direction) on a table above the row threshold. Explains recall/speed consequences; suggests re-creating with a suitable `lists` value or moving to HNSW. HNSW indexes are exempt (no equivalent tuning invariant we can check deterministically).

Both rules follow the readiness honesty contract (docs/readiness.md): thresholds visible in output and "estimated rows" labeled as estimates. Skip semantics differ by cause, matching what the plumbing can actually distinguish: extension absent → silent skip via `applicable()` (above); inventory query failed (the PG live client's convention is null-on-any-error, without error classification) → the rules run and report `status: 'unknown'` with the existing-style generic reason "could not read pgvector catalog (connection or permission issue)" — we do not promise precise permission-denied detection, which the current client cannot produce.

### Part B — `vector-store` agent

Standard agent pattern, mirroring PR 3's provider-table approach:

```
src/agent/vector-store/
  backend.ts / provider-table.ts / simulator.ts / live-client.ts
  manifest.ts   # kind: 'vector-store', maxRiskLevel: routine
  agent.ts / registration.ts
```

| field | pinecone | upstash-vector |
|---|---|---|
| env keys | `PINECONE_API_KEY` | `UPSTASH_VECTOR_REST_URL` + `UPSTASH_VECTOR_REST_TOKEN` |
| checks | list indexes (`GET api.pinecone.io/indexes`), per-index describe → `status.ready` | `GET <rest-url>/info` → index info |
| auth | `Api-Key` header | `Authorization: Bearer` |

Checks per provider: **reachable**, **auth_valid**, **index_status** (exists + ready + basic stats: dimension, record count). Raw `fetch`, no SDKs, endpoints confirmed against current provider docs at implementation. Same per-check degradation, offline-defer-to-triage, and no-key-leak contract as PR 3 (shared helper where practical — extract the common provider-check plumbing from PR 3 into a small shared module if the duplication exceeds ~100 lines; otherwise keep separate and revisit).

**Maturity:** validated against free-tier Pinecone and Upstash accounts where obtainable during implementation; whichever providers are actually exercised live determine the claim. If neither can be validated live, the agent ships `simulator_only` and PR 1's machinery labels it honestly — shipping best-effort with honest labels is acceptable; claiming validation that didn't happen is not.

## Error handling

- Catalog queries run under the PG live client's existing read-only connection and null-on-error convention; a failed inventory query surfaces as the rules reporting `status: 'unknown'` with a generic connection-or-permission reason (see Part A skip semantics).
- Vector-store checks follow the PR 3 degradation contract exactly, and vector-store findings carry stable `checkId`s (`vector-store.reachable`, `vector-store.auth_valid`, `vector-store.index_status`) under the finding output contract PR 3 introduces — PR 5 anchors guidance to these.

## Testing

- pgvector: simulator-backed tests for detection present/absent, both rules firing/not firing across thresholds, and the permission-degraded path. Live validation against the podman test PG with pgvector installed and a seeded vector table (add a `test/failures` style fixture script).
- vector-store: simulator scenarios per check; mocked-fetch live-client tests; no-key-leak test.
- Readiness report snapshot updates.

## Acceptance criteria

- A Postgres with a 100k-row un-indexed vector table produces the `vector-index-missing` readiness finding with plain-language explanation; a non-pgvector database produces zero vector-related output.
- `crisismode scan` with `PINECONE_API_KEY` set reports the store watched, with reachability and index status.
- Maturity labels match what was actually validated live.
