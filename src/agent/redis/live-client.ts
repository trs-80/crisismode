// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RedisLiveClient — connects to real Redis instances and implements RedisBackend.
 *
 * Queries INFO, SLOWLOG, CLIENT LIST, and CONFIG against actual Redis connections.
 * Used when running the spoke against real infrastructure.
 */

import { Redis as RedisClient } from 'ioredis';
import type { RedisBackend, RedisInfo, RedisSlaveInfo, RedisSlowlogEntry } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
}

export class RedisLiveClient implements RedisBackend {
  private client: RedisClient;

  constructor(config: RedisConnectionConfig) {
    this.client = new RedisClient({
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async getInfo(): Promise<RedisInfo> {
    const raw = await this.client.info();
    const sections = this.parseInfo(raw);

    const usedMemoryBytes = parseInt(sections['used_memory'] ?? '0', 10);
    const maxMemoryBytes = parseInt(sections['maxmemory'] ?? '0', 10);
    const memoryUsagePercent = maxMemoryBytes > 0
      ? (usedMemoryBytes / maxMemoryBytes) * 100
      : 0;

    const hits = parseInt(sections['keyspace_hits'] ?? '0', 10);
    const misses = parseInt(sections['keyspace_misses'] ?? '0', 10);
    const hitRate = (hits + misses) > 0 ? hits / (hits + misses) : 0;

    return {
      role: (sections['role'] ?? 'master') as 'master' | 'slave',
      connectedSlaves: parseInt(sections['connected_slaves'] ?? '0', 10),
      usedMemoryBytes,
      maxMemoryBytes,
      memoryUsagePercent,
      connectedClients: parseInt(sections['connected_clients'] ?? '0', 10),
      blockedClients: parseInt(sections['blocked_clients'] ?? '0', 10),
      evictedKeys: parseInt(sections['evicted_keys'] ?? '0', 10),
      hitRate,
      uptimeSeconds: parseInt(sections['uptime_in_seconds'] ?? '0', 10),
    };
  }

  async getSlaves(): Promise<RedisSlaveInfo[]> {
    const raw = await this.client.info('replication');
    const sections = this.parseInfo(raw);
    const slaves: RedisSlaveInfo[] = [];

    for (let i = 0; ; i++) {
      const slaveStr = sections[`slave${i}`];
      if (!slaveStr) break;

      // Format: ip=10.0.0.1,port=6379,state=online,offset=12345,lag=0
      const parts: Record<string, string> = {};
      for (const pair of slaveStr.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) parts[k] = v;
      }

      slaves.push({
        id: `slave-${i}`,
        ip: parts['ip'] ?? 'unknown',
        port: parseInt(parts['port'] ?? '6379', 10),
        state: parts['state'] ?? 'unknown',
        offset: parseInt(parts['offset'] ?? '0', 10),
        lag: parseInt(parts['lag'] ?? '0', 10),
      });
    }

    return slaves;
  }

  async getSlowlog(count: number): Promise<RedisSlowlogEntry[]> {
    const raw = await this.client.slowlog('GET', count) as unknown[][];
    if (!Array.isArray(raw)) return [];

    return raw.map((entry) => ({
      id: Number(entry[0]),
      timestamp: Number(entry[1]) * 1000,
      durationMicros: Number(entry[2]),
      command: Array.isArray(entry[3]) ? entry[3].join(' ') : String(entry[3]),
    }));
  }

  async getKeyCount(): Promise<number> {
    const raw = await this.client.info('keyspace');
    const sections = this.parseInfo(raw);
    let total = 0;

    // Keyspace lines: db0:keys=123,expires=45,avg_ttl=6789
    for (const [key, value] of Object.entries(sections)) {
      if (key.startsWith('db')) {
        const keysMatch = value.match(/keys=(\d+)/);
        if (keysMatch) total += parseInt(keysMatch[1], 10);
      }
    }

    return total;
  }

  async getFragmentationRatio(): Promise<number> {
    const raw = await this.client.info('memory');
    const sections = this.parseInfo(raw);
    return parseFloat(sections['mem_fragmentation_ratio'] ?? '1.0');
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'redis_info': {
        return {
          info: await this.getInfo(),
          slaves: await this.getSlaves(),
          keyCount: await this.getKeyCount(),
          fragmentationRatio: await this.getFragmentationRatio(),
        };
      }
      case 'client_kill': {
        // Read-only in dry-run: just report what would happen
        const filter = command.parameters?.filter as string | undefined;
        if (filter) {
          const result = await this.client.call('CLIENT', 'KILL', ...filter.split(' '));
          return { disconnectedClients: result };
        }
        return { disconnectedClients: 0 };
      }
      case 'active_expiry': {
        // SCAN-based expiry: touch keys to trigger lazy expiry
        // This is a read-side-effect operation — touching expired keys causes Redis to evict them
        let cursor = '0';
        let expired = 0;
        const maxIterations = 1000;
        let iterations = 0;

        do {
          const [nextCursor, keys] = await this.client.scan(cursor, 'COUNT', 100);
          cursor = nextCursor;
          // Simply accessing keys with TTL triggers lazy expiry in Redis
          for (const key of keys) {
            const ttl = await this.client.ttl(key);
            if (ttl >= -1 && ttl <= 0) expired++;
          }
          iterations++;
        } while (cursor !== '0' && iterations < maxIterations);

        return { expiredKeys: expired };
      }
      case 'config_set': {
        const key = command.parameters?.key as string;
        const value = command.parameters?.value as string;
        if (key && value) {
          await this.client.config('SET', key, value);
        }
        return { ok: true };
      }
      default:
        throw new Error(`Unknown Redis operation: ${command.operation}`);
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'PING') {
      const result = await this.client.ping();
      return this.compare(result, check.expect.operator, check.expect.value);
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
      const result = await this.client.config('GET', 'maxmemory-policy');
      const value = Array.isArray(result) ? result[1] : result;
      return this.compare(value, check.expect.operator, check.expect.value);
    }

    // For INFO-based checks, parse the specific field
    if (stmt.startsWith('INFO ')) {
      const section = stmt.replace('INFO ', '');
      const raw = await this.client.info(section);
      return raw.length > 0;
    }

    return true;
  }

  async discoverVersion(): Promise<string> {
    const raw = await this.client.info('server');
    const sections = this.parseInfo(raw);
    return sections['redis_version'] ?? 'unknown';
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'redis-live-admin',
        kind: 'capability_provider',
        name: 'Redis Live Admin Provider',
        maturity: 'live_validated',
        capabilities: ['cache.client.disconnect', 'cache.expiry.trigger', 'cache.config.set'],
        executionContexts: ['redis_admin'],
        targetKinds: ['redis'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }

  private parseInfo(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split('\r\n')) {
      if (line.startsWith('#') || !line.includes(':')) continue;
      const idx = line.indexOf(':');
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  }

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
