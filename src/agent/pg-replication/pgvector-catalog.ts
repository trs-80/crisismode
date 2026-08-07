// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * pgvector catalog probe: the read-only SQL plus the pure row→inventory
 * mapping. Kept out of PgLiveClient so the mapping and the reloption parsing
 * are unit-testable without a database.
 */

import type { PgvectorIndex, PgvectorInventory, PgvectorTable } from '../../readiness/types.js';

/** Is the `vector` extension installed, and at what version? */
export const PGVECTOR_EXTENSION_SQL = `
  SELECT extversion FROM pg_extension WHERE extname = 'vector'
`;

/** Every user-table column typed `vector`, with the planner's row estimate. */
export const PGVECTOR_TABLES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname AS column_name,
         c.reltuples::float8 AS row_estimate
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE t.typname = 'vector'
    -- relkind = 'r' is ordinary tables only. Partitioned parents ('p') are a
    -- known v1 gap: their reltuples is 0 and the vector column lives on the
    -- children, so including them would report a phantom empty table. Under
    -- the honesty contract a partitioned vector table is invisible to these
    -- rules rather than misreported.
    AND c.relkind = 'r'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY n.nspname, c.relname, a.attname
`;

/**
 * Every ivfflat/hnsw index, with its first indexed column and its reloptions.
 * Restricted to indexes that are actually usable for a query planner right
 * now: `indisvalid`/`indisready` excludes an index stuck mid-CREATE INDEX
 * CONCURRENTLY (or invalidated by a failed build), and `indpred IS NULL`
 * excludes partial indexes — a predicate index only covers a subset of rows,
 * so treating it as full coverage of the column would be a false "ready".
 */
export const PGVECTOR_INDEXES_SQL = `
  SELECT n.nspname AS schema_name,
         ic.relname AS index_name,
         tc.relname AS table_name,
         am.amname AS access_method,
         a.attname AS column_name,
         ic.reloptions AS reloptions
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_am am ON am.oid = ic.relam
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = i.indkey[0]
  WHERE am.amname IN ('ivfflat', 'hnsw')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND i.indisvalid
    AND i.indisready
    AND i.indpred IS NULL
  ORDER BY n.nspname, ic.relname
`;

export interface PgvectorTableRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  row_estimate: number;
}

export interface PgvectorIndexRow {
  schema_name: string;
  index_name: string;
  table_name: string;
  access_method: string;
  column_name: string | null;
  reloptions: string[] | null;
}

/**
 * `lists` from an index's pg_class.reloptions (e.g. `['lists=100']`). Returns
 * null when the option was never set explicitly: pgvector's built-in default
 * is not substituted, because an unstated value is unknown, not assumed.
 */
export function parseIvfflatLists(reloptions: string[] | null): number | null {
  if (!reloptions) return null;
  for (const option of reloptions) {
    const match = /^lists=(\d+)$/.exec(option.trim());
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

function isVectorAccessMethod(name: string): name is PgvectorIndex['accessMethod'] {
  return name === 'ivfflat' || name === 'hnsw';
}

export function buildPgvectorInventory(
  extensionVersion: string,
  tableRows: PgvectorTableRow[],
  indexRows: PgvectorIndexRow[],
): PgvectorInventory {
  const tables: PgvectorTable[] = tableRows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    column: row.column_name,
    // PostgreSQL 14+ uses reltuples = -1 for "never analyzed" — that is an
    // absence of information, not a row count of zero.
    rowEstimate: row.row_estimate < 0 ? null : row.row_estimate,
  }));

  const indexes: PgvectorIndex[] = [];
  for (const row of indexRows) {
    if (!isVectorAccessMethod(row.access_method)) continue;
    indexes.push({
      schema: row.schema_name,
      indexName: row.index_name,
      table: row.table_name,
      column: row.column_name,
      accessMethod: row.access_method,
      lists: row.access_method === 'ivfflat' ? parseIvfflatLists(row.reloptions) : null,
    });
  }

  return { extensionVersion, tables, indexes };
}
