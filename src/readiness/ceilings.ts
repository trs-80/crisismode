// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Capacity ceilings: honest per-component upper bounds computed from
 * declared config and measured latency. Ceilings are report CONTEXT —
 * they never affect the readiness score or verdict.
 */

import type {
  CapacityCeiling, CeilingsResult, OmittedCeiling, ReadinessContext, ReadinessSources,
} from './types.js';

/** Every Little-derived bound is optimistic: residence time inflates under load. */
const AT_MOST_CAVEAT =
  'This is an upper bound ("at most") — latency grows with utilization, so real capacity is lower; systems degrade well before the ceiling (~80% is the practical wall).';

/** 1 Mbps = 125_000 bytes/s. */
const BYTES_PER_MBPS = 125_000;

/** Cited community range for a single Node.js instance on light handlers. */
const NODE_TYPICAL_LOW_RPS = 1_000;
const NODE_TYPICAL_HIGH_RPS = 5_000;
/** package.json frameworks that imply a Node.js runtime for the app tier. */
const NODE_FRAMEWORKS = new Set(['express', 'fastify', 'next', 'remix', 'nest']);

export async function computeCeilings(
  sources: ReadinessSources,
  ctx: ReadinessContext,
): Promise<CeilingsResult> {
  const ceilings: CapacityCeiling[] = [];
  const omitted: OmittedCeiling[] = [];

  const usage = await sources.connectionUsage();
  if (usage) {
    ceilings.push({
      id: 'db-connections',
      title: 'Database concurrent queries',
      value: usage.max,
      unit: 'connections',
      evidenceClasses: ['declared'],
      evidence: [`max_connections = ${usage.max} (declared)`],
      caveat: AT_MOST_CAVEAT,
    });

    const agg = (await sources.statementAggregate?.()) ?? null;
    if (agg && agg.meanMs > 0) {
      // Little's law: λ_max = C / W
      ceilings.push({
        id: 'db-throughput',
        title: 'Database throughput',
        value: Math.round(usage.max * (1000 / agg.meanMs)),
        unit: 'queries/s',
        evidenceClasses: ['declared', 'measured'],
        evidence: [
          `max_connections = ${usage.max} (declared)`,
          `mean query time = ${agg.meanMs.toFixed(1)}ms over ${agg.calls} calls (measured, pg_stat_statements)`,
        ],
        caveat: AT_MOST_CAVEAT,
      });
    } else {
      omitted.push({ id: 'db-throughput', reason: 'mean query time unavailable (pg_stat_statements absent or empty)' });
    }
  } else {
    omitted.push({ id: 'db-connections', reason: 'could not read max_connections' });
    omitted.push({ id: 'db-throughput', reason: 'could not read max_connections' });
  }

  const redis = (await sources.redisLimits?.()) ?? null;
  if (redis) {
    if (redis.maxmemoryBytes > 0) {
      ceilings.push({
        id: 'redis-memory',
        title: 'Redis memory',
        value: redis.maxmemoryBytes,
        unit: 'bytes',
        evidenceClasses: ['declared', 'measured'],
        evidence: [
          `maxmemory = ${redis.maxmemoryBytes} bytes (declared)`,
          `used_memory = ${redis.usedMemoryBytes} bytes (measured)`,
        ],
        caveat: AT_MOST_CAVEAT,
      });
    } else {
      omitted.push({
        id: 'redis-memory',
        reason: 'maxmemory = 0 (unlimited) — bounded by host memory, not a declared limit',
      });
    }
    ceilings.push({
      id: 'redis-clients',
      title: 'Redis client connections',
      value: redis.maxclients,
      unit: 'connections',
      evidenceClasses: ['declared', 'measured'],
      evidence: [
        `maxclients = ${redis.maxclients} (declared)`,
        `connected_clients = ${redis.connectedClients} (measured)`,
      ],
      caveat: AT_MOST_CAVEAT,
    });
  } else {
    omitted.push({ id: 'redis-limits', reason: 'no Redis target or limits unreadable' });
  }

  if (ctx.serverless) {
    omitted.push({ id: 'fd-limit', reason: 'suppressed on serverless platforms — the local file-descriptor limit is not the app host\'s limit' });
  } else {
    const fd = (await sources.fdLimit?.()) ?? null;
    if (fd !== null) {
      ceilings.push({
        id: 'fd-limit',
        title: 'File descriptors (this machine)',
        value: fd,
        unit: 'open sockets/files',
        evidenceClasses: ['declared'],
        evidence: [`open-files soft limit = ${fd} (declared, this machine)`],
        caveat: AT_MOST_CAVEAT,
      });
    } else {
      omitted.push({ id: 'fd-limit', reason: 'file-descriptor limit unreadable' });
    }
  }

  const mbps = (await sources.declaredEgressMbps?.()) ?? null;
  if (mbps !== null) {
    ceilings.push({
      id: 'network-egress',
      title: 'Network egress',
      value: mbps * BYTES_PER_MBPS,
      unit: 'bytes/s',
      evidenceClasses: ['declared'],
      evidence: [`network.egressMbps = ${mbps} (declared in crisismode.yaml)`],
      caveat: AT_MOST_CAVEAT,
    });
  } else {
    omitted.push({ id: 'network-egress', reason: 'no declared link speed (set network.egressMbps in crisismode.yaml)' });
  }

  const fw = ctx.stack.appStack.framework;
  if (fw && NODE_FRAMEWORKS.has(fw)) {
    ceilings.push({
      id: 'node-typical',
      title: 'Node.js single instance (typical range)',
      value: null,
      unit: 'requests/s',
      rangeLow: NODE_TYPICAL_LOW_RPS,
      rangeHigh: NODE_TYPICAL_HIGH_RPS,
      evidenceClasses: ['typical'],
      evidence: [
        `framework = ${fw}; typical single-instance Node.js HTTP throughput for light handlers (community benchmarks) — NOT a measurement of this system`,
      ],
      caveat: 'Cited community range — not an upper bound and not a measurement of this system; CPU-bound handlers serialize on the event loop and land far lower.',
    });
  }

  return { ceilings, omitted };
}
