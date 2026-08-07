// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Scale-readiness rule registry types. Readiness is forward-looking and
 * strictly read-only (suggest escalation level at most): rules observe,
 * explain, and recommend — they never mutate.
 */

import type { ConnectionUsage } from '../agent/pg-replication/backend.js';
import type { StackProfile } from '../cli/autodiscovery.js';
import type { WeakLinkVerdict } from './weak-link.js';

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

/** Narrow data-access surface rules are allowed to use. */
export interface ReadinessSources {
  connectionUsage(): Promise<ConnectionUsage | null>;
  tableStats(): Promise<TableStat[] | null>;
  statementStats(): Promise<StatementStat[] | null>;
  /** Optional ceiling probes — absent member ⇒ that ceiling is omitted with a reason. */
  statementAggregate?(): Promise<StatementAggregate | null>;
  redisLimits?(): Promise<RedisLimits | null>;
  fdLimit?(): Promise<number | null>;
  declaredEgressMbps?(): Promise<number | null>;
  /**
   * pgvector catalog inventory. Three-way return keeps the causes distinct:
   * an inventory (extension installed), 'absent' (confirmed not installed —
   * the vector rules skip silently), null (the catalog read failed — the
   * vector rules run and report 'unknown').
   */
  getPgvectorInventory?(): Promise<PgvectorInventory | 'absent' | null>;
}

export interface ReadinessContext {
  stack: StackProfile;
  /** True when Vercel deployment signals were detected (platform or .vercel/) */
  serverless: boolean;
  /** kind/host/port of the resolved postgresql target, if any */
  target?: { host: string; port: number } | undefined;
  /**
   * pgvector inventory, fetched ONCE by the runner before rule evaluation.
   * `applicable(ctx)` is synchronous and cannot query the database, and it is
   * the only mechanism that skips a rule silently — a rule returning
   * status 'unknown' still renders in the report. undefined ⇒ no source at
   * all (non-PG path); 'absent' ⇒ extension not installed; null ⇒ read failed.
   */
  pgvector?: PgvectorInventory | 'absent' | null | undefined;
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
  /** Capacity ceilings — report CONTEXT only; never affects score or verdict. */
  ceilings?: CapacityCeiling[] | undefined;
  ceilingsOmitted?: OmittedCeiling[] | undefined;
  weakLink?: WeakLinkVerdict | undefined;
}
