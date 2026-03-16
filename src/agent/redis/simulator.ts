// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RedisBackend, RedisInfo, RedisSlaveInfo, RedisSlowlogEntry } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class RedisSimulator implements RedisBackend {
  private state: SimulatorState = 'degraded';
  private evictionPolicy = 'volatile-lru';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getInfo(): Promise<RedisInfo> {
    switch (this.state) {
      case 'degraded':
        return {
          role: 'master',
          connectedSlaves: 2,
          usedMemoryBytes: 13_958_643_712,  // ~13GB
          maxMemoryBytes: 16_106_127_360,   // ~15GB
          memoryUsagePercent: 86.7,
          connectedClients: 847,
          blockedClients: 23,
          evictedKeys: 145_230,
          hitRate: 0.72,
          uptimeSeconds: 1_296_000,
        };
      case 'recovering':
        return {
          role: 'master',
          connectedSlaves: 2,
          usedMemoryBytes: 10_737_418_240,  // ~10GB
          maxMemoryBytes: 16_106_127_360,
          memoryUsagePercent: 66.7,
          connectedClients: 412,
          blockedClients: 3,
          evictedKeys: 145_230,
          hitRate: 0.85,
          uptimeSeconds: 1_296_060,
        };
      case 'recovered':
        return {
          role: 'master',
          connectedSlaves: 2,
          usedMemoryBytes: 8_053_063_680,   // ~7.5GB
          maxMemoryBytes: 16_106_127_360,
          memoryUsagePercent: 50.0,
          connectedClients: 285,
          blockedClients: 0,
          evictedKeys: 145_230,
          hitRate: 0.94,
          uptimeSeconds: 1_296_120,
        };
    }
  }

  async getSlaves(): Promise<RedisSlaveInfo[]> {
    return [
      {
        id: 'slave-0',
        ip: '10.0.2.50',
        port: 6379,
        state: this.state === 'degraded' ? 'online' : 'online',
        offset: this.state === 'degraded' ? 45_230_100 : 45_280_000,
        lag: this.state === 'degraded' ? 12 : 0,
      },
      {
        id: 'slave-1',
        ip: '10.0.2.51',
        port: 6379,
        state: this.state === 'degraded' ? 'online' : 'online',
        offset: this.state === 'degraded' ? 45_200_000 : 45_280_000,
        lag: this.state === 'degraded' ? 45 : 1,
      },
    ];
  }

  async getSlowlog(count: number): Promise<RedisSlowlogEntry[]> {
    if (this.state === 'degraded') {
      return [
        { id: 1, timestamp: Date.now() - 5000, durationMicros: 2_500_000, command: 'KEYS session:*' },
        { id: 2, timestamp: Date.now() - 3000, durationMicros: 1_800_000, command: 'SMEMBERS large-set' },
        { id: 3, timestamp: Date.now() - 1000, durationMicros: 950_000, command: 'HGETALL user:cache:*' },
      ].slice(0, count);
    }
    return [];
  }

  async getKeyCount(): Promise<number> {
    switch (this.state) {
      case 'degraded': return 12_450_000;
      case 'recovering': return 9_200_000;
      case 'recovered': return 6_800_000;
    }
  }

  async getFragmentationRatio(): Promise<number> {
    switch (this.state) {
      case 'degraded': return 2.3;
      case 'recovering': return 1.6;
      case 'recovered': return 1.1;
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported Redis simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'redis_info':
        return {
          info: await this.getInfo(),
          slaves: await this.getSlaves(),
          keyCount: await this.getKeyCount(),
          fragmentationRatio: await this.getFragmentationRatio(),
        };
      case 'client_kill':
        this.transition('recovering');
        return { disconnectedClients: true };
      case 'active_expiry':
        this.transition('recovered');
        return { expiredKeys: true };
      case 'config_set':
        if (command.parameters?.key === 'maxmemory-policy') {
          this.evictionPolicy = String(command.parameters.value);
        }
        return { ok: true };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'PING') {
      return this.compare('PONG', check.expect.operator, check.expect.value);
    }

    if (stmt.includes('used_memory_percent')) {
      const info = await this.getInfo();
      return this.compare(info.memoryUsagePercent, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('connected_clients')) {
      const info = await this.getInfo();
      return this.compare(info.connectedClients, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('blocked_clients')) {
      const info = await this.getInfo();
      return this.compare(info.blockedClients, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('evicted_keys')) {
      const info = await this.getInfo();
      return this.compare(info.evictedKeys, check.expect.operator, check.expect.value);
    }

    if (stmt === 'CONFIG GET maxmemory-policy') {
      return this.compare(this.evictionPolicy, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'redis-simulator-admin',
        kind: 'capability_provider',
        name: 'Redis Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: ['cache.client.disconnect', 'cache.expiry.trigger', 'cache.config.set'],
        executionContexts: ['redis_admin'],
        targetKinds: ['redis'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

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
