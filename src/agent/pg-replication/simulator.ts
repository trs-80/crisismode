// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { PgBackend, ReplicaStatus, ReplicationSlot } from './backend.js';
import type { Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class PgSimulator implements PgBackend {
  private state: SimulatorState = 'degraded';
  private slotInvalid = true;

  getState(): SimulatorState {
    return this.state;
  }

  transition(to: string): void {
    this.state = to as SimulatorState;
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
    if (this.slotInvalid && this.state !== 'degraded') {
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

    if (stmt.includes('pg_stat_replication') && stmt.includes("client_addr = '10.0.1.52'") && stmt.includes("state = 'streaming'")) {
      const count = this.state === 'degraded' ? 1 : this.state === 'recovered' ? 1 : 0;
      return this.compareValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('pg_stat_replication') && stmt.includes("client_addr = '10.0.1.52'") && !stmt.includes("state = 'streaming'")) {
      const count = this.state === 'recovered' ? 1 : this.state === 'degraded' ? 1 : 0;
      return this.compareValue(count, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('replay_lag') && stmt.includes("client_addr = '10.0.1.52'")) {
      const count = this.state === 'recovered' ? 1 : 0;
      return this.compareValue(count, check.expect.operator, check.expect.value);
    }

    if (check.type === 'structured_command' && check.expect.operator === 'eq') {
      return check.expect.value === 'running';
    }

    return true;
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type === 'sql') {
      const stmt = command.statement ?? '';
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

  private compareValue(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);
    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
