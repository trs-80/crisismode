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
import { DEFAULT_STATEMENT_TIMEOUT_MS, poolTimeouts } from '../agent/pg-common.js';

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
    expect(options.query_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS + 5_000);

    await client.close();
  });

  it('bounds statement execution on the replica pool', async () => {
    const client = new PgLiveClient(CONN, { ...CONN, port: 55433 });
    const { options } = poolsOf(client).replicaPool!;

    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.query_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS + 5_000);

    await client.close();
  });

  it('bounds statement execution on the db-migration pool', async () => {
    const client = new DbMigrationLiveClient(CONN);
    const { options } = poolsOf(client).pool!;

    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.query_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS + 5_000);

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
    expect(options.query_timeout).toBe(50_000);

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

  it('keeps the client timer exactly one grace period behind the server bound', () => {
    // Ordering alone is not the contract: the gap has to be wide enough for
    // the server's abort to travel back before the client stops listening.
    expect(poolTimeouts(30_000)).toEqual({
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
  });

  it('uses a default short enough to fail fast during a crisis', () => {
    // A recovery tool that hangs is worse than one that reports a timeout.
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

/**
 * Values Postgres accepts but that quietly remove the bound this fix exists to
 * add. Measured against PostgreSQL 16:
 *   0    -> server reports 0, i.e. statement_timeout disabled
 *   1.5  -> truncated to 1ms, so every statement fails
 *   -1   -> connection rejected: "outside the valid range"
 * Two of the three fail silently, so they are rejected up front.
 */
describe('poolTimeouts rejects values that remove the bound', () => {
  it('rejects zero, which Postgres reads as "no timeout"', () => {
    expect(() => poolTimeouts(0)).toThrow(/positive|disable/i);
  });

  it('rejects negative values', () => {
    expect(() => poolTimeouts(-1)).toThrow(/positive/i);
  });

  it('rejects non-integer values, which Postgres truncates', () => {
    // The message must name the truncation, since 1.5 -> 1ms is the
    // non-obvious part an operator needs told.
    expect(() => poolTimeouts(1.5)).toThrow(/whole number/i);
    expect(() => poolTimeouts(1.5)).toThrow(/truncates/i);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => poolTimeouts(Number.NaN)).toThrow();
    expect(() => poolTimeouts(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('still accepts undefined, meaning "use the default"', () => {
    expect(poolTimeouts(undefined)).toEqual({
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      query_timeout: DEFAULT_STATEMENT_TIMEOUT_MS + 5_000,
    });
  });

  it('surfaces the bad value at client construction rather than at query time', () => {
    expect(() => new PgLiveClient({ ...CONN, statementTimeoutMs: 0 })).toThrow(/positive|disable/i);
    expect(() => new DbMigrationLiveClient({ ...CONN, statementTimeoutMs: 0 })).toThrow(
      /positive|disable/i,
    );
  });
});
