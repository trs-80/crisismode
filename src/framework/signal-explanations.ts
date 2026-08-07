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
    match: /^s3_|^bucket_/,
    explanation: 'S3 bucket protection settings (versioning, lifecycle, public access). Wrong settings quietly remove your safety net — deleted or overwritten objects may be unrecoverable.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html',
  },
  {
    match: /^rds_instance_status|^rds_events/,
    explanation: 'The AWS-managed status of your database instance. When AWS reports a non-available state (storage-full, rebooting, maintenance), the platform itself — not your application — is the reason the database misbehaves.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/accessing-monitoring.html',
  },
  {
    match: /^rds_connection_saturation/,
    explanation: 'Each RDS instance size allows a limited number of simultaneous database connections. Near the limit, new connections fail even though the database is healthy — common with serverless apps that open a connection per request. Connection pooling or RDS Proxy fixes this.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html',
  },
  {
    match: /^rds_storage/,
    explanation: 'RDS instances have a fixed allocated storage size. When it fills up, the database stops accepting writes until storage is increased — a one-click change in the RDS console (Modify → Allocated storage).',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.StorageTypes.html',
  },
  {
    match: /^rds_security_group/,
    explanation: 'AWS security groups are firewalls around your database. If no rule allows your app\'s address on the database port, every connection times out even though the database is running fine — the most common cause of "my app can\'t reach RDS".',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.RDSSecurityGroups.html',
  },
  {
    match: /^rds_iam_permissions/,
    explanation: 'CrisisMode\'s AWS credentials lack permission for a read-only check. The database itself may be fine — grant the listed IAM action (the AmazonRDSReadOnlyAccess and CloudWatchReadOnlyAccess managed policies cover all checks) to see the full picture.',
    learnMoreUrl: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/security_iam_id-based-policy-examples.html',
  },
  {
    match: /^iac_state/,
    explanation: 'CrisisMode reads Terraform state (local or S3 backend) to learn what your infrastructure is supposed to look like. If the state is unreadable or stale, drift findings are limited or unavailable — the state, not your infrastructure, is the problem.',
    learnMoreUrl: 'https://developer.hashicorp.com/terraform/language/state',
  },
  {
    match: /^iac_/,
    explanation: 'Terraform records the intended shape of your infrastructure. Drift means someone changed things outside Terraform — an approved or auto-applied terraform apply can revert those changes, which can undo an emergency fix.',
    learnMoreUrl: 'https://developer.hashicorp.com/terraform/tutorials/state/resource-drift',
  },
  {
    match: /^vector_store_/,
    explanation: 'A managed vector store (Pinecone, Upstash Vector) holds the embeddings your app searches to answer questions. If it is unreachable, the key is rejected, or the index is missing or still building, retrieval returns nothing — the app usually stays up and quietly answers without its own data.',
    learnMoreUrl: 'https://www.pinecone.io/learn/vector-database/',
  },
  {
    match: /backup|snapshot|pitr|restore/,
    explanation: 'Backups and point-in-time recovery are the last line of defense against data loss. A misconfigured or stale backup means recovery may be impossible when needed.',
    learnMoreUrl: 'https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html',
  },
  {
    match: /^resolver_|^dns_/,
    explanation: 'DNS translates names like db.example.com into IP addresses. If this machine cannot reach a DNS resolver, everything that uses names appears down even when services are healthy.',
    learnMoreUrl: 'https://www.cloudflare.com/learning/dns/what-is-dns/',
  },
  {
    match: /^flink|_checkpoint/,
    explanation: 'Flink runs continuous stream-processing jobs with periodic checkpoints. A failing job or stalled checkpoints means data is not being processed and recovery to a recent point may not be possible.',
    learnMoreUrl: 'https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpoints/',
  },
  {
    match: /^ceph|_osd|placement_group/,
    explanation: 'Ceph is distributed storage: data is spread across many disks (OSDs) with copies. Degraded health means some copies are missing — another failure could make data unavailable.',
    learnMoreUrl: 'https://docs.ceph.com/en/latest/rados/operations/monitoring/',
  },
  {
    match: /^environment_variables|^config_|drift/,
    explanation: 'Configuration drift: what is running no longer matches what was declared (env vars, config files). Drift makes incidents confusing — the system misbehaves in ways the config says it should not.',
    learnMoreUrl: 'https://www.hashicorp.com/resources/what-is-configuration-drift',
  },
  {
    match: /^schema_migrations|^migration_/,
    explanation: 'Database migrations change the schema your application expects. A half-applied or failed migration means the app and database disagree about structure — queries start failing.',
    learnMoreUrl: 'https://www.prisma.io/dataguide/types/relational/what-are-database-migrations',
  },
  {
    match: /^deploy_|^release_/,
    explanation: 'Deployment health: whether the most recent release is running correctly. If problems started right after a deploy, rolling back to the previous version is usually the fastest fix.',
    learnMoreUrl: 'https://docs.aws.amazon.com/whitepapers/latest/practicing-continuous-integration-continuous-delivery/deployment-methods.html',
  },
  {
    // Matches findings from any of the four supported providers (Anthropic,
    // OpenAI, Google, OpenRouter) — the link must not describe one vendor's
    // behavior as if it were universal.
    match: /^llm_key|^llm_quota/,
    explanation: 'Your app authenticates to its LLM provider with an API key. A missing, rotated, or unpaid key makes every AI feature fail with errors that look like application bugs — the fix is in the provider dashboard, not the code.',
    learnMoreUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication',
  },
  {
    // Same multi-provider caveat as above.
    match: /^llm_/,
    explanation: 'LLM provider health: rate-limit headroom, whether the model id your app names still exists, and whether the provider is having an incident. Any of these makes the app fail while your own infrastructure is perfectly healthy.',
    learnMoreUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429',
  },
  {
    match: /^provider_health|^ai_provider|model_availability/,
    explanation: 'AI provider health: whether the LLM API your app depends on is reachable and responding. Provider outages and rate limits look like app bugs unless checked directly.',
    learnMoreUrl: 'https://docs.claude.com/en/api/errors',
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
