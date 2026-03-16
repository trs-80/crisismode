// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeInput, parseStandardDiagnosisResponse } from '../framework/ai-diagnosis.js';
import { AgentRegistry } from '../config/agent-registry.js';
import type { AgentInstance } from '../config/agent-registration.js';
import { validateCredentials } from '../config/credentials.js';
import { resolveTarget } from '../config/resolve.js';
import type { SiteConfig, ResolvedTarget } from '../config/schema.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryStep } from '../types/step-types.js';

// ── AI Diagnosis Toolkit ──

describe('AI Diagnosis Toolkit', () => {
  describe('sanitizeInput', () => {
    it('strips control characters except newline/tab', () => {
      const input = 'hello\x00world\x07\ttab\nnewline';
      const result = sanitizeInput(input);
      expect(result).toBe('helloworld\ttab\nnewline');
    });

    it('truncates long input with indicator', () => {
      const input = 'a'.repeat(200);
      const result = sanitizeInput(input, 100);
      expect(result.length).toBeLessThan(200);
      expect(result).toContain('[truncated]');
    });

    it('leaves short clean input unchanged', () => {
      const input = 'Normal diagnostic output: lag_seconds=5';
      expect(sanitizeInput(input)).toBe(input);
    });
  });

  describe('parseStandardDiagnosisResponse', () => {
    it('parses a valid JSON diagnosis response', () => {
      const json = JSON.stringify({
        status: 'identified',
        scenario: 'replication_lag_cascade',
        confidence: 0.92,
        root_cause: 'Heavy write load causing WAL generation to outpace replay',
        findings: [
          {
            source: 'pg_stat_replication',
            observation: 'Replica lagging by 45 seconds',
            severity: 'critical',
            evidence: 'replay_lsn 30 seconds behind sent_lsn',
          },
        ],
        recommendations: ['Reduce write load', 'Check replica IO'],
      });

      const result = parseStandardDiagnosisResponse(json);
      expect(result.status).toBe('identified');
      expect(result.scenario).toBe('replication_lag_cascade');
      expect(result.confidence).toBe(0.92);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[0].data?.root_cause).toBe('Heavy write load causing WAL generation to outpace replay');
    });

    it('handles markdown-wrapped JSON', () => {
      const wrapped = '```json\n{"status":"identified","scenario":null,"confidence":0.5,"findings":[]}\n```';
      const result = parseStandardDiagnosisResponse(wrapped);
      expect(result.status).toBe('identified');
      expect(result.scenario).toBeNull();
    });

    it('clamps confidence to [0, 1]', () => {
      const json = JSON.stringify({ status: 'identified', confidence: 1.5, findings: [] });
      const result = parseStandardDiagnosisResponse(json);
      expect(result.confidence).toBe(1);
    });

    it('defaults missing fields', () => {
      const json = JSON.stringify({});
      const result = parseStandardDiagnosisResponse(json);
      expect(result.status).toBe('identified');
      expect(result.confidence).toBe(0.5);
      expect(result.findings).toEqual([]);
    });
  });
});

// ── Version-Aware Agent Selection ──

