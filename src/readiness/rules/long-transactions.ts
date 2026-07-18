// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';

/** Idle-in-transaction beyond 60s holds locks and a connection for no work. */
const LONG_IDLE_SECONDS = 60;

export const longTransactionsRule: ReadinessRule = {
  id: 'long-transactions',
  title: 'Long idle transactions',
  applicable: (ctx) => ctx.target !== undefined,
  async evaluate(sources) {
    const usage = await sources.connectionUsage();
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'A transaction left open ("idle in transaction") holds its locks and its connection. Under load these pile up and block other queries.',
      fix: 'Find the code path that opens a transaction without committing; set idle_in_transaction_session_timeout as a backstop.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT',
    };
    if (!usage) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: 'could not read pg_stat_activity' };
    }
    const long = usage.idleInTransactionOldest.filter((s) => s.ageSeconds >= LONG_IDLE_SECONDS);
    if (long.length === 0) return { ...base, status: 'ready' as const, evidence: [] };
    return {
      ...base,
      status: 'at_risk' as const,
      evidence: long.map((s) => `pid ${s.pid} idle in transaction for ${s.ageSeconds}s`),
    };
  },
};
