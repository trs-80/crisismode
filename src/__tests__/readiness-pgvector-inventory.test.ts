// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import {
  parseIvfflatLists,
  buildPgvectorInventory,
} from '../agent/pg-replication/pgvector-catalog.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('parseIvfflatLists', () => {
  it('reads lists from reloptions', () => {
    expect(parseIvfflatLists(['lists=100'])).toBe(100);
  });
  it('reads lists when other reloptions are present', () => {
    expect(parseIvfflatLists(['fillfactor=90', 'lists=316'])).toBe(316);
  });
  it('returns null when reloptions are absent (never assume pgvector defaults)', () => {
    expect(parseIvfflatLists(null)).toBeNull();
  });
  it('returns null when lists was not set explicitly', () => {
    expect(parseIvfflatLists(['fillfactor=90'])).toBeNull();
  });
});

describe('buildPgvectorInventory', () => {
  it('maps table rows and preserves the estimate', () => {
    const inv = buildPgvectorInventory(
      '0.7.0',
      [{ schema_name: 'public', table_name: 'documents', column_name: 'embedding', row_estimate: 100_000 }],
      [],
    );
    expect(inv.extensionVersion).toBe('0.7.0');
    expect(inv.tables).toEqual([{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }]);
  });

  it('maps reltuples = -1 (never analyzed) to a null estimate, not zero', () => {
    const inv = buildPgvectorInventory(
      '0.7.0',
      [{ schema_name: 'public', table_name: 'documents', column_name: 'embedding', row_estimate: -1 }],
      [],
    );
    expect(inv.tables[0]?.rowEstimate).toBeNull();
  });

  it('maps ivfflat indexes with their lists value', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'documents_embedding_idx', table_name: 'documents',
        access_method: 'ivfflat', column_name: 'embedding', reloptions: ['lists=100'],
      },
    ]);
    expect(inv.indexes).toEqual([{
      schema: 'public', indexName: 'documents_embedding_idx', table: 'documents',
      column: 'embedding', accessMethod: 'ivfflat', lists: 100,
    }]);
  });

  it('maps hnsw indexes with a null lists value (no equivalent tuning knob)', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'chunks_embedding_idx', table_name: 'chunks',
        access_method: 'hnsw', column_name: 'embedding', reloptions: ['m=16'],
      },
    ]);
    expect(inv.indexes[0]?.accessMethod).toBe('hnsw');
    expect(inv.indexes[0]?.lists).toBeNull();
  });

  it('drops index rows with an unrecognised access method', () => {
    const inv = buildPgvectorInventory('0.7.0', [], [
      {
        schema_name: 'public', index_name: 'documents_pkey', table_name: 'documents',
        access_method: 'btree', column_name: 'id', reloptions: null,
      },
    ]);
    expect(inv.indexes).toEqual([]);
  });
});

describe('PgSimulator pgvector fixture', () => {
  it("defaults to 'absent' (the common case: a database with no pgvector)", async () => {
    expect(await new PgSimulator().getPgvectorInventory()).toBe('absent');
  });

  it('returns the configured inventory', async () => {
    const sim = new PgSimulator();
    sim.setPgvectorInventory({
      extensionVersion: '0.7.0',
      tables: [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 50_000 }],
      indexes: [],
    });
    const inv = await sim.getPgvectorInventory();
    expect(inv).not.toBe('absent');
    expect(inv).not.toBeNull();
    expect(typeof inv === 'object' && inv?.tables[0]?.table).toBe('documents');
  });

  it('can simulate a failed catalog read', async () => {
    const sim = new PgSimulator();
    sim.setPgvectorInventory(null);
    expect(await sim.getPgvectorInventory()).toBeNull();
  });
});