describe('Version-Aware Agent Selection', () => {
  const baseConfig: SiteConfig = {
    apiVersion: 'crisismode/v1',
    kind: 'SiteConfig',
    metadata: { name: 'test-site' },
    targets: [
      {
        name: 'pg-16',
        kind: 'postgresql',
        version: '16.2',
        primary: { host: 'pg.local', port: 5432, database: 'testdb' },
        credentials: { type: 'value', username: 'admin', password: 'secret' },
      },
    ],
  };

  it('selects PG agent for version within constraint (16.2 in >=14.0 <18.0)', async () => {
    const registry = new AgentRegistry(baseConfig);
    const instance = await registry.createForTarget('pg-16');
    expect(instance.agent.manifest.metadata.name).toBe('postgresql-replication-recovery');
  });

  it('rejects version outside constraint (9.5 not in >=14.0 <18.0)', async () => {
    const config: SiteConfig = {
      ...baseConfig,
      targets: [{ ...baseConfig.targets[0], version: '9.5' }],
    };
    const registry = new AgentRegistry(config);
    await expect(registry.createForTarget('pg-16')).rejects.toThrow('No agent supports postgresql 9.5');
  });

  it('matches any agent when version is omitted (backward-compatible)', async () => {
    const config: SiteConfig = {
      ...baseConfig,
      targets: [{ ...baseConfig.targets[0], version: undefined }],
    };
    const registry = new AgentRegistry(config);
    const instance = await registry.createForTarget('pg-16');
    expect(instance.agent.manifest.metadata.name).toBe('postgresql-replication-recovery');
  });

  it('error message lists available agents and version ranges', async () => {
    const config: SiteConfig = {
      ...baseConfig,
      targets: [{ ...baseConfig.targets[0], version: '9.5' }],
    };
    const registry = new AgentRegistry(config);
    try {
      await registry.createForTarget('pg-16');
      expect.unreachable('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('postgresql-replication-recovery');
      expect(msg).toContain('>=14.0 <18.0');
    }
  });
});

// ── Version in Config ──

describe('Version in config', () => {
  it('resolves version from target config', () => {
    const resolved = resolveTarget({
      name: 'pg',
      kind: 'postgresql',
      version: '16.2',
      primary: { host: 'localhost', port: 5432 },
    });
    expect(resolved.version).toBe('16.2');
  });

  it('resolves undefined version when not specified', () => {
    const resolved = resolveTarget({
      name: 'pg',
      kind: 'postgresql',
      primary: { host: 'localhost', port: 5432 },
    });
    expect(resolved.version).toBeUndefined();
  });
});

// ── Version Discovery ──

describe('Version Discovery', () => {
  function makeTarget(version?: string): ResolvedTarget {
    return {
      name: 'test',
      kind: 'postgresql',
      version,
      primary: { host: 'localhost', port: 5432 },
      replicas: [],
      credentials: {},
    };
  }

  function makeBackend(discoverVersion?: () => Promise<string>): ExecutionBackend {
    return {
      executeCommand: async () => ({}),
      evaluateCheck: async () => true,
      close: async () => {},
      ...(discoverVersion ? { discoverVersion } : {}),
    };
  }

  function makeInstance(target: ResolvedTarget, backend: ExecutionBackend): AgentInstance {
    return { agent: {} as AgentInstance['agent'], backend, target };
  }

  it('discovers version from backend when target has none', async () => {
    const target = makeTarget();
    const instance = makeInstance(target, makeBackend(async () => '16.2.1'));

    await AgentRegistry.discoverVersion(instance);
    expect(instance.target.version).toBe('16.2.1');
  });

  it('skips discovery when version already set', async () => {
    const discoverFn = vi.fn().mockResolvedValue('16.2.1');
    const target = makeTarget('15.0');
    const instance = makeInstance(target, makeBackend(discoverFn));

    await AgentRegistry.discoverVersion(instance);
    expect(discoverFn).not.toHaveBeenCalled();
    expect(instance.target.version).toBe('15.0');
  });

  it('handles discovery failure gracefully', async () => {
    const target = makeTarget();
    const instance = makeInstance(target, makeBackend(async () => { throw new Error('Connection refused'); }));

    await AgentRegistry.discoverVersion(instance);
    expect(instance.target.version).toBeUndefined();
  });

  it('skips when backend has no discoverVersion', async () => {
    const target = makeTarget();
    const instance = makeInstance(target, makeBackend());

    await AgentRegistry.discoverVersion(instance);
    expect(instance.target.version).toBeUndefined();
  });
});

// ── Credential Validation ──

describe('Credential validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns no warnings for value credentials', () => {
    const warnings = validateCredentials({ type: 'value', username: 'admin', password: 'pass' });
    expect(warnings).toEqual([]);
  });

  it('returns no warnings when env vars are set', () => {
    vi.stubEnv('MY_USER', 'alice');
    vi.stubEnv('MY_PASS', 'hunter2');
    const warnings = validateCredentials({ type: 'env', username: 'MY_USER', password: 'MY_PASS' });
    expect(warnings).toEqual([]);
  });

  it('warns when env username var is missing', () => {
    const warnings = validateCredentials({ type: 'env', username: 'MISSING_USER' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].envVar).toBe('MISSING_USER');
    expect(warnings[0].field).toBe('username');
  });

  it('warns when env password var is missing', () => {
    const warnings = validateCredentials({ type: 'env', password: 'MISSING_PASS' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].envVar).toBe('MISSING_PASS');
  });

  it('warns when env token var is missing', () => {
    const warnings = validateCredentials({ type: 'env', key: 'MISSING_TOKEN' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe('token');
  });

  it('returns no warnings for undefined credentials', () => {
    expect(validateCredentials(undefined)).toEqual([]);
  });

  it('warns for k8s-secret env fallback vars', () => {
    const warnings = validateCredentials({
      type: 'k8s-secret',
      name: 'my-secret',
      usernameKey: 'MISSING_K8S_USER',
      passwordKey: 'MISSING_K8S_PASS',
    });
    expect(warnings).toHaveLength(2);
  });
});

// ── Plan Explainer Fallback ──

describe('AI Plan Explainer (fallback)', () => {
  it('produces a structural explanation without API key', async () => {
    // explainPlan falls back when no ANTHROPIC_API_KEY is set
    const { explainPlan } = await import('../framework/ai-explainer.js');

    const steps: RecoveryStep[] = [
      {
        stepId: 'diag-1',
        type: 'diagnosis_action',
        name: 'Check replication status',
        executionContext: 'postgresql_read',
        target: 'postgresql',
        command: { type: 'sql', statement: 'SELECT * FROM pg_stat_replication' },
        timeout: '30s',
      },
      {
        stepId: 'notify-1',
        type: 'human_notification',
        name: 'Notify DBA team',
        message: { summary: 'Replication lag detected', detail: 'Lag exceeds threshold', actionRequired: true },
        recipients: [{ role: 'dba', urgency: 'high' }],
        channel: 'slack',
      },
    ];

    const plan: RecoveryPlan = {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: 'test-plan',
        agentName: 'test-agent',
        agentVersion: '1.0.0',
        scenario: 'replication_lag_cascade',
        createdAt: new Date().toISOString(),
        estimatedDuration: '5 minutes',
        summary: 'Recover replication lag',
        supersedes: null,
      },
      impact: {
        affectedSystems: [{ identifier: 'replica-1', technology: 'postgresql', role: 'replica', impactType: 'restart' }],
        affectedServices: ['read-api'],
        estimatedUserImpact: 'Read queries may fail for 30 seconds',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Reverse each step in order',
      },
    };

    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'replication_lag_cascade',
      confidence: 0.9,
      findings: [],
      diagnosticPlanNeeded: false,
    };

    // Ensure no API key
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const explanation = await explainPlan(plan, diagnosis);
      expect(explanation.source).toBe('fallback');
      expect(explanation.summary).toContain('replication_lag_cascade');
      expect(explanation.stepExplanations).toHaveLength(2);
      expect(explanation.stepExplanations[0].stepId).toBe('diag-1');
      expect(explanation.risks.length).toBeGreaterThan(0);
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});
