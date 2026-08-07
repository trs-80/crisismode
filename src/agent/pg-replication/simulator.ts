// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgBackend, ReplicaStatus, ReplicationSlot, ConnectionUsage, IdleInTransactionSession } from './backend.js';
import type { Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import type { TableStat, StatementStat, StatementAggregate, PgvectorInventory } from '../../readiness/types.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

// Mirrors the torture harness's `-c max_connections=25` so simulator-driven
// unit tests exercise the same utilization math as the live scenario.
const SIMULATOR_MAX_CONNECTIONS = 25;

export class PgSimulator implements PgBackend {
  private state: SimulatorState = 'degraded';
  private slotInvalid = true;
  private replayPaused = false;
  private idleInTxSessions: IdleInTransactionSession[] = [];
  private otherActiveConnections = 4;
  // Tracks which replication slots currently exist, independent of the
  // active/wal_status fields queryReplicationSlots() reports. Mutated by
  // executeCommand()'s pg_drop_replication_slot / pg_create_physical_replication_slot
  // handling so the replan()-generated drop/create successCriteria checks
  // (`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '...'`)
  // observe a real state transition instead of falling through to a
  // fail-open default.
  private slotNames = new Set(['replica_us_east_1a', 'replica_us_east_1b', 'replica_us_east_1c']);
  private tableStats: TableStat[] = [];
  private statementStats: StatementStat[] | null = null;
  private statementAggregate: StatementAggregate | null = null;
  private pgvectorInventory: PgvectorInventory | 'absent' | null = 'absent';

  getState(): SimulatorState {
    return this.state;
  }

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  /** Simulate an operator/fault having paused WAL replay on the replica. */
  pauseReplay(): void {
    this.replayPaused = true;
  }

  async queryReplayPaused(): Promise<boolean | null> {
    return this.replayPaused;
  }

  /**
   * Simulate primary connection-pool exhaustion caused by leaked
   * idle-in-transaction sessions (a client opens a transaction and never
   * commits/rolls back or closes the connection). `otherActiveConnections`
   * lets tests independently vary total utilization vs. the number of
   * idle-in-transaction contributors (e.g. high usage from ordinary active
   * queries, with too few idle-in-tx sessions to be the material cause).
   */
  setConnectionPoolExhausted(
    sessionCount = 20,
    otherActiveConnections = 4,
    oldestAgeSeconds?: number,
  ): void {
    this.idleInTxSessions = Array.from({ length: sessionCount }, (_, i) => ({
      pid: 20000 + i,
      ageSeconds: oldestAgeSeconds !== undefined ? oldestAgeSeconds : 90 + i * 5,
      applicationName: 'checkout-worker',
    }));
    this.otherActiveConnections = otherActiveConnections;
  }

  /** Configure the fixture rows returned by queryTableStats(). */
  setTableStats(rows: TableStat[]): void {
    this.tableStats = rows;
  }

  /** Configure the fixture rows returned by queryStatementStats(); null simulates the extension being absent. */
  setStatementStats(rows: StatementStat[] | null): void {
    this.statementStats = rows;
  }

  setStatementAggregate(agg: StatementAggregate | null): void { this.statementAggregate = agg; }

  async queryTableStats(): Promise<TableStat[] | null> {
    return this.tableStats;
  }

  async queryStatementStats(): Promise<StatementStat[] | null> {
    return this.statementStats;
  }

  async queryStatementAggregate(): Promise<StatementAggregate | null> { return this.statementAggregate; }

  /**
   * Configure the pgvector fixture. 'absent' (the default) simulates a
   * database without the extension; null simulates a failed catalog read.
   */
  setPgvectorInventory(inventory: PgvectorInventory | 'absent' | null): void {
    this.pgvectorInventory = inventory;
  }

  async getPgvectorInventory(): Promise<PgvectorInventory | 'absent' | null> {
    return this.pgvectorInventory;
  }

  async queryConnectionUsage(): Promise<ConnectionUsage | null> {
    const idleCount = this.idleInTxSessions.length;
    const total = this.otherActiveConnections + idleCount;
    const byState: Record<string, number> = idleCount > 0
      ? { active: this.otherActiveConnections, 'idle in transaction': idleCount }
      : { active: total };

    return {
      max: SIMULATOR_MAX_CONNECTIONS,
      total,
      byState,
      idleInTransactionOldest: [...this.idleInTxSessions].sort((a, b) => b.ageSeconds - a.ageSeconds),
    };
  }

  async queryReplicationStatus(): Promise<ReplicaStatus[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            client_addr: '10.0.1.50',
            state: 'streaming',
            sent_lsn: '0/5000000',
            write_lsn: '0/4F80000',
            flush_lsn: '0/4F00000',
            replay_lsn: '0/4E00000',
            lag_seconds: 45,
          },
          {
            client_addr: '10.0.1.51',
            state: 'streaming',
            sent_lsn: '0/5000000',
            write_lsn: '0/4F00000',
            flush_lsn: '0/4E80000',
            replay_lsn: '0/4D00000',
            lag_seconds: 78,
          },
          {
            client_addr: '10.0.1.52',
            state: 'streaming',
            sent_lsn: '0/5000000',
            write_lsn: '0/3000000',
            flush_lsn: '0/2F00000',
            replay_lsn: '0/2800000',
            lag_seconds: 342,
          },
        ];
      case 'recovering':
        return [
          {
            client_addr: '10.0.1.50',
            state: 'streaming',
            sent_lsn: '0/5200000',
            write_lsn: '0/5200000',
            flush_lsn: '0/5200000',
            replay_lsn: '0/5180000',
            lag_seconds: 3,
          },
          {
            client_addr: '10.0.1.51',
            state: 'streaming',
            sent_lsn: '0/5200000',
            write_lsn: '0/5200000',
            flush_lsn: '0/5200000',
            replay_lsn: '0/5100000',
            lag_seconds: 8,
          },
        ];
      case 'recovered':
        return [
          {
            client_addr: '10.0.1.50',
            state: 'streaming',
            sent_lsn: '0/5500000',
            write_lsn: '0/5500000',
            flush_lsn: '0/5500000',
            replay_lsn: '0/5500000',
            lag_seconds: 0,
          },
          {
            client_addr: '10.0.1.51',
            state: 'streaming',
            sent_lsn: '0/5500000',
            write_lsn: '0/5500000',
            flush_lsn: '0/5500000',
            replay_lsn: '0/54F0000',
            lag_seconds: 1,
          },
          {
            client_addr: '10.0.1.52',
            state: 'streaming',
            sent_lsn: '0/5500000',
            write_lsn: '0/5500000',
            flush_lsn: '0/5500000',
            replay_lsn: '0/54E0000',
            lag_seconds: 2,
          },
        ];
    }
  }

  async queryReplicationSlots(): Promise<ReplicationSlot[]> {
    const allSlots = this.slotInvalid && this.state !== 'degraded' ? this.invalidSlotFixtures() : this.validSlotFixtures();
    // slotNames is the one source of truth for which slots currently exist
    // (mutated by executeCommand()'s drop/create handling). Filtering here
    // keeps this listing — used by diagnose() and the
    // slot_state_before_drop capture — consistent with the count-based
    // evaluateCheck() query above instead of always reporting all three.
    return allSlots.filter((slot) => this.slotNames.has(slot.slot_name));
  }

  private invalidSlotFixtures(): ReplicationSlot[] {
    return [
      {
        slot_name: 'replica_us_east_1a',
        plugin: '',
        slot_type: 'physical',
        active: true,
        restart_lsn: '0/5100000',
        confirmed_flush_lsn: '',
        wal_status: 'reserved',
      },
      {
        slot_name: 'replica_us_east_1b',
        plugin: '',
        slot_type: 'physical',
        active: false,
        restart_lsn: '0/2800000',
        confirmed_flush_lsn: '',
        wal_status: 'lost',
      },
      {
        slot_name: 'replica_us_east_1c',
        plugin: '',
        slot_type: 'physical',
        active: true,
        restart_lsn: '0/5000000',
        confirmed_flush_lsn: '',
        wal_status: 'reserved',
      },
    ];
  }

  private validSlotFixtures(): ReplicationSlot[] {
    return [
      {
        slot_name: 'replica_us_east_1a',
        plugin: '',
        slot_type: 'physical',
        active: true,
        restart_lsn: '0/5100000',
        confirmed_flush_lsn: '',
        wal_status: 'reserved',
      },
      {
        slot_name: 'replica_us_east_1b',
        plugin: '',
        slot_type: 'physical',
        active: true,
        restart_lsn: '0/5100000',
        confirmed_flush_lsn: '',
        wal_status: 'reserved',
      },
      {
        slot_name: 'replica_us_east_1c',
        plugin: '',
        slot_type: 'physical',
        active: true,
        restart_lsn: '0/5000000',
        confirmed_flush_lsn: '',
        wal_status: 'reserved',
      },
    ];
  }

  async queryConnectionCount(): Promise<number> {
    switch (this.state) {
      case 'degraded':
        return 247;
      case 'recovering':
        return 185;
      case 'recovered':
        return 142;
    }
  }

  markSlotRecreated(): void {
    this.slotInvalid = false;
  }

  async evaluateCheck(check: { type: string; statement?: string; operation?: string; parameters?: Record<string, unknown>; expect: { operator: string; value: unknown } }): Promise<boolean> {
    const stmt = check.statement ?? '';

    // Replica connected/streaming checks — parameterized on whichever
    // address the statement names (plan() interpolates the dynamically
    // chosen worst replica, so this must not be hardcoded to one literal
    // address). Every entry queryReplicationStatus() returns already has
    // `state: 'streaming'`, and the state's replica list IS the model of
    // which replicas are currently connected (e.g. the disconnected target
    // is absent from the 'recovering' list), so "present in the current
    // state's list" answers both the with- and without-state-qualifier
    // forms of this query identically and correctly.
    const clientAddrMatch = /pg_stat_replication WHERE client_addr = '([^']+)'/.exec(stmt);
    if (clientAddrMatch) {
      const targetAddr = clientAddrMatch[1]!;
      const replicas = await this.queryReplicationStatus();
      const count = replicas.some((r) => r.client_addr === targetAddr) ? 1 : 0;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('pg_is_wal_replay_paused')) {
      const paused = this.replayPaused ? 1 : 0;
      return compareCheckValue(paused, check.expect.operator, check.expect.value);
    }

    // Idle-in-transaction count vs. an age threshold — used for both the
    // terminate step's preCondition (>=1 stale sessions exist) and its
    // successCriteria (0 remain after termination). Threshold is read out of
    // the statement text itself so the check stays in sync with whatever
    // threshold the plan embedded.
    if (stmt.includes('pg_stat_activity') && stmt.includes('idle in transaction') && stmt.toLowerCase().includes('count(')) {
      const count = this.countStaleIdleInTx(stmt);
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    // Replication-slot existence check used by replan()'s drop/create steps
    // (`SELECT count(*) FROM pg_replication_slots WHERE slot_name = '...'`).
    // Reflects executeCommand()'s pg_drop_replication_slot /
    // pg_create_physical_replication_slot handling below.
    const slotCountMatch = /FROM pg_replication_slots WHERE slot_name = '([^']+)'/.exec(stmt);
    if (slotCountMatch) {
      const slotName = slotCountMatch[1]!;
      const count = this.slotNames.has(slotName) ? 1 : 0;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }

    // Primary-reachability precondition ("Primary is reachable and accepting
    // connections" / "PostgreSQL is accepting connections") — used as the
    // database_unreachable plan's restart-step success criterion, so this
    // must be an honest probe rather than an unconditional "reachable". The
    // stock PgSimulator's queries never throw, but a subclass modeling an
    // unreachable primary (e.g. UnreachablePgSimulator in
    // pg-unreachable-plan.test.ts, which overrides queryReplicationStatus()
    // to throw) must make this check reflect that instead of always
    // reporting 1.
    if (stmt === 'SELECT 1;') {
      let reachable = 1;
      try {
        await this.queryReplicationStatus();
      } catch {
        reachable = 0;
      }
      return compareCheckValue(reachable, check.expect.operator, check.expect.value);
    }

    if (check.type === 'structured_command' && check.expect.operator === 'eq') {
      return check.expect.value === 'running';
    }

    // Fail closed, matching the live client (and the llm-provider/vector-store
    // precedent): a precondition/success-criteria check on an unrecognized
    // statement is a plan-authoring bug, and this backend must not let it
    // pass silently. Throwing was considered instead, but the graph engine's
    // node functions (src/framework/graph-nodes.ts) call evaluateCheck
    // without a surrounding try/catch — an exception here would propagate
    // out of LangGraph's stream() uncaught rather than surface as a failed
    // step, so `false` is the only semantic both execution engines handle
    // safely.
    return false;
  }

  private countStaleIdleInTx(stmt: string): number {
    const thresholdMatch = /INTERVAL '(\d+) seconds?'/i.exec(stmt);
    const threshold = thresholdMatch ? parseInt(thresholdMatch[1]!, 10) : 0;
    return this.idleInTxSessions.filter((s) => s.ageSeconds >= threshold).length;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type === 'sql') {
      const stmt = command.statement ?? '';
      if (stmt.includes('pg_wal_replay_resume')) {
        this.replayPaused = false;
        return { simulated: true, statement: stmt, replayPaused: this.replayPaused };
      }
      if (stmt.includes('pg_wal_replay_pause')) {
        this.replayPaused = true;
        return { simulated: true, statement: stmt, replayPaused: this.replayPaused };
      }
      if (stmt.includes('pg_is_wal_replay_paused')) {
        return { replay_paused: this.replayPaused };
      }
      if (stmt.includes('pg_drop_replication_slot')) {
        const match = /pg_drop_replication_slot\('([^']+)'\)/.exec(stmt);
        const slotName = match?.[1];
        if (slotName) this.slotNames.delete(slotName);
        return { simulated: true, statement: stmt };
      }
      if (stmt.includes('pg_create_physical_replication_slot')) {
        const match = /pg_create_physical_replication_slot\('([^']+)'\)/.exec(stmt);
        const slotName = match?.[1];
        if (slotName) this.slotNames.add(slotName);
        return { simulated: true, statement: stmt };
      }
      if (stmt.includes('pg_terminate_backend') && stmt.includes('idle in transaction')) {
        const thresholdMatch = /INTERVAL '(\d+) seconds?'/i.exec(stmt);
        const threshold = thresholdMatch ? parseInt(thresholdMatch[1]!, 10) : 0;
        const terminated = this.idleInTxSessions.filter((s) => s.ageSeconds >= threshold);
        this.idleInTxSessions = this.idleInTxSessions.filter((s) => s.ageSeconds < threshold);
        return { simulated: true, statement: stmt, terminatedCount: terminated.length, remaining: this.idleInTxSessions.length };
      }
      if (stmt.includes('FROM pg_stat_replication')) {
        return this.queryReplicationStatus();
      }
      if (stmt.includes('FROM pg_replication_slots')) {
        return this.queryReplicationSlots();
      }
      if (stmt.includes('FROM pg_stat_activity')) {
        return { count: await this.queryConnectionCount() };
      }
      return { simulated: true, statement: stmt };
    }

    if (command.type === 'structured_command') {
      return { simulated: true, operation: command.operation, parameters: command.parameters };
    }

    throw new Error(`Unsupported command type for PostgreSQL simulator: ${command.type}`);
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'postgresql-simulator-sql',
        kind: 'capability_provider',
        name: 'PostgreSQL Simulator SQL Provider',
        maturity: 'simulator_only',
        capabilities: [
          'db.query.read',
          'db.query.write',
          'db.replica.disconnect',
          'db.replication_slot.drop',
          'db.replication_slot.create',
          'db.wal_replay.resume',
          'db.connections.terminate',
        ],
        executionContexts: ['postgresql_read', 'postgresql_write'],
        targetKinds: ['postgresql'],
        commandTypes: ['sql'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'postgresql-simulator-reseed',
        kind: 'capability_provider',
        name: 'PostgreSQL Simulator Replica Reseed Provider',
        maturity: 'simulator_only',
        capabilities: ['db.replica.reseed'],
        executionContexts: ['postgresql_write'],
        targetKinds: ['postgresql'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'simulated-load-balancer',
        kind: 'capability_provider',
        name: 'Simulated Load Balancer Provider',
        maturity: 'simulator_only',
        capabilities: ['traffic.backend.detach', 'traffic.backend.attach'],
        executionContexts: ['linux_process'],
        targetKinds: ['linux'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    // No-op for simulator
  }

}
