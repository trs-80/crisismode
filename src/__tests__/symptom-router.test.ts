// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeBySymptoms, collectSignalsFromStack, routeByAi } from '../framework/symptom-router.js';
import type { SymptomSignal } from '../framework/symptom-router.js';
import type { StackProfile } from '../cli/autodiscovery.js';

// Mock the Anthropic SDK so routeByAi never makes real API calls
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      constructor() {}
      messages = {
        create: vi.fn().mockRejectedValue(new Error('mock: not configured')),
      };
    },
  };
});

// ── Helpers ──

function makeStackProfile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    confidence: 0,
    ...overrides,
  };
}

// ── routeBySymptoms ──

describe('routeBySymptoms', () => {
  it('routes error rate + deploy change to deploy rollback agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'monitoring', detail: 'Error rate spiked to 15%', severity: 'critical' },
      { type: 'deploy_change', source: 'platform', detail: 'Deploy abc123 completed 5min ago', severity: 'info' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.recommendedAgent).toBeTruthy();
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.explanation).toBeTruthy();
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('routes timeout + AI provider to AI provider failover', () => {
    const signals: SymptomSignal[] = [
      { type: 'timeout', source: 'app', detail: 'Request timeout rate 40%', severity: 'critical' },
      { type: 'latency', source: 'provider', detail: 'OpenAI p95 latency 15s', severity: 'critical' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.explanation).toBeTruthy();
  });

  it('routes connection exhaustion to DB migration agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'connection', source: 'database', detail: 'Connection pool at 98%', severity: 'critical' },
      { type: 'resource_exhaustion', source: 'database', detail: 'Max connections reached', severity: 'critical' },
    ];

    const result = routeBySymptoms(signals);
    expect(result.scenarios.length).toBeGreaterThan(0);
  });

  it('returns empty result for no signals', () => {
    const result = routeBySymptoms([]);
    expect(result.scenarios.length).toBe(0);
    expect(result.recommendedAgent).toBeNull();
  });

  // ── Additional routeBySymptoms tests ──

  it('routes replication lag signals to postgresql agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'latency', source: 'database', detail: 'Replication lag on standby replica 30s', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const pgScenario = result.scenarios.find((s) => s.scenario === 'replication-lag');
    expect(pgScenario).toBeDefined();
    expect(pgScenario!.agentKind).toBe('postgresql');
  });

  it('routes redis memory signals to redis agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'resource_exhaustion', source: 'cache', detail: 'Redis memory eviction rate high', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const redisScenario = result.scenarios.find((s) => s.scenario === 'redis-memory-pressure');
    expect(redisScenario).toBeDefined();
    expect(redisScenario!.agentKind).toBe('redis');
  });

  it('routes queue backlog signals to redis agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'queue_depth', source: 'workers', detail: 'Queue backlog growing, 5000 stuck jobs', severity: 'warning' },
    ];
    const result = routeBySymptoms(signals);
    const queueScenario = result.scenarios.find((s) => s.scenario === 'queue-backlog');
    expect(queueScenario).toBeDefined();
    expect(queueScenario!.agentKind).toBe('redis');
  });

  it('routes kafka consumer lag signals to kafka agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'queue_depth', source: 'kafka', detail: 'Consumer lag on partition 3, offset behind by 50k', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const kafkaScenario = result.scenarios.find((s) => s.scenario === 'kafka-consumer-lag');
    expect(kafkaScenario).toBeDefined();
    expect(kafkaScenario!.agentKind).toBe('kafka');
  });

  it('routes etcd consensus signals to etcd agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'connection', source: 'etcd', detail: 'etcd leader election failed, quorum lost', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const etcdScenario = result.scenarios.find((s) => s.scenario === 'etcd-consensus-loss');
    expect(etcdScenario).toBeDefined();
    expect(etcdScenario!.agentKind).toBe('etcd');
  });

  it('routes kubernetes pod crash signals to kubernetes agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'kubernetes', detail: 'Pod crashloopbackoff detected in k8s cluster', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const k8sScenario = result.scenarios.find((s) => s.scenario === 'kubernetes-pod-crash-loop');
    expect(k8sScenario).toBeDefined();
    expect(k8sScenario!.agentKind).toBe('kubernetes');
  });

  it('routes ceph storage signals to ceph agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'storage', detail: 'Ceph OSD down, degraded placement groups', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const cephScenario = result.scenarios.find((s) => s.scenario === 'ceph-storage-degraded');
    expect(cephScenario).toBeDefined();
    expect(cephScenario!.agentKind).toBe('ceph');
  });

  it('routes flink checkpoint failure signals to flink agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'streaming', detail: 'Flink checkpoint failure, backpressure rising', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const flinkScenario = result.scenarios.find((s) => s.scenario === 'flink-checkpoint-failure');
    expect(flinkScenario).toBeDefined();
    expect(flinkScenario!.agentKind).toBe('flink');
  });

  it('routes config drift signals to application-config agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'config_mismatch', source: 'deploy', detail: 'Configuration drift detected after env change', severity: 'warning' },
    ];
    const result = routeBySymptoms(signals);
    const configScenario = result.scenarios.find((s) => s.scenario === 'config-drift');
    expect(configScenario).toBeDefined();
    expect(configScenario!.agentKind).toBe('application-config');
  });

  it('routes ai-provider signals to ai-provider agent', () => {
    const signals: SymptomSignal[] = [
      { type: 'timeout', source: 'openai', detail: 'OpenAI API rate limit 429 errors', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    const aiScenario = result.scenarios.find((s) => s.scenario === 'ai-provider-failover');
    expect(aiScenario).toBeDefined();
    expect(aiScenario!.agentKind).toBe('ai-provider');
  });

  it('applies severity weighting: critical signals score higher than warning', () => {
    const criticalSignals: SymptomSignal[] = [
      { type: 'latency', source: 'db', detail: 'Replication lag', severity: 'critical' },
    ];
    const warningSignals: SymptomSignal[] = [
      { type: 'latency', source: 'db', detail: 'Replication lag', severity: 'warning' },
    ];

    const critResult = routeBySymptoms(criticalSignals);
    const warnResult = routeBySymptoms(warningSignals);

    // Same scenario should appear with higher confidence for critical
    const critScenario = critResult.scenarios.find((s) => s.scenario === 'replication-lag');
    const warnScenario = warnResult.scenarios.find((s) => s.scenario === 'replication-lag');
    expect(critScenario).toBeDefined();
    expect(warnScenario).toBeDefined();
    expect(critScenario!.confidence).toBeGreaterThan(warnScenario!.confidence);
  });

  it('applies severity weighting: warning signals score higher than info', () => {
    const warningSignals: SymptomSignal[] = [
      { type: 'error_rate', source: 'app', detail: 'deploy rollback needed', severity: 'warning' },
    ];
    const infoSignals: SymptomSignal[] = [
      { type: 'error_rate', source: 'app', detail: 'deploy rollback needed', severity: 'info' },
    ];

    const warnResult = routeBySymptoms(warningSignals);
    const infoResult = routeBySymptoms(infoSignals);

    const warnScenario = warnResult.scenarios.find((s) => s.scenario === 'deploy-rollback');
    const infoScenario = infoResult.scenarios.find((s) => s.scenario === 'deploy-rollback');
    expect(warnScenario).toBeDefined();
    expect(infoScenario).toBeDefined();
    expect(warnScenario!.confidence).toBeGreaterThan(infoScenario!.confidence);
  });

  it('boosts score when stack profile has matching detected services', () => {
    const signals: SymptomSignal[] = [
      { type: 'latency', source: 'db', detail: 'High latency on queries', severity: 'warning' },
    ];

    const withStack = routeBySymptoms(signals, makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: true }],
    }));
    const withoutStack = routeBySymptoms(signals);

    const withStackPg = withStack.scenarios.find((s) => s.agentKind === 'postgresql');
    const withoutStackPg = withoutStack.scenarios.find((s) => s.agentKind === 'postgresql');
    expect(withStackPg).toBeDefined();
    expect(withoutStackPg).toBeDefined();
    expect(withStackPg!.confidence).toBeGreaterThan(withoutStackPg!.confidence);
  });

  it('boosts score when stack profile has matching dependencies', () => {
    const signals: SymptomSignal[] = [
      { type: 'resource_exhaustion', source: 'cache', detail: 'Memory high', severity: 'warning' },
    ];

    const withDeps = routeBySymptoms(signals, makeStackProfile({
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['ioredis'] },
    }));
    const withoutDeps = routeBySymptoms(signals);

    const withDepsRedis = withDeps.scenarios.find((s) => s.agentKind === 'redis');
    const withoutDepsRedis = withoutDeps.scenarios.find((s) => s.agentKind === 'redis');
    expect(withDepsRedis).toBeDefined();
    expect(withoutDepsRedis).toBeDefined();
    expect(withDepsRedis!.confidence).toBeGreaterThan(withoutDepsRedis!.confidence);
  });

  it('boosts score when stack profile has matching env hints', () => {
    const signals: SymptomSignal[] = [
      { type: 'connection', source: 'db', detail: 'Connection refused', severity: 'critical' },
    ];

    const withEnvHints = routeBySymptoms(signals, makeStackProfile({
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database', inferredService: 'postgresql' }],
    }));
    const withoutEnvHints = routeBySymptoms(signals);

    const withHintPg = withEnvHints.scenarios.find((s) => s.agentKind === 'postgresql');
    const withoutHintPg = withoutEnvHints.scenarios.find((s) => s.agentKind === 'postgresql');
    expect(withHintPg).toBeDefined();
    expect(withoutHintPg).toBeDefined();
    expect(withHintPg!.confidence).toBeGreaterThan(withoutHintPg!.confidence);
  });

  it('keyword matching in signal detail boosts scenario score', () => {
    // Signal with explicit postgres keyword vs generic latency signal
    const withKeyword: SymptomSignal[] = [
      { type: 'latency', source: 'monitoring', detail: 'postgres replica lag increasing', severity: 'warning' },
    ];
    const withoutKeyword: SymptomSignal[] = [
      { type: 'latency', source: 'monitoring', detail: 'service response time increasing', severity: 'warning' },
    ];

    const resultWith = routeBySymptoms(withKeyword);
    const resultWithout = routeBySymptoms(withoutKeyword);

    const pgWith = resultWith.scenarios.find((s) => s.scenario === 'replication-lag');
    const pgWithout = resultWithout.scenarios.find((s) => s.scenario === 'replication-lag');
    expect(pgWith).toBeDefined();
    // Without keywords the scenario may still appear (from signal type match) but with lower confidence
    if (pgWithout) {
      expect(pgWith!.confidence).toBeGreaterThan(pgWithout.confidence);
    }
  });

  it('keyword matching in signal source boosts scenario score', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'kafka broker', detail: 'Error spike', severity: 'warning' },
    ];
    const result = routeBySymptoms(signals);
    const kafkaScenario = result.scenarios.find((s) => s.scenario === 'kafka-consumer-lag');
    expect(kafkaScenario).toBeDefined();
  });

  it('evidence includes all signals formatted with severity', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'monitoring', detail: 'Errors spiking', severity: 'critical' },
      { type: 'latency', source: 'app', detail: 'Slow responses', severity: 'warning' },
    ];
    const result = routeBySymptoms(signals);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toContain('[CRITICAL]');
    expect(result.evidence[0]).toContain('monitoring');
    expect(result.evidence[1]).toContain('[WARNING]');
    expect(result.evidence[1]).toContain('app');
  });

  it('explanation mentions top scenario and confidence when there are matches', () => {
    const signals: SymptomSignal[] = [
      { type: 'latency', source: 'db', detail: 'Replication lag 20s', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals);
    expect(result.explanation).toContain('Most likely scenario');
    expect(result.explanation).toContain('confidence');
  });

  it('confidence is capped at 1.0', () => {
    // Many matching signals to potentially push score above 1.0
    const signals: SymptomSignal[] = [
      { type: 'latency', source: 'postgres replication', detail: 'replica lag WAL standby', severity: 'critical' },
      { type: 'timeout', source: 'postgres replica', detail: 'standby pg timeout replication', severity: 'critical' },
    ];
    const result = routeBySymptoms(signals, makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: true }],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['pg'] },
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database', inferredService: 'postgresql' }],
    }));
    for (const scenario of result.scenarios) {
      expect(scenario.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it('scenarios are sorted by confidence descending', () => {
    const signals: SymptomSignal[] = [
      { type: 'error_rate', source: 'monitoring', detail: 'Errors across all services', severity: 'critical' },
      { type: 'latency', source: 'app', detail: 'High latency detected', severity: 'warning' },
      { type: 'timeout', source: 'services', detail: 'Timeouts everywhere', severity: 'warning' },
    ];
    const result = routeBySymptoms(signals);
    for (let i = 1; i < result.scenarios.length; i++) {
      expect(result.scenarios[i - 1].confidence).toBeGreaterThanOrEqual(result.scenarios[i].confidence);
    }
  });

  it('does not boost for stack service that is not detected', () => {
    const signals: SymptomSignal[] = [
      { type: 'latency', source: 'db', detail: 'High latency on queries', severity: 'warning' },
    ];

    const notDetected = routeBySymptoms(signals, makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: false }],
    }));
    const noStack = routeBySymptoms(signals);

    const ndPg = notDetected.scenarios.find((s) => s.agentKind === 'postgresql');
    const nsPg = noStack.scenarios.find((s) => s.agentKind === 'postgresql');
    // With detected=false, there should be no boost compared to no stack at all
    expect(ndPg?.confidence).toBe(nsPg?.confidence);
  });
});

