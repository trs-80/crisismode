// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Unit tests targeting the evaluateCheck() dispatch branches of the agent
 * live clients. A refactor moved the per-branch value comparison into the
 * shared compareCheckValue helper (src/framework/check-helpers.ts), leaving
 * the branch bodies that feed it uncovered.
 *
 * Following the pattern in live-clients.test.ts and redis-live-client.test.ts,
 * each client is instantiated without touching real infrastructure — either
 * via `Object.create(Client.prototype)` or the config-only constructor — and
 * the internal data-gathering methods / underlying client fields are replaced
 * with stubs. Assertions are on the observable boolean result so the
 * dispatch + compareCheckValue lines are exercised for both a passing and a
 * failing expectation where practical.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CheckExpression } from '../types/common.js';

/** Overwrites internal fields or methods on an instance created via Object.create. */
function inject(target: object, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(target, key, { value, writable: true, configurable: true });
  }
}

function check(
  statement: string,
  operator: CheckExpression['expect']['operator'],
  value: unknown,
  type = 'sql',
): CheckExpression {
  return { type, statement, expect: { operator, value } };
}

// ── Redis Live Client ──

describe('RedisLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { RedisLiveClient } = await import('../agent/redis/live-client.js');
    const client = Object.create(RedisLiveClient.prototype) as InstanceType<typeof RedisLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('PING compares the raw client reply', async () => {
    const client = await makeClient({ client: { ping: vi.fn().mockResolvedValue('PONG') } });
    expect(await client.evaluateCheck(check('PING', 'eq', 'PONG'))).toBe(true);
    expect(await client.evaluateCheck(check('PING', 'eq', 'DOWN'))).toBe(false);
  });

  it('used_memory_percent compares the parsed INFO memory usage', async () => {
    const client = await makeClient({ getInfo: vi.fn().mockResolvedValue({ memoryUsagePercent: 92 }) });
    expect(await client.evaluateCheck(check('used_memory_percent', 'gte', 90))).toBe(true);
    expect(await client.evaluateCheck(check('used_memory_percent', 'lt', 90))).toBe(false);
  });

  it('connected_clients compares the parsed client count', async () => {
    const client = await makeClient({ getInfo: vi.fn().mockResolvedValue({ connectedClients: 42 }) });
    expect(await client.evaluateCheck(check('connected_clients', 'eq', 42))).toBe(true);
    expect(await client.evaluateCheck(check('connected_clients', 'gt', 100))).toBe(false);
  });

  it('blocked_clients compares the parsed blocked count', async () => {
    const client = await makeClient({ getInfo: vi.fn().mockResolvedValue({ blockedClients: 3 }) });
    expect(await client.evaluateCheck(check('blocked_clients', 'gt', 0))).toBe(true);
    expect(await client.evaluateCheck(check('blocked_clients', 'eq', 0))).toBe(false);
  });

  it('evicted_keys compares the parsed eviction count', async () => {
    const client = await makeClient({ getInfo: vi.fn().mockResolvedValue({ evictedKeys: 0 }) });
    expect(await client.evaluateCheck(check('evicted_keys', 'eq', 0))).toBe(true);
    expect(await client.evaluateCheck(check('evicted_keys', 'gt', 0))).toBe(false);
  });

  it('CONFIG GET maxmemory-policy unwraps the [name, value] reply', async () => {
    const client = await makeClient({
      client: { config: vi.fn().mockResolvedValue(['maxmemory-policy', 'allkeys-lru']) },
    });
    expect(await client.evaluateCheck(check('CONFIG GET maxmemory-policy', 'eq', 'allkeys-lru'))).toBe(true);
    expect(await client.evaluateCheck(check('CONFIG GET maxmemory-policy', 'eq', 'noeviction'))).toBe(false);
  });

  it('INFO <section> reports truthiness of a non-empty reply', async () => {
    const client = await makeClient({ client: { info: vi.fn().mockResolvedValue('# Memory\r\nused_memory:1') } });
    expect(await client.evaluateCheck(check('INFO memory', 'eq', 'ignored'))).toBe(true);
  });
});

// ── DB Migration Live Client ──

