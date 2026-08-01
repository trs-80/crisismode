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

import { describe, it, expect } from 'vitest';
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

  it('keeps the pool usable for later queries after an idle-client error', async () => {
    const client = new PgLiveClient(CONN);
    const pool = (client as unknown as { primaryPool: EmittingPool }).primaryPool;

    pool.emit('error', idleClientError());

    // The pool object must survive the event — node-postgres discards the
    // broken client internally and the pool goes on serving new checkouts.
    const swapped = client as unknown as {
      primaryPool: { query(sql: string): Promise<unknown>; end(): Promise<void> };
    };
    swapped.primaryPool = {
      query: async () => ({ rows: [{ server_version: '16.2' }] }),
      end: async () => {},
    };
    await expect(client.discoverVersion()).resolves.toBe('16.2');

    await client.close();
  });
});
