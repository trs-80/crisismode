// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Integration tests for Phase 2 live clients.
 *
 * These tests validate that each live client:
 * 1. Implements the full backend interface
 * 2. Has correct capability provider descriptors
 * 3. Handles executeCommand and evaluateCheck correctly
 * 4. Cleans up resources via close()
 *
 * Tests that require real infrastructure (Vercel API, PostgreSQL, Redis)
 * use mocked network calls. Integration tests against real services
 * should be run separately via the podman test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Deploy Rollback Live Client ──

describe('DeployLiveClient', () => {
  let DeployLiveClient: typeof import('../agent/deploy-rollback/live-client.js').DeployLiveClient;

  const mockConfig = {
    token: 'test-token',
    projectId: 'prj_test123',
    teamId: 'team_test',
    healthEndpoints: ['https://app.example.com/healthz'],
    timeoutMs: 5_000,
  };

  const mockDeployment = {
    uid: 'dpl_abc123',
    name: 'my-app',
    url: 'my-app-abc123.vercel.app',
    state: 'READY',
    readyState: 'READY',
    created: Date.now() - 60_000,
    meta: {
      githubCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      githubCommitMessage: 'feat: add new feature',
      githubCommitAuthorLogin: 'developer',
    },
  };

  const mockOlderDeployment = {
    ...mockDeployment,
    uid: 'dpl_older456',
    created: Date.now() - 3_600_000,
    meta: {
      ...mockDeployment.meta,
      githubCommitSha: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
      githubCommitMessage: 'fix: previous fix',
    },
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/deploy-rollback/live-client.js');
    DeployLiveClient = mod.DeployLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements DeployBackend interface', () => {
    const client = new DeployLiveClient(mockConfig);
    expect(typeof client.getCurrentDeployment).toBe('function');
    expect(typeof client.listRecentDeploys).toBe('function');
    expect(typeof client.getTrafficDistribution).toBe('function');
    expect(typeof client.getHealthEndpoints).toBe('function');
    expect(typeof client.getRollbackTarget).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new DeployLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('deploy.status.read');
    expect(providers[0].capabilities).toContain('deploy.rollback');
  });

  it('getCurrentDeployment fetches from Vercel API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const deploy = await client.getCurrentDeployment();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(deploy.sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    expect(deploy.status).toBe('succeeded');
    expect(deploy.author).toBe('developer');
  });

  it('listRecentDeploys returns multiple deployments', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment, mockOlderDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const deploys = await client.listRecentDeploys(5);
    expect(deploys).toHaveLength(2);
    expect(deploys[0].sha).not.toBe(deploys[1].sha);
  });

  it('getHealthEndpoints probes configured URLs', async () => {
    // First call is for API, remaining for health endpoints
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('OK', { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const endpoints = await client.getHealthEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].url).toBe('https://app.example.com/healthz');
    expect(endpoints[0].status).toBe('healthy');
  });

  it('getHealthEndpoints marks failed endpoints as down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const client = new DeployLiveClient(mockConfig);
    const endpoints = await client.getHealthEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status).toBe('down');
    expect(endpoints[0].errorRate).toBe(100);
  });

  it('getRollbackTarget finds last successful deploy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment, mockOlderDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const target = await client.getRollbackTarget();
    expect(target).not.toBeNull();
    expect(target!.sha).toBe(mockOlderDeployment.meta.githubCommitSha);
  });

  it('executeCommand handles deploy_status', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const client = new DeployLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'deploy_status' }) as Record<string, unknown>;
    expect(result).toHaveProperty('current');
    expect(result).toHaveProperty('traffic');
    expect(result).toHaveProperty('endpoints');
  });

  it('rejects unsupported command types', async () => {
    const client = new DeployLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported deploy live client command type');
  });

  it('evaluateCheck handles deploy_health', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('OK', { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'deploy_health',
      expect: { operator: 'lte', value: 10 },
    });
    expect(result).toBe(true);
  });

  it('transition is a no-op', () => {
    const client = new DeployLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });

  it('close is safe to call', async () => {
    const client = new DeployLiveClient(mockConfig);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ── AI Provider Live Client ──

describe('AiProviderLiveClient', () => {
  let AiProviderLiveClient: typeof import('../agent/ai-provider/live-client.js').AiProviderLiveClient;

  const mockConfig = {
    providers: [
      {
        name: 'openai',
        endpoint: 'https://api.openai.com/v1',
        healthPath: '/models',
        apiKey: 'sk-test',
        priority: 1,
        enabled: true,
      },
      {
        name: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        healthPath: '/models',
        apiKey: 'sk-ant-test',
        authHeader: 'x-api-key',
        authPrefix: '',
        priority: 2,
        enabled: true,
      },
    ],
    timeoutMs: 5_000,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/ai-provider/live-client.js');
    AiProviderLiveClient = mod.AiProviderLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements AiProviderBackend interface', () => {
    const client = new AiProviderLiveClient(mockConfig);
    expect(typeof client.getProviderStatus).toBe('function');
    expect(typeof client.getRequestMetrics).toBe('function');
    expect(typeof client.getCircuitBreakerState).toBe('function');
    expect(typeof client.getFallbackConfig).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new AiProviderLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('provider.status.read');
    expect(providers[1].capabilities).toContain('provider.circuit_breaker.trip');
  });

  it('getProviderStatus probes each provider', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const statuses = await client.getProviderStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses[0].name).toBe('openai');
    expect(statuses[0].status).toBe('healthy');
    expect(statuses[1].name).toBe('anthropic');
  });

  it('marks down providers correctly', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const statuses = await client.getProviderStatus();
    expect(statuses[0].status).toBe('down');
    expect(statuses[1].status).toBe('healthy');
  });

  it('circuit breakers start closed', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const states = await client.getCircuitBreakerState();
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.state === 'closed')).toBe(true);
  });

  it('getFallbackConfig returns sorted chain', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const config = await client.getFallbackConfig();
    expect(config.chain).toHaveLength(2);
    expect(config.chain[0].provider).toBe('openai');
    expect(config.chain[0].priority).toBe(1);
  });

  it('getRequestMetrics returns valid defaults', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const metrics = await client.getRequestMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.successRate).toBe(1);
  });

  it('getRequestMetrics tracks probes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    await client.getProviderStatus(); // This triggers probes
    const metrics = await client.getRequestMetrics();
    expect(metrics.totalRequests).toBe(2);
  });

  it('executeCommand trip_circuit_breaker opens a breaker', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await client.executeCommand({ type: 'api_call', operation: 'trip_circuit_breaker', parameters: { provider: 'openai' } });
    const states = await client.getCircuitBreakerState();
    const openai = states.find((s) => s.provider === 'openai')!;
    expect(openai.state).toBe('open');
  });

  it('executeCommand restore_primary resets all breakers', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await client.executeCommand({ type: 'api_call', operation: 'trip_circuit_breaker', parameters: { provider: 'openai' } });
    await client.executeCommand({ type: 'api_call', operation: 'restore_primary' });
    const states = await client.getCircuitBreakerState();
    expect(states.every((s) => s.state === 'closed')).toBe(true);
  });

  it('evaluateCheck handles provider_ping', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'provider_ping',
      expect: { operator: 'eq', value: 'ok' },
    });
    expect(result).toBe(true);
  });

  it('rejects unsupported command types', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported AI provider live client command type');
  });
});