describe('DbMigrationLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { DbMigrationLiveClient } = await import('../agent/db-migration/live-client.js');
    const client = Object.create(DbMigrationLiveClient.prototype) as InstanceType<typeof DbMigrationLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('pg_isready returns the failure value when the probe query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const client = await makeClient({ pool });
    // actual is 0 on failure — expecting 1 should not match
    expect(await client.evaluateCheck(check('pg_isready', 'eq', 1))).toBe(false);
    expect(await client.evaluateCheck(check('pg_isready', 'eq', 0))).toBe(true);
  });

  it('connection_pool_utilization compares the pool utilization percent', async () => {
    const client = await makeClient({ getConnectionPoolStats: vi.fn().mockResolvedValue({ utilizationPct: 85, waiting: 0 }) });
    expect(await client.evaluateCheck(check('connection_pool_utilization', 'gte', 80))).toBe(true);
    expect(await client.evaluateCheck(check('connection_pool_utilization', 'lt', 80))).toBe(false);
  });

  it('active_locks counts ungranted (blocked) locks', async () => {
    const client = await makeClient({
      getTableLockInfo: vi.fn().mockResolvedValue([
        { granted: true }, { granted: false }, { granted: false },
      ]),
    });
    expect(await client.evaluateCheck(check('active_locks', 'eq', 2))).toBe(true);
    expect(await client.evaluateCheck(check('active_locks', 'eq', 0))).toBe(false);
  });

  it('migration_status compares the current migration status string', async () => {
    const client = await makeClient({ getMigrationStatus: vi.fn().mockResolvedValue({ status: 'completed' }) });
    expect(await client.evaluateCheck(check('migration_status', 'eq', 'completed'))).toBe(true);
    expect(await client.evaluateCheck(check('migration_status', 'eq', 'failed'))).toBe(false);
  });

  it('waiting_connections compares the pool waiting count', async () => {
    const client = await makeClient({ getConnectionPoolStats: vi.fn().mockResolvedValue({ utilizationPct: 10, waiting: 5 }) });
    expect(await client.evaluateCheck(check('waiting_connections', 'gt', 0))).toBe(true);
    expect(await client.evaluateCheck(check('waiting_connections', 'eq', 0))).toBe(false);
  });

  it('raw SQL fallback compares the first column of the first row', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ count: 7 }] }) };
    const client = await makeClient({ pool });
    expect(await client.evaluateCheck(check('SELECT count(*) FROM jobs', 'eq', 7))).toBe(true);
    expect(await client.evaluateCheck(check('SELECT count(*) FROM jobs', 'gt', 10))).toBe(false);
  });

  it('raw SQL fallback treats an empty result set as zero', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const client = await makeClient({ pool });
    expect(await client.evaluateCheck(check('SELECT 1 WHERE false', 'eq', 0))).toBe(true);
    expect(await client.evaluateCheck(check('SELECT 1 WHERE false', 'gt', 0))).toBe(false);
  });

  it('raw SQL fallback returns false when the query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('syntax error')) };
    const client = await makeClient({ pool });
    expect(await client.evaluateCheck(check('NOT VALID SQL', 'eq', 1))).toBe(false);
  });
});

// ── AI Provider Live Client ──

describe('AiProviderLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { AiProviderLiveClient } = await import('../agent/ai-provider/live-client.js');
    const client = Object.create(AiProviderLiveClient.prototype) as InstanceType<typeof AiProviderLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('p95_latency compares the request metrics p95 latency', async () => {
    const client = await makeClient({ getRequestMetrics: vi.fn().mockResolvedValue({ p95LatencyMs: 1200, successRate: 1, timeoutRate: 0 }) });
    expect(await client.evaluateCheck(check('p95_latency', 'lte', 1500))).toBe(true);
    expect(await client.evaluateCheck(check('p95_latency', 'lt', 1000))).toBe(false);
  });

  it('error_rate compares the request metrics success rate', async () => {
    const client = await makeClient({ getRequestMetrics: vi.fn().mockResolvedValue({ p95LatencyMs: 0, successRate: 0.99, timeoutRate: 0 }) });
    expect(await client.evaluateCheck(check('error_rate', 'gte', 0.95))).toBe(true);
    expect(await client.evaluateCheck(check('error_rate', 'lt', 0.5))).toBe(false);
  });

  it('timeout_rate compares the request metrics timeout rate', async () => {
    const client = await makeClient({ getRequestMetrics: vi.fn().mockResolvedValue({ p95LatencyMs: 0, successRate: 1, timeoutRate: 0.02 }) });
    expect(await client.evaluateCheck(check('timeout_rate', 'lte', 0.05))).toBe(true);
    expect(await client.evaluateCheck(check('timeout_rate', 'eq', 0))).toBe(false);
  });

  it('circuit_breaker_open counts breakers in the open state', async () => {
    const client = await makeClient({
      getCircuitBreakerState: vi.fn().mockResolvedValue([
        { state: 'open' }, { state: 'closed' },
      ]),
    });
    expect(await client.evaluateCheck(check('circuit_breaker_open', 'eq', 1))).toBe(true);
    expect(await client.evaluateCheck(check('circuit_breaker_open', 'eq', 0))).toBe(false);
  });

  it('fallback_active is true when the priority-1 provider is disabled', async () => {
    const client = await makeClient({
      getFallbackConfig: vi.fn().mockResolvedValue({ chain: [{ priority: 1, enabled: false }, { priority: 2, enabled: true }] }),
    });
    // primary disabled → fallback active (true)
    expect(await client.evaluateCheck(check('fallback_active', 'eq', 'true'))).toBe(true);
    expect(await client.evaluateCheck(check('fallback_active', 'eq', 'false'))).toBe(false);
  });

  it('fallback_active is false when the priority-1 provider is enabled', async () => {
    const client = await makeClient({
      getFallbackConfig: vi.fn().mockResolvedValue({ chain: [{ priority: 1, enabled: true }] }),
    });
    expect(await client.evaluateCheck(check('fallback_active', 'eq', 'false'))).toBe(true);
  });
});

