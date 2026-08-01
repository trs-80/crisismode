// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared PostgreSQL pool helpers for agents that talk to Postgres
 * (pg-replication, db-migration).
 */

import type { Pool as PoolType } from 'pg';

/**
 * Attach the idle-client error handler every pg pool needs.
 *
 * node-postgres emits 'error' on the Pool when a *connected, idle* client is
 * dropped — backend restart, failover, network partition. Node throws
 * unhandled 'error' events, so a pool without this listener takes the process
 * down. Those are precisely the conditions CrisisMode exists to operate in,
 * so the pool must absorb them instead.
 *
 * node-postgres has already terminated and discarded the broken client by the
 * time this fires; the pool stays usable for subsequent checkouts. Logging to
 * stderr keeps stdout clean for `--json` output.
 */
export function guardPoolErrors(pool: PoolType, label: string): PoolType {
  pool.on('error', (err: Error) => {
    console.error(`[pg:${label}] idle client dropped (pool still usable): ${err.message}`);
  });
  return pool;
}