// ── DB Migration Live Client ──

describe('DbMigrationLiveClient', () => {
  // We can't easily mock `pg` with ESM, so we test the client via a
  // lightweight duck-typed approach: construct the client and use
  // Object.defineProperty to replace the private pool with a mock.

  let DbMigrationLiveClient: typeof import('../agent/db-migration/live-client.js').DbMigrationLiveClient;
  const mockQuery = vi.fn();
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  function createClient() {
    // pg.Pool constructor will try to connect on first query, not on construction.
    // We construct then swap the pool with our mock before any queries run.
    const client = Object.create(DbMigrationLiveClient.prototype) as InstanceType<typeof DbMigrationLiveClient>;
    Object.defineProperty(client, 'pool', { value: { query: mockQuery, end: mockEnd }, writable: true });
    Object.defineProperty(client, 'longQueryThresholdSec', { value: 30, writable: true });
    return client;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockQuery.mockReset();
    mockEnd.mockReset().mockResolvedValue(undefined);
    const mod = await import('../agent/db-migration/live-client.js');
    DbMigrationLiveClient = mod.DbMigrationLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements DbMigrationBackend interface', () => {
    const client = createClient();
    expect(typeof client.getMigrationStatus).toBe('function');
    expect(typeof client.getConnectionPoolStats).toBe('function');
    expect(typeof client.getActiveQueries).toBe('function');
    expect(typeof client.getTableLockInfo).toBe('function');
    expect(typeof client.getDatabaseSize).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = createClient();
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('db.query.read');
    expect(providers[1].capabilities).toContain('db.migration.rollback');
  });

  it('getMigrationStatus detects Prisma migrations', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        version: '20260315_001_add_users',
        name: '20260315_001_add_users',
        status: 'completed',
        started_at: '2026-03-15T10:00:00Z',
        error: null,
      }],
    });

    const client = createClient();
    const status = await client.getMigrationStatus();
    expect(status.version).toBe('20260315_001_add_users');
    expect(status.status).toBe('completed');
  });

  it('getMigrationStatus falls back to DDL detection', async () => {
    // Prisma fails
    mockQuery.mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));
    // Drizzle fails
    mockQuery.mockRejectedValueOnce(new Error('relation "__drizzle_migrations" does not exist'));
    // DDL detection returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const client = createClient();
    const status = await client.getMigrationStatus();
    expect(status.version).toBe('none');
    expect(status.status).toBe('completed');
  });

  it('getConnectionPoolStats queries pg_stat_activity', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ active: 15, idle: 30, waiting: 2, max_connections: 100 }],
    });

    const client = createClient();
    const stats = await client.getConnectionPoolStats();
    expect(stats.active).toBe(15);
    expect(stats.idle).toBe(30);
    expect(stats.maxConnections).toBe(100);
    expect(stats.utilizationPct).toBe(45);
  });

  it('getActiveQueries returns long-running queries', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        pid: 12001,
        query: 'CREATE INDEX CONCURRENTLY ...',
        duration_sec: 120,
        state: 'active',
        wait_event: 'Lock',
      }],
    });

    const client = createClient();
    const queries = await client.getActiveQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0].pid).toBe(12001);
    expect(queries[0].waitEvent).toBe('Lock');
  });

  it('getTableLockInfo returns blocking locks', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        relation: 'orders',
        lock_type: 'AccessExclusiveLock',
        granted: true,
        pid: 12001,
        query: 'CREATE INDEX ...',
      }],
    });

    const client = createClient();
    const locks = await client.getTableLockInfo();
    expect(locks).toHaveLength(1);
    expect(locks[0].relation).toBe('orders');
    expect(locks[0].granted).toBe(true);
  });

  it('getDatabaseSize queries pg_database_size', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_bytes: '107374182400', tablespace_free: '21474836480' }],
    });

    const client = createClient();
    const size = await client.getDatabaseSize();
    expect(size.totalBytes).toBe(107_374_182_400);
    expect(size.tablespaceFree).toBe(21_474_836_480);
  });

  it('evaluateCheck handles pg_isready', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ result: 1 }] });

    const client = createClient();
    const result = await client.evaluateCheck({
      type: 'sql',
      statement: 'SELECT 1',
      expect: { operator: 'eq', value: 1 },
    });
    expect(result).toBe(true);
  });

  it('close terminates pool', async () => {
    const client = createClient();
    await client.close();
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('discoverVersion queries SHOW server_version', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ server_version: '16.2' }] });

    const client = createClient();
    const version = await client.discoverVersion!();
    expect(version).toBe('16.2');
  });
});

