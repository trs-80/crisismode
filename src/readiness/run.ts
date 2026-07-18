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
import { PgLiveClient, type PgConnectionConfig } from '../agent/pg-replication/live-client.js';
import { buildReport } from './report.js';
import { allRules } from './rules/index.js';
import type {
  ReadinessContext, ReadinessFinding, ReadinessReport, ReadinessRule, ReadinessSources,
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

export async function runReadiness(): Promise<ReadinessReport> {
  const stack = await discoverStack();
  const serverless =
    stack.platform.platform === 'vercel' || stack.vercelProject !== undefined;

  const pgTarget = stack.derivedTargets.find((t) => t.kind === 'postgresql');
  const ctx: ReadinessContext = {
    stack,
    serverless,
    target: pgTarget?.primary
      ? { host: pgTarget.primary.host, port: pgTarget.primary.port }
      : undefined,
  };

  if (!ctx.target || !pgTarget?.primary) {
    return buildReport([cantAssess('no PostgreSQL target found (set DATABASE_URL or configure crisismode.yaml)')]);
  }
  const primary = pgTarget.primary;

  let client: PgLiveClient;
  try {
    // Mirrors pgReplicationRegistration.createAgent (src/agent/pg-replication/registration.ts):
    // resolve the TargetConfig's CredentialRef the same way AgentRegistry does via
    // resolveTargets/resolveTarget (src/config/resolve.ts), then build the same
    // PgConnectionConfig shape with the same 'crisismode' defaults.
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

    client = new PgLiveClient(primaryConfig, replicaConfig);
    // PgLiveClient's constructor only builds pg.Pool objects (no network I/O yet),
    // so the first real connectivity signal is a query. Use a cheap one to surface
    // a connection failure now rather than mid-rule.
    await client.queryConnectionCount();
  } catch (err) {
    return buildReport([cantAssess(err instanceof Error ? err.message : String(err))]);
  }

  try {
    const sources: ReadinessSources = {
      connectionUsage: () => client.queryConnectionUsage(),
      tableStats: () => client.queryTableStats(),
      statementStats: () => client.queryStatementStats(),
    };
    const findings = await runRules(allRules, sources, ctx);
    return buildReport(findings);
  } finally {
    await client.close();
  }
}
