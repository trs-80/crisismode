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
  /** Capacity ceilings — report CONTEXT only; never affects score or verdict. */
  ceilings?: CapacityCeiling[] | undefined;
  ceilingsOmitted?: OmittedCeiling[] | undefined;
  weakLink?: WeakLinkVerdict | undefined;
}
