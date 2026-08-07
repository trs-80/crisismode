// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { vectorIndexMissingRule, VECTOR_MIN_ROWS } from '../readiness/rules/vector-index-missing.js';
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