// ── Queue Backlog Live Client ──

describe('QueueLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { QueueLiveClient } = await import('../agent/queue-backlog/live-client.js');
    const client = Object.create(QueueLiveClient.prototype) as InstanceType<typeof QueueLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('queue_service_health maps a PONG reply to ok', async () => {
    const client = await makeClient({ getRedis: vi.fn().mockResolvedValue({ ping: vi.fn().mockResolvedValue('PONG') }) });
    expect(await client.evaluateCheck(check('queue_service_health', 'eq', 'ok'))).toBe(true);
    expect(await client.evaluateCheck(check('queue_service_health', 'eq', 'fail'))).toBe(false);
  });

  it('queue_service_health maps a connection failure to fail', async () => {
    const client = await makeClient({ getRedis: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    expect(await client.evaluateCheck(check('queue_service_health', 'eq', 'fail'))).toBe(true);
    expect(await client.evaluateCheck(check('queue_service_health', 'eq', 'ok'))).toBe(false);
  });

  it('total_queue_depth sums depth across all queues', async () => {
    const client = await makeClient({ getQueueStats: vi.fn().mockResolvedValue([{ depth: 100 }, { depth: 250 }]) });
    expect(await client.evaluateCheck(check('total_queue_depth', 'eq', 350))).toBe(true);
    expect(await client.evaluateCheck(check('total_queue_depth', 'lt', 300))).toBe(false);
  });

  it('stuck_worker_count counts stuck and dead workers', async () => {
    const client = await makeClient({
      getWorkerStatus: vi.fn().mockResolvedValue([
        { status: 'active' }, { status: 'stuck' }, { status: 'dead' },
      ]),
    });
    expect(await client.evaluateCheck(check('stuck_worker_count', 'eq', 2))).toBe(true);
    expect(await client.evaluateCheck(check('stuck_worker_count', 'eq', 0))).toBe(false);
  });

  it('backlog_growth_rate compares the processing rate growth', async () => {
    const client = await makeClient({ getProcessingRate: vi.fn().mockResolvedValue({ backlogGrowthRate: 12 }) });
    expect(await client.evaluateCheck(check('backlog_growth_rate', 'gt', 0))).toBe(true);
    expect(await client.evaluateCheck(check('backlog_growth_rate', 'lt', 0))).toBe(false);
  });

  it('dlq_depth compares the dead-letter queue depth', async () => {
    const client = await makeClient({ getDeadLetterStats: vi.fn().mockResolvedValue({ depth: 5 }) });
    expect(await client.evaluateCheck(check('dlq_depth', 'gt', 0))).toBe(true);
    expect(await client.evaluateCheck(check('dlq_depth', 'eq', 0))).toBe(false);
  });
});

// ── AWS RDS Live Client ──

describe('RdsRecoveryLiveClient evaluateCheck', () => {
  async function makeClient(config: Record<string, unknown>) {
    const { RdsRecoveryLiveClient } = await import('../agent/aws-rds/live-client.js');
    const client = Object.create(RdsRecoveryLiveClient.prototype) as InstanceType<typeof RdsRecoveryLiveClient>;
    inject(client, { getInstanceBackupConfig: vi.fn().mockResolvedValue(config) });
    return client;
  }

  it('backup_retention_period compares the retention window in days', async () => {
    const client = await makeClient({ backupRetentionPeriod: 7 });
    expect(await client.evaluateCheck(check('backup_retention_period', 'gte', 7))).toBe(true);
    expect(await client.evaluateCheck(check('backup_retention_period', 'gt', 7))).toBe(false);
  });

  it('snapshot_count compares the available snapshot count', async () => {
    const client = await makeClient({ snapshotCount: 3 });
    expect(await client.evaluateCheck(check('snapshot_count', 'eq', 3))).toBe(true);
    expect(await client.evaluateCheck(check('snapshot_count', 'eq', 0))).toBe(false);
  });

  it('automated_backups_enabled maps the boolean flag to 1/0', async () => {
    const enabled = await makeClient({ automatedBackupsEnabled: true });
    expect(await enabled.evaluateCheck(check('automated_backups_enabled', 'eq', 1))).toBe(true);
    const disabled = await makeClient({ automatedBackupsEnabled: false });
    expect(await disabled.evaluateCheck(check('automated_backups_enabled', 'eq', 1))).toBe(false);
    expect(await disabled.evaluateCheck(check('automated_backups_enabled', 'eq', 0))).toBe(true);
  });

  it('instance_status compares the instance status string', async () => {
    const client = await makeClient({ status: 'available' });
    expect(await client.evaluateCheck(check('instance_status', 'eq', 'available'))).toBe(true);
    expect(await client.evaluateCheck(check('instance_status', 'eq', 'rebooting'))).toBe(false);
  });
});

// ── AWS S3 Live Client ──

describe('S3RecoveryLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { S3RecoveryLiveClient } = await import('../agent/aws-s3/live-client.js');
    const client = Object.create(S3RecoveryLiveClient.prototype) as InstanceType<typeof S3RecoveryLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('versioning_status compares the bucket versioning state', async () => {
    const client = await makeClient({ getBucketConfig: vi.fn().mockResolvedValue({ versioningStatus: 'Enabled', lifecycleRules: [] }) });
    expect(await client.evaluateCheck(check('versioning_status', 'eq', 'Enabled'))).toBe(true);
    expect(await client.evaluateCheck(check('versioning_status', 'eq', 'Suspended'))).toBe(false);
  });

  it('lifecycle_rule_count compares the number of lifecycle rules', async () => {
    const client = await makeClient({ getBucketConfig: vi.fn().mockResolvedValue({ versioningStatus: 'Enabled', lifecycleRules: [{}, {}] }) });
    expect(await client.evaluateCheck(check('lifecycle_rule_count', 'eq', 2))).toBe(true);
    expect(await client.evaluateCheck(check('lifecycle_rule_count', 'eq', 0))).toBe(false);
  });

  it('bucket_exists reports true when HeadBucket succeeds', async () => {
    class HeadBucketCommand {
      constructor(public input: unknown) {}
    }
    const client = await makeClient({
      config: { bucket: 'my-bucket' },
      getS3Module: vi.fn().mockResolvedValue({ HeadBucketCommand }),
      getClient: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue({}) }),
    });
    expect(await client.evaluateCheck(check('bucket_exists', 'eq', 'true'))).toBe(true);
    expect(await client.evaluateCheck(check('bucket_exists', 'eq', 'false'))).toBe(false);
  });

  it('bucket_exists reports false when HeadBucket throws', async () => {
    class HeadBucketCommand {
      constructor(public input: unknown) {}
    }
    const client = await makeClient({
      config: { bucket: 'missing-bucket' },
      getS3Module: vi.fn().mockResolvedValue({ HeadBucketCommand }),
      getClient: vi.fn().mockResolvedValue({ send: vi.fn().mockRejectedValue(new Error('NotFound')) }),
    });
    expect(await client.evaluateCheck(check('bucket_exists', 'eq', 'false'))).toBe(true);
    expect(await client.evaluateCheck(check('bucket_exists', 'eq', 'true'))).toBe(false);
  });
});

