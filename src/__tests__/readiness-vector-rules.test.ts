// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { vectorIndexMissingRule, VECTOR_MIN_ROWS } from '../readiness/rules/vector-index-missing.js';
import {
  ivfflatListsMismatchRule, LISTS_TOLERANCE_FACTOR, idealLists,
} from '../readiness/rules/ivfflat-lists-mismatch.js';
import type {
  PgvectorIndex, PgvectorInventory, PgvectorTable, ReadinessContext, ReadinessSources,
} from '../readiness/types.js';

/** Rules read pgvector from the context; the sources surface is unused by them. */
const sources: ReadinessSources = {
  connectionUsage: async () => null,
  tableStats: async () => null,
  statementStats: async () => null,
};

function ctxWith(pgvector: PgvectorInventory | 'absent' | null | undefined): ReadinessContext {
  const base = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;
  return pgvector === undefined ? base : { ...base, pgvector };
}

function inventory(tables: PgvectorTable[], indexes: PgvectorIndex[] = []): PgvectorInventory {
  return { extensionVersion: '0.7.0', tables, indexes };
}

const hnswOn = (table: string, column: string): PgvectorIndex => ({
  schema: 'public', indexName: `${table}_${column}_idx`, table, column, accessMethod: 'hnsw', lists: null,
});

describe('vectorIndexMissingRule applicability', () => {
  it('is not applicable when no pgvector source exists at all', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(undefined))).toBe(false);
  });
  it("is not applicable when the extension is absent (silent skip)", () => {
    expect(vectorIndexMissingRule.applicable(ctxWith('absent'))).toBe(false);
  });
  it('IS applicable when the catalog read failed, so it can report unknown', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(null))).toBe(true);
  });
  it('is applicable when an inventory is present', () => {
    expect(vectorIndexMissingRule.applicable(ctxWith(inventory([])))).toBe(true);
  });
  it('is not applicable without a postgres target', () => {
    const noTarget = { serverless: false, pgvector: inventory([]) } as ReadinessContext;
    expect(vectorIndexMissingRule.applicable(noTarget)).toBe(false);
  });
});

describe('vectorIndexMissingRule evaluation', () => {
  it('flags a large unindexed vector column', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('documents.embedding');
    expect(f.evidence.join(' ')).toContain('(estimated)');
    expect(f.evidence.join(' ')).toContain('10,000');
  });

  it('is ready when an hnsw index covers the column', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [hnswOn('documents', 'embedding')],
    )));
    expect(f.status).toBe('ready');
  });

  it('is ready when an ivfflat index covers the column', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [{ schema: 'public', indexName: 'i', table: 'documents', column: 'embedding', accessMethod: 'ivfflat', lists: 316 }],
    )));
    expect(f.status).toBe('ready');
  });

  it('flags when the index is on a different column of the same table', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory(
      [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
      [hnswOn('documents', 'title_embedding')],
    )));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: flags at exactly VECTOR_MIN_ROWS', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 't', column: 'e', rowEstimate: VECTOR_MIN_ROWS }])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready just below VECTOR_MIN_ROWS', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 't', column: 'e', rowEstimate: VECTOR_MIN_ROWS - 1 }])));
    expect(f.status).toBe('ready');
  });

  it('reports unknown with the generic reason when the catalog read failed', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(null));
    expect(f.status).toBe('unknown');
    expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
  });

  it('reports unknown when the only vector table has never been analyzed', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: null }])));
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('ANALYZE');
  });

  it('an unanalyzed table does not mask a real offender', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory([
      { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 },
      { schema: 'public', table: 'chunks', column: 'embedding', rowEstimate: null },
    ])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('chunks.embedding');
  });

  it('is ready with no vector tables at all', async () => {
    const f = await vectorIndexMissingRule.evaluate(sources, ctxWith(inventory([])));
    expect(f.status).toBe('ready');
  });

  it('recommends HNSW and the EXPLAIN caveat', async () => {
    const f = await vectorIndexMissingRule.evaluate(
      sources, ctxWith(inventory([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }])));
    expect(f.fix).toContain('hnsw');
    expect(f.fix).toContain('EXPLAIN');
  });
});

const ivfflatOn = (table: string, lists: number | null): PgvectorIndex => ({
  schema: 'public', indexName: `${table}_embedding_idx`, table, column: 'embedding', accessMethod: 'ivfflat', lists,
});

describe('idealLists', () => {
  it('is the square root of the row estimate', () => {
    expect(idealLists(100_000)).toBeCloseTo(316.227, 2);
  });
});

describe('ivfflatListsMismatchRule', () => {
  // 10,000 rows ⇒ sqrt = 100 ⇒ accepted band is 25..400 at a 4x tolerance.
  const tenKTable: PgvectorTable = { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 10_000 };

  it('shares the vector-rule applicability gate', () => {
    expect(ivfflatListsMismatchRule.applicable(ctxWith('absent'))).toBe(false);
    expect(ivfflatListsMismatchRule.applicable(ctxWith(undefined))).toBe(false);
    expect(ivfflatListsMismatchRule.applicable(ctxWith(null))).toBe(true);
  });

  it('flags lists far below the sqrt(rows) heuristic', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 4)])));
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('lists = 4');
    expect(f.evidence.join(' ')).toContain('100');
  });

  it('flags lists far above the sqrt(rows) heuristic', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 5_000)])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready at exactly 4x the ideal (400 for 10,000 rows)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 400)])));
    expect(f.status).toBe('ready');
  });

  it('boundary: at_risk just above 4x the ideal (401)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 401)])));
    expect(f.status).toBe('at_risk');
  });

  it('boundary: ready at exactly ideal/4 (25 for 10,000 rows)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 25)])));
    expect(f.status).toBe('ready');
  });

  it('boundary: at_risk just below ideal/4 (24)', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', 24)])));
    expect(f.status).toBe('at_risk');
  });

  it('ignores ivfflat indexes on tables below the row threshold', async () => {
    const small: PgvectorTable = { schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 9_999 };
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([small], [ivfflatOn('documents', 4)])));
    expect(f.status).toBe('ready');
  });

  it('exempts hnsw indexes — there is no equivalent tuning invariant to check', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory([tenKTable], [
      { schema: 'public', indexName: 'h', table: 'documents', column: 'embedding', accessMethod: 'hnsw', lists: null },
    ])));
    expect(f.status).toBe('ready');
    expect(f.evidence.join(' ')).toContain('hnsw');
  });

  it('reports unknown when an ivfflat index does not record its lists value', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(
      sources, ctxWith(inventory([tenKTable], [ivfflatOn('documents', null)])));
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('lists');
  });

  it('a real mismatch outranks an unreadable sibling index', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory(
      [tenKTable, { schema: 'public', table: 'chunks', column: 'embedding', rowEstimate: 10_000 }],
      [ivfflatOn('documents', null), ivfflatOn('chunks', 4)],
    )));
    expect(f.status).toBe('at_risk');
  });

  it('reports unknown with the generic reason when the catalog read failed', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(null));
    expect(f.status).toBe('unknown');
    expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
  });

  it('is ready when there are no ivfflat indexes at all', async () => {
    const f = await ivfflatListsMismatchRule.evaluate(sources, ctxWith(inventory([tenKTable])));
    expect(f.status).toBe('ready');
  });

  it('exposes the tolerance factor used in its evidence', () => {
    expect(LISTS_TOLERANCE_FACTOR).toBe(4);
  });
});
