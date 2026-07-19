// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Readiness pipeline: build context from stack discovery, connect the pg
 * live client, run applicable rules with per-rule error isolation, score.
 *
 * Honesty policy: a connection failure becomes an explicit can't-assess
 * finding in the report. There is no fallback to simulated data.
 */

import { discoverStack } from '../cli/autodiscovery.js';
import { resolveCredentials } from '../config/credentials.js';
import { loadConfigWithDetection } from '../config/loader.js';
import { PgLiveClient, type PgConnectionConfig } from '../agent/pg-replication/live-client.js';
import { RedisLiveClient, type RedisConnectionConfig } from '../agent/redis/live-client.js';
import type { ConnectionUsage } from '../agent/pg-replication/backend.js';
import type { TargetConfig } from '../config/schema.js';
import { buildReport } from './report.js';
import { computeCeilings } from './ceilings.js';
import { rankWeakLink } from './weak-link.js';
import { allRules } from './rules/index.js';
import type {
  ReadinessContext, ReadinessFinding, ReadinessReport, ReadinessRule, ReadinessSources,
  TableStat, StatementStat, StatementAggregate, RedisLimits,
} from './types.js';

export async function runRules(
  rules: ReadinessRule[],
  sources: ReadinessSources,
  ctx: ReadinessContext,
): Promise<ReadinessFinding[]> {
  const findings: ReadinessFinding[] = [];
  for (const rule of rules) {
    if (!rule.applicable(ctx)) continue;
    try {
      findings.push(await rule.evaluate(sources, ctx));
    } catch (err) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        status: 'unknown',
        evidence: [],
        explanation: 'This rule could not be evaluated.',
        fix: 'Re-run once the underlying error is resolved.',
        learnMoreUrl: 'https://github.com/trs-80/crisismode',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return findings;
}

function cantAssess(reason: string): ReadinessFinding {
  return {
    ruleId: 'readiness',
    title: 'Scale readiness',
    status: 'unknown',
    evidence: [],
    explanation: 'CrisisMode could not reach the database to assess readiness.',
    fix: 'Check DATABASE_URL and that the database accepts connections from this machine.',
    learnMoreUrl: 'https://www.postgresql.org/docs/current/monitoring.html',
    reason,
  };
}

/**
 * Narrow surface `connectAndRunReadiness` needs from the pg client. PgLiveClient
 * satisfies this structurally; tests substitute a fake without having to fake its
 * private pool fields.
 */
interface ReadinessPgClient {
  queryConnectionCount(): Promise<number>;
  queryConnectionUsage(): Promise<ConnectionUsage | null>;
  queryTableStats(): Promise<TableStat[] | null>;
  queryStatementStats(): Promise<StatementStat[] | null>;
  queryStatementAggregate(): Promise<StatementAggregate | null>;
  close(): Promise<void>;
}

type PgClientFactory = (primary: PgConnectionConfig, replica?: PgConnectionConfig) => ReadinessPgClient;

const defaultClientFactory: PgClientFactory = (primary, replica) => new PgLiveClient(primary, replica);

/**
 * Narrow surface for the optional Redis ceiling probe. `RedisLiveClient`
 * satisfies this structurally. Unlike the pg client, connecting is lazy:
 * ioredis's `lazyConnect` defers the TCP handshake until the first command,
 * which `queryServerLimits()` issues — so no connection is attempted unless
 * a rule/ceiling actually calls `sources.redisLimits()`.
 */
interface ReadinessRedisClient {
  queryServerLimits(): Promise<RedisLimits | null>;
  close(): Promise<void>;
}

type RedisClientFactory = (config: RedisConnectionConfig) => ReadinessRedisClient;

const defaultRedisClientFactory: RedisClientFactory = (config) => new RedisLiveClient(config);

export interface ConnectAndRunReadinessOptions {
  /** Derived target for the optional Redis ceiling probe; absent ⇒ ceiling omitted. */
  redisTarget?: TargetConfig | undefined;
  /** Injectable Redis client factory; defaults to the real RedisLiveClient. */
  createRedisClient?: RedisClientFactory | undefined;
  /** Declared egress link speed (crisismode.yaml `network.egressMbps`), loaded by the caller. */
  egressMbps?: number | null | undefined;
}

/**
 * Builds the pg connection config for `pgTarget` — mirrors
 * pgReplicationRegistration.createAgent (src/agent/pg-replication/registration.ts):
 * resolve the TargetConfig's CredentialRef the same way AgentRegistry does via
 * resolveTargets/resolveTarget, then build the same PgConnectionConfig shape with
 * the same 'crisismode' defaults — then connects, runs the applicable rules, and
 * scores the result.
 *
 * The client is closed on every exit path (successful run, probe failure, or a
 * rule throwing) via the single outer try/finally below. `createClient` defaults
 * to the real PgLiveClient factory; tests override it to inject a fake whose
 * `close` is a spy, to assert the pool is released even when the connectivity
 * probe fails.
 */
export async function connectAndRunReadiness(
  pgTarget: TargetConfig,
  ctx: ReadinessContext,
  createClient: PgClientFactory = defaultClientFactory,
  options: ConnectAndRunReadinessOptions = {},
): Promise<ReadinessReport> {
  const primary = pgTarget.primary;
  if (!primary) {
    return buildReport([cantAssess('no PostgreSQL target found (set DATABASE_URL or configure crisismode.yaml)')]);
  }

  const credentials = resolveCredentials(pgTarget.credentials);
  const primaryConfig: PgConnectionConfig = {
    host: primary.host,
    port: primary.port,
    user: credentials.username || 'crisismode',
    password: credentials.password || 'crisismode',
    database: primary.database || 'crisismode',
  };
  const firstReplica = pgTarget.replicas?.[0];
  const replicaConfig: PgConnectionConfig | undefined = firstReplica
    ? {
        host: firstReplica.host,
        port: firstReplica.port,
        user: credentials.username || 'crisismode',
        password: credentials.password || 'crisismode',
        database: firstReplica.database || primaryConfig.database,
      }
    : undefined;

  let client: ReadinessPgClient | undefined;
  let redisClient: ReadinessRedisClient | undefined;
  try {
    const activeClient = createClient(primaryConfig, replicaConfig);
    client = activeClient;

    try {
      // PgLiveClient's constructor only builds pg.Pool objects (no network I/O yet),
      // so the first real connectivity signal is a query. Use a cheap one to surface
      // a connection failure now rather than mid-rule.
      await activeClient.queryConnectionCount();
    } catch (err) {
      return buildReport([cantAssess(err instanceof Error ? err.message : String(err))]);
    }

    const redisTarget = options.redisTarget;
    if (redisTarget?.primary) {
      try {
        const redisCredentials = resolveCredentials(redisTarget.credentials);
        const redisConfig: RedisConnectionConfig = {
          host: redisTarget.primary.host,
          port: redisTarget.primary.port,
          password: redisCredentials.password,
          connectTimeoutMs: 2000,
        };
        redisClient = (options.createRedisClient ?? defaultRedisClientFactory)(redisConfig);
      } catch {
        // A throwing credential ref or client factory must not fail the whole
        // report — proceed with no Redis client; the ceiling is simply omitted,
        // same as a query-time failure.
        redisClient = undefined;
      }
    }
    const activeRedisClient = redisClient;

    const sources: ReadinessSources = {
      connectionUsage: () => activeClient.queryConnectionUsage(),
      tableStats: () => activeClient.queryTableStats(),
      statementStats: () => activeClient.queryStatementStats(),
      statementAggregate: () => activeClient.queryStatementAggregate(),
      fdLimit: async () => queryFdLimit(),
      declaredEgressMbps: async () => options.egressMbps ?? null,
      // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
      // method member — omit the key entirely when there's no Redis target.
      ...(activeRedisClient
        ? {
            redisLimits: async () => {
              try {
                return await activeRedisClient.queryServerLimits();
              } catch {
                // A Redis probe failure omits the ceiling — it must never fail the report.
                return null;
              }
            },
          }
        : {}),
    };
    const findings = await runRules(allRules, sources, ctx);

    try {
      const { ceilings, omitted } = await computeCeilings(sources, ctx);
      const weakLink = rankWeakLink({ ceilings, omitted });
      return { ...buildReport(findings), ceilings, ceilingsOmitted: omitted, weakLink };
    } catch {
      // Ceilings/weak-link are report CONTEXT, not the report itself — a bug
      // computing them must never discard findings already gathered above.
      return { ...buildReport(findings) };
    }
  } finally {
    // Each close is guarded independently: a rejected close must neither
    // skip the other client's cleanup nor replace the returned report
    // (a throw inside finally overrides the return value).
    try {
      await client?.close();
    } catch {
      // cleanup failure must not override the report
    }
    try {
      await redisClient?.close();
    } catch {
      // cleanup failure must not override the report
    }
  }
}

/**
 * Soft open-file descriptor limit for this machine (declared, not measured).
 * `process.report` is Node-internal and its shape is not exhaustively typed;
 * any surprise (missing report, non-numeric/'unlimited' soft limit) must
 * fall back to null rather than throw or fabricate a number.
 */
function queryFdLimit(): number | null {
  try {
    const soft = (
      process.report?.getReport() as { userLimits?: { open_files?: { soft?: number | string } } }
    )?.userLimits?.open_files?.soft;
    return typeof soft === 'number' ? soft : null;
  } catch {
    return null;
  }
}

export async function runReadiness(): Promise<ReadinessReport> {
  const stack = await discoverStack();
  const serverless =
    stack.platform.platform === 'vercel' || stack.vercelProject !== undefined;

  const pgTarget = stack.derivedTargets.find((t) => t.kind === 'postgresql');
  const redisTarget = stack.derivedTargets.find((t) => t.kind === 'redis');
  const ctx: ReadinessContext = {
    stack,
    serverless,
    target: pgTarget?.primary
      ? { host: pgTarget.primary.host, port: pgTarget.primary.port }
      : undefined,
  };

  if (!ctx.target || !pgTarget) {
    return buildReport([cantAssess('no PostgreSQL target found (set DATABASE_URL or configure crisismode.yaml)')]);
  }

  const { config } = loadConfigWithDetection();
  const egressMbps = config?.network?.egressMbps ?? null;

  return connectAndRunReadiness(pgTarget, ctx, undefined, { redisTarget, egressMbps });
}
