// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Managed-PG free tiers commonly cap max_connections at or below ~25. */
const SMALL_MAX_CONNECTIONS = 25;

export const connectionLimitTierRule: ReadinessRule = {
  id: 'connection-limit-tier',
  title: 'Connection limit size',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const usage = await sources.connectionUsage();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'A small max_connections (typical of free/starter database plans) leaves little room for traffic growth — every serverless instance and background job consumes one.',
      fix: 'Plan a tier upgrade or add pooling before launch traffic arrives.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS',
    };
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read max_connections' };
    }
    const status = usage.max <= SMALL_MAX_CONNECTIONS ? 'at_risk' : 'ready';
    return { ...base, status, evidence: [`max_connections = ${usage.max}`] };
  },
};