// ── collectSignalsFromStack ──

describe('collectSignalsFromStack', () => {
  it('emits connection signal when env var present but service not reachable', async () => {
    const profile = makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: false }],
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database', inferredService: 'postgresql' }],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('connection');
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].source).toContain('DATABASE_URL');
    expect(signals[0].detail).toContain('not reachable');
    expect(signals[0].detail).toContain('postgresql');
  });

  it('emits config_mismatch signal when dependency found but no env var and no service', async () => {
    const profile = makeStackProfile({
      services: [],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['pg'] },
      envHints: [],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('config_mismatch');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].source).toContain('pg');
    expect(signals[0].detail).toContain('pg');
    expect(signals[0].detail).toContain('postgresql');
  });

  it('emits config_mismatch signal for AI provider SDK without API key', async () => {
    const profile = makeStackProfile({
      aiProviders: [{ provider: 'openai', configured: false, envVar: 'OPENAI_API_KEY' }],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('config_mismatch');
    expect(signals[0].severity).toBe('info');
    expect(signals[0].source).toContain('openai');
    expect(signals[0].detail).toContain('OPENAI_API_KEY');
  });

  it('returns empty signals for a clean profile with no issues', async () => {
    const profile = makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: true }],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['pg'] },
      envHints: [{ name: 'DATABASE_URL', present: true, kind: 'database', inferredService: 'postgresql' }],
      aiProviders: [{ provider: 'anthropic', configured: true, envVar: 'ANTHROPIC_API_KEY' }],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(0);
  });

  it('does not emit signal when env var present and service is reachable', async () => {
    const profile = makeStackProfile({
      services: [{ kind: 'redis', host: 'localhost', port: 6379, detected: true }],
      envHints: [{ name: 'REDIS_URL', present: true, kind: 'cache', inferredService: 'redis' }],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(0);
  });

  it('does not emit config_mismatch when dependency has matching env hint', async () => {
    const profile = makeStackProfile({
      services: [],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['ioredis'] },
      envHints: [{ name: 'REDIS_URL', present: true, kind: 'cache', inferredService: 'redis' }],
    });

    const signals = await collectSignalsFromStack(profile);
    // ioredis maps to redis; REDIS_URL env hint infers redis and is present, so no mismatch
    expect(signals).toHaveLength(0);
  });

  it('does not emit config_mismatch when dependency has detected service', async () => {
    const profile = makeStackProfile({
      services: [{ kind: 'redis', host: 'localhost', port: 6379, detected: true }],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['ioredis'] },
      envHints: [],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(0);
  });

  it('emits multiple signals for multiple issues', async () => {
    const profile = makeStackProfile({
      services: [
        { kind: 'postgresql', host: 'localhost', port: 5432, detected: false },
        { kind: 'redis', host: 'localhost', port: 6379, detected: false },
      ],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['kafkajs'] },
      envHints: [
        { name: 'DATABASE_URL', present: true, kind: 'database', inferredService: 'postgresql' },
        { name: 'REDIS_URL', present: true, kind: 'cache', inferredService: 'redis' },
      ],
      aiProviders: [{ provider: 'openai', configured: false, envVar: 'OPENAI_API_KEY' }],
    });

    const signals = await collectSignalsFromStack(profile);
    // 2 connection signals (pg + redis not reachable) + 1 config_mismatch (kafkajs no service/env) + 1 ai provider
    expect(signals).toHaveLength(4);
    const types = signals.map((s) => s.type);
    expect(types.filter((t) => t === 'connection')).toHaveLength(2);
    expect(types.filter((t) => t === 'config_mismatch')).toHaveLength(2);
  });

  it('skips env hints that are not present', async () => {
    const profile = makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: false }],
      envHints: [{ name: 'DATABASE_URL', present: false, kind: 'database', inferredService: 'postgresql' }],
    });

    const signals = await collectSignalsFromStack(profile);
    // env var is not present so the connection check is skipped
    expect(signals).toHaveLength(0);
  });

  it('skips env hints without inferred service', async () => {
    const profile = makeStackProfile({
      envHints: [{ name: 'SOME_VAR', present: true, kind: 'unknown' }],
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(0);
  });

  it('skips dependencies not in depServiceMap', async () => {
    const profile = makeStackProfile({
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['express', 'lodash'] },
    });

    const signals = await collectSignalsFromStack(profile);
    expect(signals).toHaveLength(0);
  });
});

