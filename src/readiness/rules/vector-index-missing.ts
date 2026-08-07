// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgvectorIndex, PgvectorTable, ReadinessContext, ReadinessRule } from '../types.js';

/**
 * Below ~10k vectors an exhaustive scan is fast enough — do not nag about a
 * demo-sized table. Same threshold as the missing-index rule, for the same
 * reason: cost grows with data, not with traffic.
 */
export const VECTOR_MIN_ROWS = 10_000;

/**
 * The PG live client's convention is null-on-any-error without classification,
 * so the reason cannot promise precise permission detection.
 */
export const PGVECTOR_UNREADABLE_REASON =
  'could not read pgvector catalog (connection or permission issue)';

/**
 * Shared gate for the vector rules. Returns false when there is no pgvector
 * source at all, or when the extension is confirmed absent — both are silent
 * skips (no finding is produced), which is the only way the framework can stay
 * quiet on a non-pgvector database. A failed read (null) IS applicable so the
 * rule can report an honest 'unknown'.
 */
export function vectorRuleApplicable(ctx: ReadinessContext): boolean {
  return ctx.target !== undefined && ctx.pgvector !== undefined && ctx.pgvector !== 'absent';
}

/** A table whose row estimate PostgreSQL actually has. */
type SizedTable = PgvectorTable & { rowEstimate: number };

function isSized(table: PgvectorTable): table is SizedTable {
  return table.rowEstimate !== null;
}

/** Does this index provide approximate search for that schema/table/column? */
export function coversColumn(index: PgvectorIndex, table: PgvectorTable): boolean {
  return index.schema === table.schema && index.table === table.table && index.column === table.column;
}

function unanalyzedEvidence(table: PgvectorTable): string {
  return `${table.table}.${table.column}: row estimate unavailable (never analyzed — run ANALYZE ${table.table})`;
}

export const vectorIndexMissingRule: ReadinessRule = {
  id: 'vector-index-missing',
  title: 'Vector columns without an approximate index',
  applicable: vectorRuleApplicable,
  async evaluate(_sources, ctx) {
    const threshold = VECTOR_MIN_ROWS.toLocaleString('en-US');
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'Without an ivfflat or hnsw index, every similarity search reads and scores every row in the table. ' +
        'That is instant on a demo-sized table and an outage once real documents arrive — the cost grows with ' +
        'your data even if traffic stays flat.',
      fix:
        'Create an hnsw index on the vector column — for example ' +
        'CREATE INDEX ON <table> USING hnsw (<column> vector_cosine_ops). Match the operator class to the ' +
        'distance function your queries actually use, then confirm with EXPLAIN that the index is being used.',
      learnMoreUrl: 'https://github.com/pgvector/pgvector#indexing',
    };

    const inventory = ctx.pgvector;
    if (inventory === undefined || inventory === 'absent' || inventory === null) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: PGVECTOR_UNREADABLE_REASON };
    }

    const unanalyzed = inventory.tables.filter((t) => !isSized(t));
    const sized = inventory.tables.filter(isSized);
    const large = sized.filter((t) => t.rowEstimate >= VECTOR_MIN_ROWS);
    const offenders = large.filter((t) => !inventory.indexes.some((i) => coversColumn(i, t)));

    if (offenders.length > 0) {
      return {
        ...base,
        status: 'at_risk' as const,
        evidence: [
          ...offenders.map(
            (t) =>
              `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
              `no ivfflat or hnsw index — threshold is ${threshold} rows`,
          ),
          ...unanalyzed.map(unanalyzedEvidence),
        ],
      };
    }

    if (unanalyzed.length > 0) {
      return {
        ...base,
        status: 'unknown' as const,
        evidence: unanalyzed.map(unanalyzedEvidence),
        reason:
          `PostgreSQL has no row estimate yet for ${unanalyzed.map((t) => t.table).join(', ')} ` +
          '(never analyzed) — run ANALYZE and re-run readiness',
      };
    }

    return {
      ...base,
      status: 'ready' as const,
      evidence: sized.map((t) => {
        const covering = inventory.indexes.find((i) => coversColumn(i, t));
        if (covering) {
          return `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
            `indexed by ${covering.indexName} (${covering.accessMethod})`;
        }
        return `${t.table}.${t.column}: ~${t.rowEstimate.toLocaleString('en-US')} rows (estimated), ` +
          `below the ${threshold}-row threshold`;
      }),
    };
  },
};
