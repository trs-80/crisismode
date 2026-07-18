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
