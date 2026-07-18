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
