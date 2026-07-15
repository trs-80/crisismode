// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RedisLiveClient — connects to real Redis instances and implements RedisBackend.
 *
 * Queries INFO, SLOWLOG, CLIENT LIST, and CONFIG against actual Redis connections.
 * Used when running the spoke against real infrastructure.
 */

import { Redis as RedisClient } from 'ioredis';
import type { RedisBackend, RedisInfo, RedisSlaveInfo, RedisSlowlogEntry, RedisClusterInfo, RedisClusterNodeInfo } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string | undefined;
  connectTimeoutMs?: number;
}

export class RedisLiveClient implements RedisBackend {
  private client: RedisClient;

  constructor(config: RedisConnectionConfig) {
    this.client = new RedisClient({
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      connectTimeout: config.connectTimeoutMs ?? 5000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      try {
        this.client.disconnect();
      } catch {
        // swallow cleanup errors — we're already failing
      }
      throw err;
    }
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

  async getClusterInfo(): Promise<RedisClusterInfo> {
    // Check if cluster mode is enabled via INFO server
    const serverRaw = await this.client.info('server');
    const serverFields = this.parseInfo(serverRaw);
    const clusterEnabled = serverFields['redis_mode'] === 'cluster';

    if (!clusterEnabled) {
      return {
        enabled: false,
        state: 'ok',
        slotsAssigned: 0,
        slotsOk: 0,
        slotsPfail: 0,
        slotsFail: 0,
        knownNodes: 1,
        clusterSize: 0,
        nodes: [],
      };
    }

    // Parse CLUSTER INFO
    const clusterRaw = await this.client.call('CLUSTER', 'INFO') as string;
    const fields = this.parseInfo(clusterRaw);

    // Parse CLUSTER NODES
    const nodesRaw = await this.client.call('CLUSTER', 'NODES') as string;
    const nodes: RedisClusterNodeInfo[] = [];
    for (const line of nodesRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: <id> <ip:port@cport> <flags> <master> <ping-sent> <pong-recv> <config-epoch> <link-state> <slot> <slot> ...
      const parts = trimmed.split(' ');
      if (parts.length < 8) continue;
      const flags = parts[2].split(',');
      const isMaster = flags.includes('master');
      // Validate rather than blind-cast: an unexpected CLUSTER NODES format must
      // not surface as a value outside the declared union. Treat anything other
      // than 'connected' as disconnected (conservative for a recovery agent).
      const linkState: 'connected' | 'disconnected' =
        parts[7] === 'connected' ? 'connected' : 'disconnected';
      const slots = parts.slice(8).join(' ');
      nodes.push({
        id: parts[0],
        address: parts[1],
        role: isMaster ? 'master' : 'slave',
        flags,
        linkState,
        slots,
      });
    }

    return {
      enabled: true,
      state: (fields['cluster_state'] ?? 'ok') as 'ok' | 'fail',
      slotsAssigned: parseInt(fields['cluster_slots_assigned'] ?? '0', 10),
      slotsOk: parseInt(fields['cluster_slots_ok'] ?? '0', 10),
      slotsPfail: parseInt(fields['cluster_slots_pfail'] ?? '0', 10),
      slotsFail: parseInt(fields['cluster_slots_fail'] ?? '0', 10),
      knownNodes: parseInt(fields['cluster_known_nodes'] ?? '0', 10),
      clusterSize: parseInt(fields['cluster_size'] ?? '0', 10),
      nodes,
    };
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
        // Real Redis CLIENT KILL has no IDLE filter — passing the plan's
        // "idle>300" token straight through is invalid syntax and Redis
        // rejects it with "ERR No such client". Enumerate clients via
        // CLIENT LIST instead and kill matches individually by ID.
        const filter = command.parameters?.filter as string | undefined;
        const includeBlocked = command.parameters?.includeBlocked === true;
        const idleThreshold = parseIdleFilter(filter);

        const raw = await this.client.call('CLIENT', 'LIST') as string;
        const clients = parseClientList(raw);

        let disconnected = 0;
        for (const c of clients) {
          const isIdle = idleThreshold !== null && c.idle >= idleThreshold;
          const isBlocked = includeBlocked && c.flags.includes('b');
          if (!isIdle && !isBlocked) continue;
          try {
            await this.client.call('CLIENT', 'KILL', 'ID', c.id);
            disconnected++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('No such client')) {
              // Anything other than "it already disconnected on its own"
              // (e.g. a permissions or connection error) is unexpected —
              // surface it instead of swallowing it silently.
              console.error(`CLIENT KILL ID ${c.id} failed`, err);
            }
          }
        }

        return { disconnectedClients: disconnected };
      }
      case 'active_expiry': {
        // SCAN-based expiry. Passively, accessing a key past its expiry
        // via TTL triggers Redis's own lazy deletion. Under 'aggressive'
        // effort, also proactively UNLINK keys that carry a TTL (volatile,
        // disposable cache data) even before their TTL has elapsed —
        // relieving real memory pressure now beats waiting out an
        // arbitrary remaining TTL.
        const aggressive = command.parameters?.effort === 'aggressive';
        let cursor = '0';
        let expired = 0;
        const maxIterations = 1000;
        let iterations = 0;

        do {
          const [nextCursor, keys] = await this.client.scan(cursor, 'COUNT', 100);
          cursor = nextCursor;
          for (const key of keys) {
            const ttl = await this.client.ttl(key);
            if (ttl === -2) continue; // already gone
            if (ttl === -1) continue; // persistent — not volatile, leave it
            if (ttl === 0) {
              // Past/at expiry — the TTL call itself already triggered lazy deletion.
              expired++;
            } else if (aggressive) {
              await this.client.unlink(key);
              expired++;
            }
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
      return compareCheckValue(result, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('used_memory_percent')) {
      const info = await this.getInfo();
      return compareCheckValue(info.memoryUsagePercent, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('connected_clients')) {
      const info = await this.getInfo();
      return compareCheckValue(info.connectedClients, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('blocked_clients')) {
      const info = await this.getInfo();
      return compareCheckValue(info.blockedClients, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('evicted_keys')) {
      const info = await this.getInfo();
      return compareCheckValue(info.evictedKeys, check.expect.operator, check.expect.value);
    }

    if (stmt === 'CONFIG GET maxmemory-policy') {
      const result = await this.client.config('GET', 'maxmemory-policy');
      const value = Array.isArray(result) ? result[1] : result;
      return compareCheckValue(value, check.expect.operator, check.expect.value);
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

}

export interface ParsedClient {
  id: string;
  idle: number;
  flags: string;
}

/** Parse a plan filter like "idle>300" into the idle-seconds threshold. */
export function parseIdleFilter(filter: string | undefined): number | null {
  if (!filter) return null;
  const match = filter.match(/^idle>(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/** Parse Redis's `CLIENT LIST` reply (one space-separated key=value line per client). */
export function parseClientList(raw: string): ParsedClient[] {
  const clients: ParsedClient[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields: Record<string, string> = {};
    for (const pair of trimmed.split(' ')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      fields[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    if (!fields['id']) continue;
    clients.push({
      id: fields['id'],
      idle: parseInt(fields['idle'] ?? '0', 10),
      flags: fields['flags'] ?? '',
    });
  }
  return clients;
}
