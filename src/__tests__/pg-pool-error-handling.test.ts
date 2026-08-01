// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Idle-client error handling for pg connection pools.
 *
 * node-postgres emits 'error' on the Pool when a *connected, idle* client is
 * dropped — backend restart, network partition, failover. Node's EventEmitter
 * throws unhandled 'error' events, so a Pool with no listener takes the whole
 * process down. Those are exactly the conditions CrisisMode is built to run
 * in, so a missing listener means the recovery tool dies at the moment it is
 * needed most.
 *
 * These tests assert the observable behaviour (emitting does not throw), not
 * the presence of a particular listener function.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import pg from 'pg';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
import { DbMigrationLiveClient } from '../agent/db-migration/live-client.js';

const CONN = { host: '127.0.0.1', port: 55432, user: 'u', password: 'p', database: 'd' };

/** A Pool as far as these tests care: an EventEmitter with end(). */
interface EmittingPool {
  emit(event: string, ...args: unknown[]): boolean;
  end(): Promise<void>;
}

function idleClientError(): Error {
  return new Error('Connection terminated unexpectedly');
}

describe('pg pool idle-client error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when the primary pool emits an idle-client error', async () => {
    const client = new PgLiveClient(CONN);
    const pool = (client as unknown as { primaryPool: EmittingPool }).primaryPool;

    expect(() => pool.emit('error', idleClientError())).not.toThrow();

    await client.close();
  });

  it('does not throw when the replica pool emits an idle-client error', async () => {
    const client = new PgLiveClient(CONN, { ...CONN, host: '127.0.0.1', port: 55433 });
    const pool = (client as unknown as { replicaPool: EmittingPool }).replicaPool;

    expect(() => pool.emit('error', idleClientError())).not.toThrow();

    await client.close();
  });

  it('does not throw when the db-migration pool emits an idle-client error', async () => {
    const client = new DbMigrationLiveClient(CONN);
    const pool = (client as unknown as { pool: EmittingPool }).pool;

    expect(() => pool.emit('error', idleClientError())).not.toThrow();

    await client.close();
  });

  it('keeps the same pool serving queries after an idle-client error', async () => {
    // Spy on the prototype rather than swapping the field, so the query is
    // answered by the *real* pool instance — the one carrying the listener.
    // Replacing client.primaryPool would assert on a stand-in that never saw
    // the error, which proves nothing about the pool surviving.
    const query = vi
      .spyOn(pg.Pool.prototype, 'query')
      .mockResolvedValue({ rows: [{ server_version: '16.2' }], rowCount: 1 });

    const client = new PgLiveClient(CONN);
    const pool = (client as unknown as { primaryPool: EmittingPool }).primaryPool;

    pool.emit('error', idleClientError());

    // node-postgres discards the broken client internally; the pool itself
    // goes on serving new checkouts.
    await expect(client.discoverVersion()).resolves.toBe('16.2');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.instances[0]).toBe(pool);

    await client.close();
  });
});