// ── Queue Backlog Live Client ──

describe('QueueLiveClient', () => {
  let QueueLiveClient: typeof import('../agent/queue-backlog/live-client.js').QueueLiveClient;

  const mockConfig = {
    redisUrl: 'redis://localhost:6379',
    queueNames: ['orders', 'notifications'],
    keyPrefix: 'bull',
    timeoutMs: 5_000,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/queue-backlog/live-client.js');
    QueueLiveClient = mod.QueueLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements QueueBackend interface', () => {
    const client = new QueueLiveClient(mockConfig);
    expect(typeof client.getQueueStats).toBe('function');
    expect(typeof client.getWorkerStatus).toBe('function');
    expect(typeof client.getDeadLetterStats).toBe('function');
    expect(typeof client.getProcessingRate).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new QueueLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('queue.stats.read');
    expect(providers[1].capabilities).toContain('queue.pause');
  });

  it('rejects unsupported command types', async () => {
    const client = new QueueLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported queue live client command type');
  });

  it('transition is a no-op', () => {
    const client = new QueueLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });
});

// ── Config Drift Live Client ──

describe('ConfigDriftLiveClient', () => {
  let ConfigDriftLiveClient: typeof import('../agent/config-drift/live-client.js').ConfigDriftLiveClient;

  const mockConfig = {
    expectations: [
      { path: 'DATABASE_URL', expected: 'postgresql://localhost:5432/app', source: 'env' as const, masked: true },
      { path: 'LOG_LEVEL', expected: 'info', source: 'env' as const },
      { path: 'MISSING_VAR', expected: 'some-value', source: 'env' as const },
    ],
    secrets: [],
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/config-drift/live-client.js');
    ConfigDriftLiveClient = mod.ConfigDriftLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements ConfigDriftBackend interface', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    expect(typeof client.getEnvironmentVars).toBe('function');
    expect(typeof client.getSecretStatus).toBe('function');
    expect(typeof client.getConfigDiff).toBe('function');
    expect(typeof client.getRecentConfigChanges).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('config.env.read');
    expect(providers[1].capabilities).toContain('config.env.restore');
  });

  it('getEnvironmentVars reads from process.env', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const vars = await client.getEnvironmentVars();

    expect(vars).toHaveLength(3);
    expect(vars[0].name).toBe('DATABASE_URL');
    expect(vars[0].masked).toBe(true);
    // Masked values should not expose full content
    expect(vars[0].actual).toContain('***');

    expect(vars[1].name).toBe('LOG_LEVEL');
    expect(vars[1].actual).toBe('info');
    expect(vars[1].masked).toBe(false);

    expect(vars[2].name).toBe('MISSING_VAR');
    expect(vars[2].actual).toBeNull();

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
  });

  it('getConfigDiff detects mismatches', async () => {
    process.env.DATABASE_URL = 'postgresql://wrong-host:5432/app';
    process.env.LOG_LEVEL = 'info';
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const diffs = await client.getConfigDiff();

    // DATABASE_URL mismatch + MISSING_VAR not set
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    const dbDiff = diffs.find((d) => d.path === 'DATABASE_URL');
    expect(dbDiff).toBeDefined();

    const missingDiff = diffs.find((d) => d.path === 'MISSING_VAR');
    expect(missingDiff).toBeDefined();
    expect(missingDiff!.actual).toBe('<not set>');

    // LOG_LEVEL matches — should NOT be in diffs
    const logDiff = diffs.find((d) => d.path === 'LOG_LEVEL');
    expect(logDiff).toBeUndefined();

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
  });

  it('getConfigDiff returns empty when all aligned', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const diffs = await client.getConfigDiff();
    expect(diffs).toHaveLength(0);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('evaluateCheck handles config_drift_count', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'config_drift_count',
      expect: { operator: 'eq', value: 0 },
    });
    expect(result).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('evaluateCheck handles all_configs_aligned', async () => {
    process.env.DATABASE_URL = 'postgresql://wrong:5432/app';
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'all_configs_aligned',
      expect: { operator: 'eq', value: 'false' },
    });
    expect(result).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
  });

  it('executeCommand scan_config returns full state', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'scan_config' }) as Record<string, unknown>;
    expect(result).toHaveProperty('envVars');
    expect(result).toHaveProperty('secrets');
    expect(result).toHaveProperty('configDiffs');
    expect(result).toHaveProperty('recentChanges');

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('executeCommand verify_alignment checks diffs', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'verify_alignment' }) as { aligned: boolean };
    expect(result.aligned).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('rejects unsupported command types', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported config-drift live client command type');
  });

  it('getSecretStatus returns empty for no secrets', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    const secrets = await client.getSecretStatus();
    expect(secrets).toHaveLength(0);
  });

  it('transition is a no-op', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });

  it('close is safe to call', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
