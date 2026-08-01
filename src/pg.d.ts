// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

declare module 'pg' {
  export interface PoolConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    max?: number;
    idleTimeoutMillis?: number;
    /** How long acquiring a connection may take. Not an execution bound. */
    connectionTimeoutMillis?: number;
    /**
     * Server-side execution bound, in ms. Sent in the startup packet, so
     * Postgres itself aborts the statement. This is the real defence.
     */
    statement_timeout?: number;
    /**
     * Client-side read timer, in ms. Settles the promise when the connection
     * is wedged and no server reply arrives. It does NOT cancel the
     * server-side query, so keep it above statement_timeout.
     */
    query_timeout?: number;
  }

  export interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number | null;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
    /**
     * Emitted when a connected, *idle* client is dropped (backend restart,
     * failover, network partition). Node throws unhandled 'error' events, so
     * every pool must register a listener — see guardPoolErrors in
     * src/agent/pg-common.ts.
     */
    on(event: 'error', listener: (err: Error, client: unknown) => void): this;
  }

  const pg: { Pool: typeof Pool };
  export default pg;
}
