// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Deterministic, offline knowledge map: signal source -> plain-English
 * explanation + a learn-more link. This is the operator-education layer
 * that works with no API key and no internet — unlike the AI summary.
 *
 * Matching is by source prefix/keyword, ordered most-specific first.
 */

import type { DiagnosisResult, HealthAssessment } from '../types/index.js';

export interface SignalExplanation {
  explanation: string;
  learnMoreUrl: string;
}

const EXPLANATIONS: Array<{ match: RegExp } & SignalExplanation> = [
  {
    match: /^environment_check/,
    explanation: 'CrisisMode checked whether THIS machine (not the service) has working DNS and internet — a broken local environment can make healthy services look down.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/network-layer/what-is-the-network-layer/',
  },
  {
    match: /^pg_replication|^pg_stat/,
    explanation: 'PostgreSQL replication keeps a standby copy of the database in sync with the primary. Lag means the standby is falling behind — failover during lag loses recent writes.',
    learnMoreUrl: 'https://www.postgresql.org/docs/current/warm-standby.html',
  },
  {
    match: /^pg_connection|^pg_/,
    explanation: 'A direct connection test to PostgreSQL. Failure means the database did not accept a connection from this machine — the cause can be the database, the network path, or DNS.',
    learnMoreUrl: 'https://www.postgresql.org/docs/current/monitoring.html',
  },
  {
    match: /^dns/,
    explanation: 'DNS translates names like db.example.com into IP addresses. If DNS is broken, everything that uses names appears down even when services are healthy.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/dns/what-is-dns/',
  },
  {
    match: /^tls|certificate/,
    explanation: 'TLS certificates prove a server\'s identity and encrypt traffic. An expired or mismatched certificate makes clients refuse to connect even though the service is running.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/ssl/what-is-ssl/',
  },
  {
    match: /^disk|inode/,
    explanation: 'Disk or inode exhaustion: when a volume fills up, services cannot write logs, data, or temp files and typically crash or hang.',
    learnMoreUrl: 'https://www.redhat.com/sysadmin/du-df-commands',
  },
  {
    match: /^redis|eviction|^memory/,
    explanation: 'Redis keeps data in RAM. Near its memory limit it either evicts keys or (with noeviction) rejects writes — both degrade the applications that depend on it.',
    learnMoreUrl: 'https://redis.io/docs/latest/develop/reference/eviction/',
  },
  {
    match: /^kafka|broker|^partition|isr/,
    explanation: 'Kafka spreads message partitions across brokers with replicas. Under-replicated partitions mean a broker is down or behind — another failure could lose messages.',
    learnMoreUrl: 'https://kafka.apache.org/documentation/#replication',
  },
  {
    match: /^etcd|consensus|raft|leader/,
    explanation: 'etcd is a consensus store: a cluster elects a leader to accept writes. Without a stable leader (quorum), dependent systems like Kubernetes cannot save changes.',
    learnMoreUrl: 'https://etcd.io/docs/v3.5/faq/',
  },
  {
    match: /^k8s|kubernetes|pod|node/,
    explanation: 'Kubernetes schedules application pods onto nodes. NotReady nodes or crash-looping pods mean the platform cannot keep the application running as declared.',
    learnMoreUrl: 'https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/',
  },
  {
    match: /backup|snapshot|pitr|restore/,
    explanation: 'Backups and point-in-time recovery are the last line of defense against data loss. A misconfigured or stale backup means recovery may be impossible when needed.',
    learnMoreUrl: 'https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html',
  },
  {
    match: /queue|consumer|lag_/,
    explanation: 'Queue backlog: messages are arriving faster than consumers process them. Growing backlog delays downstream work and can exhaust storage.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/serverless/glossary/message-queue/',
  },
];

export function explainSource(source: string): SignalExplanation | undefined {
  const hit = EXPLANATIONS.find((e) => e.match.test(source));
  return hit ? { explanation: hit.explanation, learnMoreUrl: hit.learnMoreUrl } : undefined;
}

export interface ExplanationContext {
  /** True when the app deploys to a serverless platform (Vercel detected). */
  serverless: boolean;
}

const DEFAULT_EXPLANATION_CONTEXT: ExplanationContext = { serverless: false };

const SERVERLESS_POOLING_APPEND =
  ' In a serverless deploy, each function invocation opens its own database connection — traffic spikes become connection spikes. Use a pooled connection string (or pgbouncer) for serverless functions.';

/** Scaling attributions layered onto base explanations when context matches. */
const ATTRIBUTIONS: Array<{ match: RegExp; when: (ctx: ExplanationContext) => boolean; append: string }> = [
  {
    match: /^pg_connection/,
    when: (ctx) => ctx.serverless,
    append: SERVERLESS_POOLING_APPEND,
  },
  {
    match: /queue|consumer|lag_/,
    when: (ctx) => ctx.serverless,
    append:
      ' On serverless platforms, background work competes with request traffic for the same concurrency limits — a burst of requests can starve your workers and grow the backlog.',
  },
];

/**
 * Attributions keyed by finding kind (scenario) + environment context, not
 * source string — needed when the diagnosing scenario disambiguates a source
 * that multiple unrelated diagnoses share (e.g. `pg_stat_activity` is emitted
 * by connection-pool-exhaustion, replay-paused, and db-migration diagnoses
 * alike; only the first should carry pooling advice).
 */
const SCENARIO_ATTRIBUTIONS: Array<{
  scenario: string;
  match: RegExp;
  when: (ctx: ExplanationContext) => boolean;
  append: string;
}> = [
  {
    scenario: 'connection_pool_exhaustion',
    match: /^pg_stat_activity/,
    when: (ctx) => ctx.serverless,
    append: SERVERLESS_POOLING_APPEND,
  },
];

export function explainSourceInContext(
  source: string,
  ctx: ExplanationContext,
): SignalExplanation | undefined {
  const base = explainSource(source);
  if (!base) return undefined;
  const extra = ATTRIBUTIONS.filter((a) => a.match.test(source) && a.when(ctx))
    .map((a) => a.append)
    .join('');
  return extra ? { ...base, explanation: base.explanation + extra } : base;
}

export function enrichHealth(assessment: HealthAssessment, ctx: ExplanationContext = DEFAULT_EXPLANATION_CONTEXT): HealthAssessment {
  return {
    ...assessment,
    signals: assessment.signals.map((s) => {
      if (s.explanation || s.learnMoreUrl) return s;
      const e = explainSourceInContext(s.source, ctx);
      return e ? { ...s, ...e } : s;
    }),
  };
}

export function enrichDiagnosis(diagnosis: DiagnosisResult, ctx: ExplanationContext = DEFAULT_EXPLANATION_CONTEXT): DiagnosisResult {
  return {
    ...diagnosis,
    findings: diagnosis.findings.map((f) => {
      if (f.explanation || f.learnMoreUrl) return f;
      const e = explainSourceInContext(f.source, ctx);
      if (!e) return f;
      const scenarioExtra = SCENARIO_ATTRIBUTIONS.filter(
        (a) => a.scenario === diagnosis.scenario && a.match.test(f.source) && a.when(ctx),
      )
        .map((a) => a.append)
        .join('');
      return scenarioExtra ? { ...f, ...e, explanation: e.explanation + scenarioExtra } : { ...f, ...e };
    }),
  };
}
