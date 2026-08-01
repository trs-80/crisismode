// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared PostgreSQL pool helpers for agents that talk to Postgres
 * (pg-replication, db-migration).
 */

import type { Pool as PoolType } from 'pg';

/**
 * Default server-side bound on how long a single statement may run.
 *
 * Every query these agents issue is a diagnostic read of pg_stat_*, a
 * replication-slot lookup, or a short function call such as
 * pg_wal_replay_resume() — all sub-second on a healthy system. Ten seconds is
 * therefore generous, while still guaranteeing that a database wedged behind
 * lock contention produces a reported timeout rather than a hang. For a tool
 * that runs during an incident, hanging is the worse failure: it withholds
 * the diagnosis at the moment it is wanted.
 *
 * Override per connection with `statementTimeoutMs` when a target legitimately
 * runs longer recovery statements.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Head start given to the server-side abort over the client-side timer.
 *
 * query_timeout does not cancel anything server-side — it just stops waiting.
 * Letting it fire first would replace Postgres's actionable "canceling
 * statement due to statement timeout" with a generic "Query read timeout"
 * while the backend kept working.
 */
const QUERY_TIMEOUT_GRACE_MS = 5_000;

/** Execution bounds to merge into a pg Pool config. */
export function poolTimeouts(statementTimeoutMs?: number): {
  statement_timeout: number;
  query_timeout: number;
} {
  const statement = statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  return {
    statement_timeout: statement,
    query_timeout: statement + QUERY_TIMEOUT_GRACE_MS,
  };
}

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
