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
    let status: 'blocking' | 'at_risk' | 'ready' = 'ready';
    if (used >= BLOCKING_USAGE) {
      status = 'blocking';
    } else if (used >= AT_RISK_USAGE) {
      status = 'at_risk';
    }
    return {
      ...base,
      status,
      headroom,
      evidence: [`${usage.total} of ${usage.max} connections in use (${Math.round(used * 100)}%)`],
    };
  },
};