// ── AWS DynamoDB Live Client ──

describe('DynamoDbRecoveryLiveClient evaluateCheck', () => {
  async function makeClient(config: Record<string, unknown>) {
    const { DynamoDbRecoveryLiveClient } = await import('../agent/aws-dynamodb/live-client.js');
    const client = Object.create(DynamoDbRecoveryLiveClient.prototype) as InstanceType<typeof DynamoDbRecoveryLiveClient>;
    inject(client, { getTableBackupConfig: vi.fn().mockResolvedValue(config) });
    return client;
  }

  it('pitr_status maps PITR-enabled tables to ENABLED', async () => {
    const client = await makeClient({ pitrEnabled: true });
    expect(await client.evaluateCheck(check('pitr_status', 'eq', 'ENABLED'))).toBe(true);
    expect(await client.evaluateCheck(check('pitr_status', 'eq', 'DISABLED'))).toBe(false);
  });

  it('continuous_backups_status maps PITR-disabled tables to DISABLED', async () => {
    const client = await makeClient({ pitrEnabled: false });
    expect(await client.evaluateCheck(check('continuous_backups_status', 'eq', 'DISABLED'))).toBe(true);
    expect(await client.evaluateCheck(check('continuous_backups_status', 'eq', 'ENABLED'))).toBe(false);
  });
});

