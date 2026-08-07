// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgvectorIndex, ReadinessRule } from '../types.js';
import {
  PGVECTOR_UNREADABLE_REASON, VECTOR_MIN_ROWS, vectorRuleApplicable,
} from './vector-index-missing.js';

/**
 * How far `lists` may stray from sqrt(rows) before it is worth reporting.
 * The heuristic is a starting point, not a law — a 4x band in either
 * direction keeps the rule quiet about ordinary tuning choices.
 */
export const LISTS_TOLERANCE_FACTOR = 4;

/** pgvector's published starting point for the ivfflat `lists` parameter. */
export function idealLists(rowEstimate: number): number {
  return Math.sqrt(rowEstimate);
}

interface Candidate {
  index: PgvectorIndex;
  rowEstimate: number;
}

export const ivfflatListsMismatchRule: ReadinessRule = {
  id: 'ivfflat-lists-mismatch',
  title: 'ivfflat index tuned for the wrong table size',
  applicable: vectorRuleApplicable,
  async evaluate(_sources, ctx) {
    const base = {
      ruleId: this.id,
      title: this.title,
      explanation:
        'An ivfflat index splits vectors into `lists` clusters and searches only a few of them. Too few lists ' +
        'and every cluster is huge, so queries stay slow; too many and each cluster is tiny, so the search ' +
        'misses true nearest neighbours and recall silently drops. The published starting point is ' +
        'lists ≈ sqrt(number of rows).',
      fix:
        'Recreate the index with lists close to sqrt(rows) — CREATE INDEX ON <table> USING ivfflat ' +
        '(<column> vector_cosine_ops) WITH (lists = N) — or switch to hnsw, which needs no row-count-dependent ' +
        'tuning. Confirm with EXPLAIN that the new index is used.',
      learnMoreUrl: 'https://github.com/pgvector/pgvector#ivfflat',
    };

    const inventory = ctx.pgvector;
    if (inventory === undefined || inventory === 'absent' || inventory === null) {
      return { ...base, status: 'unknown' as const, evidence: [], reason: PGVECTOR_UNREADABLE_REASON };
    }

    // Only tables PostgreSQL has an estimate for, and only above the threshold:
    // below it the whole tuning question is moot. Keyed by schema.table —
    // same-named tables in different schemas are distinct (see PgvectorTable).
    const rowsByTable = new Map<string, number>();
    for (const table of inventory.tables) {
      if (table.rowEstimate !== null && table.rowEstimate >= VECTOR_MIN_ROWS) {
        rowsByTable.set(`${table.schema}.${table.table}`, table.rowEstimate);
      }
    }

    const candidates: Candidate[] = [];
    for (const index of inventory.indexes) {
      if (index.accessMethod !== 'ivfflat') continue;
      const rowEstimate = rowsByTable.get(`${index.schema}.${index.table}`);
      if (rowEstimate === undefined) continue;
      candidates.push({ index, rowEstimate });
    }

    const mismatched: string[] = [];
    const unreadable: PgvectorIndex[] = [];
    const withinBand: string[] = [];

    for (const { index, rowEstimate } of candidates) {
      if (index.lists === null) {
        unreadable.push(index);
        continue;
      }
      const ideal = idealLists(rowEstimate);
      const low = ideal / LISTS_TOLERANCE_FACTOR;
      const high = ideal * LISTS_TOLERANCE_FACTOR;
      const line =
        `${index.indexName} on ${index.table}.${index.column ?? '(expression)'}: lists = ${index.lists}, ` +
        `sqrt(~${rowEstimate.toLocaleString('en-US')} rows estimated) ≈ ${Math.round(ideal)} ` +
        `(accepted band at ${LISTS_TOLERANCE_FACTOR}x: ${Math.round(low)}–${Math.round(high)})`;
      if (index.lists < low || index.lists > high) mismatched.push(line);
      else withinBand.push(line);
    }

    if (mismatched.length > 0) {
      return { ...base, status: 'at_risk' as const, evidence: mismatched };
    }

    if (unreadable.length > 0) {
      return {
        ...base,
        status: 'unknown' as const,
        evidence: unreadable.map(
          (i) => `${i.indexName} on ${i.table}: no lists value recorded in the index options`,
        ),
        reason:
          `${unreadable.map((i) => i.indexName).join(', ')} was created without an explicit ` +
          'WITH (lists = ...), so PostgreSQL records no value to check against the sqrt(rows) heuristic',
      };
    }

    const hnswExempt = inventory.indexes
      .filter((i) => i.accessMethod === 'hnsw')
      .map((i) => `${i.indexName} on ${i.table}: hnsw — exempt (no row-count-dependent tuning parameter)`);

    return { ...base, status: 'ready' as const, evidence: [...withinBand, ...hnswExempt] };
  },
};
