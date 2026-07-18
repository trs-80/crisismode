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