// ── Config Drift Live Client ──

describe('ConfigDriftLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { ConfigDriftLiveClient } = await import('../agent/config-drift/live-client.js');
    const client = Object.create(ConfigDriftLiveClient.prototype) as InstanceType<typeof ConfigDriftLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('expired_secrets_count counts secrets flagged as expired', async () => {
    const client = await makeClient({
      getSecretStatus: vi.fn().mockResolvedValue([{ expired: true }, { expired: false }, { expired: true }]),
    });
    expect(await client.evaluateCheck(check('expired_secrets_count', 'eq', 2))).toBe(true);
    expect(await client.evaluateCheck(check('expired_secrets_count', 'eq', 0))).toBe(false);
  });

  it('env_var_mismatches counts diffs sourced from env', async () => {
    const client = await makeClient({
      getConfigDiff: vi.fn().mockResolvedValue([{ source: 'env' }, { source: 'file' }, { source: 'env' }]),
    });
    expect(await client.evaluateCheck(check('env_var_mismatches', 'eq', 2))).toBe(true);
    expect(await client.evaluateCheck(check('env_var_mismatches', 'eq', 0))).toBe(false);
  });
});

// ── Deploy Rollback Live Client ──

describe('DeployLiveClient evaluateCheck', () => {
  async function makeClient(overrides: Record<string, unknown>) {
    const { DeployLiveClient } = await import('../agent/deploy-rollback/live-client.js');
    const client = Object.create(DeployLiveClient.prototype) as InstanceType<typeof DeployLiveClient>;
    inject(client, overrides);
    return client;
  }

  it('error_rate compares the average error rate across endpoints', async () => {
    const client = await makeClient({
      getHealthEndpoints: vi.fn().mockResolvedValue([{ errorRate: 10 }, { errorRate: 30 }]),
    });
    // average is 20
    expect(await client.evaluateCheck(check('error_rate', 'lte', 20))).toBe(true);
    expect(await client.evaluateCheck(check('error_rate', 'lt', 20))).toBe(false);
  });

  it('error_rate returns true (healthy) when there are no endpoints to probe', async () => {
    const client = await makeClient({ getHealthEndpoints: vi.fn().mockResolvedValue([]) });
    expect(await client.evaluateCheck(check('error_rate', 'lte', 0))).toBe(true);
  });

  it('deploy_health returns true (healthy) when there are no endpoints to probe', async () => {
    const client = await makeClient({ getHealthEndpoints: vi.fn().mockResolvedValue([]) });
    expect(await client.evaluateCheck(check('deploy_health', 'lte', 0))).toBe(true);
  });
});

// ── PG Replication Live Client ──

describe('PgLiveClient evaluateCheck', () => {
  async function makeClient(query: ReturnType<typeof vi.fn>) {
    const { PgLiveClient } = await import('../agent/pg-replication/live-client.js');
    const client = Object.create(PgLiveClient.prototype) as InstanceType<typeof PgLiveClient>;
    inject(client, { primaryPool: { query }, replicaPool: null });
    return client;
  }

  it('rejects structured_command checks (SQL-only backend)', async () => {
    const client = await makeClient(vi.fn());
    expect(await client.evaluateCheck(check('anything', 'eq', 1, 'structured_command'))).toBe(false);
  });

  it('returns false when no statement is provided', async () => {
    const client = await makeClient(vi.fn());
    expect(await client.evaluateCheck({ type: 'sql', expect: { operator: 'eq', value: 1 } })).toBe(false);
  });

  it('compares the first column of the first row for a value query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lag_bytes: 0 }] });
    const client = await makeClient(query);
    expect(await client.evaluateCheck(check('SELECT lag_bytes FROM repl', 'eq', 0))).toBe(true);
    expect(await client.evaluateCheck(check('SELECT lag_bytes FROM repl', 'gt', 0))).toBe(false);
  });

  it('treats an empty result set as zero', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = await makeClient(query);
    expect(await client.evaluateCheck(check('SELECT 1 WHERE false', 'eq', 0))).toBe(true);
    expect(await client.evaluateCheck(check('SELECT 1 WHERE false', 'gt', 0))).toBe(false);
  });

  it('returns false and logs when the query throws', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection lost'));
    const client = await makeClient(query);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await client.evaluateCheck(check('SELECT bad', 'eq', 1))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
