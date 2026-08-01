// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Query execution timeouts for pg connection pools.
 *
 * `connectionTimeoutMillis` bounds how long acquiring a connection may take,
 * not how long a query may run. Without an execution bound, a diagnostic
 * query against a database stuck behind lock contention hangs indefinitely —
 * precisely the state CrisisMode is pointed at.
 *
 * Two settings, doing different jobs:
 *   statement_timeout  server-side; Postgres actually aborts the statement
 *   query_timeout      client-side timer; settles the promise even when the
 *                      connection is wedged and no server reply arrives.
 *                      It does NOT cancel the server-side query, so it is a
 *                      backstop rather than the primary defence.
 *
 * statement_timeout must be the lower of the two, so the informative server
 * error ("canceling statement due to statement timeout") normally wins over
 * the generic client-side "Query read timeout".
 */

import { describe, it, expect } from 'vitest';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
import { DbMigrationLiveClient } from '../agent/db-migration/live-client.js';
import { DEFAULT_STATEMENT_TIMEOUT_MS } from '../agent/pg-common.js';

const CONN = { host: '127.0.0.1', port: 55432, user: 'u', password: 'p', database: 'd' };

/** The subset of pg's Pool we introspect: its resolved options. */
interface PoolWithOptions {
  options: { statement_timeout?: number; query_timeout?: number };
  end(): Promise<void>;
}

function poolsOf(client: unknown): Record<string, PoolWithOptions> {
  return client as Record<string, PoolWithOptions>;
}

describe('pg pool execution timeouts', () => {
  it('bounds statement execution on the primary pool', async () => {
    const client = new PgLiveClient(CONN);
    const { options } = poolsOf(client).primaryPool!;

    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.query_timeout).toBeGreaterThan(DEFAULT_STATEMENT_TIMEOUT_MS);

    await client.close();
  });

  it('bounds statement execution on the replica pool', async () => {
    const client = new PgLiveClient(CONN, { ...CONN, port: 55433 });
    const { options } = poolsOf(client).replicaPool!;

    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.query_timeout).toBeGreaterThan(DEFAULT_STATEMENT_TIMEOUT_MS);

    await client.close();
  });

  it('bounds statement execution on the db-migration pool', async () => {
    const client = new DbMigrationLiveClient(CONN);
    const { options } = poolsOf(client).pool!;

    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.query_timeout).toBeGreaterThan(DEFAULT_STATEMENT_TIMEOUT_MS);

    await client.close();
  });

  it('keeps the client-side timer above the server-side one so the server error wins', async () => {
    const client = new PgLiveClient(CONN);
    const { options } = poolsOf(client).primaryPool!;

    // A client timer at or below statement_timeout would mask the actionable
    // "canceling statement due to statement timeout" with "Query read timeout".
    expect(options.query_timeout!).toBeGreaterThan(options.statement_timeout!);

    await client.close();
  });

  it('honours an explicit per-connection override', async () => {
    const client = new PgLiveClient({ ...CONN, statementTimeoutMs: 45_000 });
    const { options } = poolsOf(client).primaryPool!;

    expect(options.statement_timeout).toBe(45_000);
    expect(options.query_timeout).toBeGreaterThan(45_000);

    await client.close();
  });

  it('applies the override to the replica pool independently', async () => {
    const client = new PgLiveClient(
      { ...CONN, statementTimeoutMs: 20_000 },
      { ...CONN, port: 55433, statementTimeoutMs: 30_000 },
    );
    const pools = poolsOf(client);

    expect(pools.primaryPool!.options.statement_timeout).toBe(20_000);
    expect(pools.replicaPool!.options.statement_timeout).toBe(30_000);

    await client.close();
  });

  it('uses a default short enough to fail fast during a crisis', () => {
    // A recovery tool that hangs is worse than one that reports a timeout.
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
