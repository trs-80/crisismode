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