// ── routeByAi ──

describe('routeByAi', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('falls back to rule-based routing when ANTHROPIC_API_KEY is not set', async () => {
    const result = await routeByAi('Our postgres replication lag is increasing');
    // Should fall back and produce results via questionToSignals + routeBySymptoms
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.evidence[0]).toContain('rule-based fallback');
  });

  it('fallback with keywords in question generates signals and routes', async () => {
    const result = await routeByAi('Redis is running out of memory and we see OOM errors');
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.recommendedAgent).toBeTruthy();
    expect(result.evidence[0]).toContain('rule-based fallback');
  });

  it('fallback routes deploy-related question to deploy rollback', async () => {
    const result = await routeByAi('We deployed a new version and now errors are spiking');
    expect(result.scenarios.length).toBeGreaterThan(0);
    // Should have deploy-rollback in scenarios since "deploy" and "errors" are keywords
    const deployScenario = result.scenarios.find((s) => s.scenario === 'deploy-rollback');
    expect(deployScenario).toBeDefined();
  });

  it('fallback with no matching keywords returns empty result', async () => {
    const result = await routeByAi('How do I set up my project?');
    expect(result.scenarios).toHaveLength(0);
    expect(result.recommendedAgent).toBeNull();
    expect(result.explanation).toContain('Could not route');
  });

  it('fallback includes the question in evidence', async () => {
    const result = await routeByAi('Something is wrong with timeouts');
    expect(result.evidence.some((e) => e.includes('timeouts'))).toBe(true);
  });

  it('falls back when AI call throws an error (with API key set)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-fake';

    const result = await routeByAi('Kafka consumer lag is growing rapidly');
    // The mock SDK will throw, so it should fall back to rule-based
    expect(result.scenarios.length).toBeGreaterThan(0);
    expect(result.evidence[0]).toContain('rule-based fallback');
  });

  it('fallback with stack profile passes it to routeBySymptoms for boosting', async () => {
    const stack = makeStackProfile({
      services: [{ kind: 'postgresql', host: 'localhost', port: 5432, detected: true }],
      appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: ['pg'] },
    });

    const withStack = await routeByAi('Database connection errors and slow queries', stack);
    const withoutStack = await routeByAi('Database connection errors and slow queries');

    // Both should produce results, but with stack profile the PG agent should score higher
    const withStackPg = withStack.scenarios.find((s) => s.agentKind === 'postgresql');
    const withoutStackPg = withoutStack.scenarios.find((s) => s.agentKind === 'postgresql');
    expect(withStackPg).toBeDefined();
    if (withoutStackPg) {
      expect(withStackPg!.confidence).toBeGreaterThanOrEqual(withoutStackPg.confidence);
    }
  });

  it('fallback generates timeout signal from question with timeout keyword', async () => {
    const result = await routeByAi('Requests keep hitting timeout errors on our API');
    expect(result.scenarios.length).toBeGreaterThan(0);
    // timeout keyword should generate timeout signal
    const hasTimeoutScenario = result.scenarios.some(
      (s) => s.agentKind === 'ai-provider' || s.agentKind === 'postgresql' || s.agentKind === 'etcd',
    );
    expect(hasTimeoutScenario).toBe(true);
  });

  it('fallback generates queue_depth signal from question with queue keyword', async () => {
    const result = await routeByAi('Our queue backlog is growing and workers are stuck');
    expect(result.scenarios.length).toBeGreaterThan(0);
    const queueScenario = result.scenarios.find(
      (s) => s.scenario === 'queue-backlog' || s.scenario === 'kafka-consumer-lag',
    );
    expect(queueScenario).toBeDefined();
  });

  it('fallback generates config_mismatch signal from question with config keyword', async () => {
    const result = await routeByAi('There is a configuration mismatch after the last env change');
    expect(result.scenarios.length).toBeGreaterThan(0);
    const configScenario = result.scenarios.find((s) => s.scenario === 'config-drift');
    expect(configScenario).toBeDefined();
  });
});
