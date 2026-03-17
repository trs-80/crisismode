// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAgent, validateCheckPlugin } from '../framework/agent-test-harness.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { AgentContext } from '../types/agent-context.js';
import type { AgentManifest } from '../types/manifest.js';
import type { HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { ReplanResult } from '../agent/interface.js';
import type { CheckPluginManifest } from '../framework/check-plugin.js';

// ── Helpers ──

function makeManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    apiVersion: 'crisismode.dev/v1',
    kind: 'AgentManifest',
    metadata: {
      name: 'test-agent',
      version: '1.0.0',
      description: 'Test agent',
      authors: ['test'],
      license: 'Apache-2.0',
      tags: [],
      plugin: {
        id: 'test-agent',
        name: 'test-agent',
        version: '1.0.0',
        type: 'agent',
      },
    },
    spec: {
      targetSystems: [
        {
          technology: 'generic',
          versionConstraint: '*',
          components: ['primary'],
        },
      ],
      triggerConditions: [{ type: 'manual', description: 'manual' }],
      failureScenarios: ['generic-failure'],
      executionContexts: [
        { name: 'shell', type: 'shell', privilege: 'user', target: 'localhost' },
      ],
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: {
        maxRiskLevel: 'low',
        dataLossPossible: false,
        serviceDisruptionPossible: false,
      },
      humanInteraction: {
        requiresApproval: false,
        minimumApprovalRole: 'operator',
        escalationPath: [],
      },
    },
    ...overrides,
  } as AgentManifest;
}

function makeContext(): AgentContext {
  return {
    trigger: {
      type: 'manual',
      source: 'test',
      payload: {},
      receivedAt: new Date().toISOString(),
    },
    topology: {
      source: 'test',
      staleness: 'fresh',
      authoritative: true,
      components: [],
      relationships: [],
    },
    frameworkLayers: {
      execution_kernel: 'available',
      safety: 'available',
      coordination: 'available',
      enrichment: 'available',
    },
    trustLevel: 'full_autonomy',
    trustScenarioOverrides: {},
    organizationalPolicies: {
      maxAutonomousRiskLevel: 'elevated',
      requireApprovalAbove: 'elevated',
      requireApprovalForAllElevated: false,
      shellCommandsEnabled: true,
      approvalTimeoutMinutes: 30,
      escalationDepth: 3,
    },
    preAuthorizedCatalogs: [],
    availableExecutionContexts: ['shell'],
    priorIncidents: [],
  };
}

function makeHealthAssessment(overrides?: Partial<HealthAssessment>): HealthAssessment {
  return {
    status: 'healthy',
    confidence: 0.9,
    summary: 'System is healthy',
    observedAt: new Date().toISOString(),
    signals: [],
    recommendedActions: [],
    ...overrides,
  };
}

function makeDiagnosis(overrides?: Partial<DiagnosisResult>): DiagnosisResult {
  return {
    status: 'identified',
    scenario: 'test-scenario',
    confidence: 0.85,
    findings: [
      {
        source: 'test',
        observation: 'test finding',
        severity: 'info',
      },
    ],
    diagnosticPlanNeeded: false,
    ...overrides,
  };
}

function makePlan(overrides?: Partial<RecoveryPlan>): RecoveryPlan {
  return {
    apiVersion: 'crisismode.dev/v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'plan-001',
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      scenario: 'test-scenario',
      createdAt: new Date().toISOString(),
      estimatedDuration: '1m',
      summary: 'Test recovery plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps: [
      {
        stepId: 'step-1',
        type: 'diagnosis_action',
        name: 'Check health',
        executionContext: 'shell',
        target: 'localhost',
        command: { type: 'structured_command', operation: 'echo ok' },
        timeout: '30s',
      } as RecoveryPlan['steps'][number],
    ],
    rollbackStrategy: {
      type: 'none',
      description: 'No rollback needed',
    },
    ...overrides,
  };
}

function makeAgent(overrides?: {
  manifest?: AgentManifest;
  health?: HealthAssessment;
  diagnosis?: DiagnosisResult;
  plan?: RecoveryPlan;
}): RecoveryAgent {
  const diagnosis = overrides?.diagnosis ?? makeDiagnosis();
  return {
    manifest: overrides?.manifest ?? makeManifest(),
    assessHealth: async () => overrides?.health ?? makeHealthAssessment(),
    diagnose: async () => diagnosis,
    plan: async () => overrides?.plan ?? makePlan(),
    replan: async (): Promise<ReplanResult> => ({ action: 'continue' }),
  };
}

// ── validateAgent ──

describe('validateAgent', () => {
  it('passes for a well-behaved agent', async () => {
    const agent = makeAgent();
    const result = await validateAgent(agent, makeContext());

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(4);
    for (const check of result.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it('detects missing manifest name', async () => {
    const manifest = makeManifest();
    manifest.metadata.name = '';
    const agent = makeAgent({ manifest });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const manifestCheck = result.checks.find((c) => c.name.includes('manifest'));
    expect(manifestCheck?.passed).toBe(false);
    expect(manifestCheck?.message).toContain('metadata.name');
  });

  it('detects missing manifest apiVersion', async () => {
    const manifest = makeManifest();
    (manifest as unknown as Record<string, unknown>).apiVersion = '';
    const agent = makeAgent({ manifest });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);
  });

  it('detects wrong manifest kind', async () => {
    const manifest = makeManifest();
    (manifest as unknown as Record<string, unknown>).kind = 'WrongKind';
    const agent = makeAgent({ manifest });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const manifestCheck = result.checks.find((c) => c.name.includes('manifest'));
    expect(manifestCheck?.passed).toBe(false);
    expect(manifestCheck?.message).toContain('kind');
  });

  it('detects invalid health assessment status', async () => {
    const health = makeHealthAssessment({ status: 'bogus' as HealthAssessment['status'] });
    const agent = makeAgent({ health });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const healthCheck = result.checks.find((c) => c.name.includes('assessHealth'));
    expect(healthCheck?.passed).toBe(false);
    expect(healthCheck?.message).toContain('status');
  });

  it('detects confidence out of range', async () => {
    const health = makeHealthAssessment({ confidence: 1.5 });
    const agent = makeAgent({ health });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const healthCheck = result.checks.find((c) => c.name.includes('assessHealth'));
    expect(healthCheck?.passed).toBe(false);
    expect(healthCheck?.message).toContain('confidence');
  });

  it('detects invalid diagnosis status', async () => {
    const diagnosis = makeDiagnosis({ status: 'wrong' as DiagnosisResult['status'] });
    const agent = makeAgent({ diagnosis });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const diagCheck = result.checks.find((c) => c.name.includes('diagnose'));
    expect(diagCheck?.passed).toBe(false);
  });

  it('detects duplicate step IDs in plan', async () => {
    const plan = makePlan();
    plan.steps = [
      {
        stepId: 'dup',
        type: 'diagnosis_action',
        name: 'Step 1',
        executionContext: 'shell',
        target: 'localhost',
        command: { type: 'structured_command', operation: 'echo 1' },
        timeout: '30s',
      } as RecoveryPlan['steps'][number],
      {
        stepId: 'dup',
        type: 'diagnosis_action',
        name: 'Step 2',
        executionContext: 'shell',
        target: 'localhost',
        command: { type: 'structured_command', operation: 'echo 2' },
        timeout: '30s',
      } as RecoveryPlan['steps'][number],
    ];
    const agent = makeAgent({ plan });

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const planCheck = result.checks.find((c) => c.name.includes('plan'));
    expect(planCheck?.passed).toBe(false);
    expect(planCheck?.message).toContain('duplicate');
  });

  it('handles an agent that throws in assessHealth', async () => {
    const agent = makeAgent();
    agent.assessHealth = async () => {
      throw new Error('backend unavailable');
    };

    const result = await validateAgent(agent, makeContext());
    expect(result.passed).toBe(false);

    const healthCheck = result.checks.find((c) => c.name.includes('assessHealth'));
    expect(healthCheck?.passed).toBe(false);
    expect(healthCheck?.message).toContain('backend unavailable');
  });

  it('checks that methods return promises', async () => {
    const agent = makeAgent();
    const result = await validateAgent(agent, makeContext());

    const asyncCheck = result.checks.find((c) => c.name.includes('promises'));
    expect(asyncCheck?.passed).toBe(true);
  });
});

// ── validateCheckPlugin ──

describe('validateCheckPlugin', () => {
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'harness-plugin-'));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
  });

  async function writeScript(dir: string, name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    await chmod(p, 0o755);
    return p;
  }

  function makePluginManifest(overrides?: Partial<CheckPluginManifest>): CheckPluginManifest {
    return {
      name: 'test-check',
      description: 'Test check plugin',
      version: '1.0.0',
      targetKinds: ['generic'],
      verbs: ['health'],
      executable: './run.sh',
      ...overrides,
    };
  }

  it('passes for a well-behaved health plugin', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(
      dir,
      'run.sh',
      'echo \'{"status":"healthy","summary":"all good","confidence":0.95}\'',
    );

    const manifest = makePluginManifest();
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(2);
  });

  it('passes for a multi-verb plugin', async () => {
    const dir = await makeTmpDir();
    // Script that reads stdin and responds based on verb
    const script = await writeScript(
      dir,
      'run.sh',
      [
        'INPUT=$(cat)',
        'VERB=$(echo "$INPUT" | grep -o \'"verb":"[^"]*"\' | cut -d\'"\'  -f4)',
        'case "$VERB" in',
        '  health) echo \'{"status":"healthy","summary":"ok","confidence":0.9}\' ;;',
        '  diagnose) echo \'{"healthy":true,"summary":"no issues","findings":[]}\' ;;',
        '  plan) echo \'{"name":"noop","description":"nothing to do","steps":[]}\' ;;',
        'esac',
      ].join('\n'),
    );

    const manifest = makePluginManifest({ verbs: ['health', 'diagnose', 'plan'] });
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(true);
    // 1 manifest check + 3 verb checks
    expect(result.checks.length).toBe(4);
  });

  it('detects missing manifest fields', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'run.sh', 'echo "{}"');

    const badManifest = { description: 'no name' } as unknown as CheckPluginManifest;
    const result = await validateCheckPlugin(script, badManifest);

    expect(result.passed).toBe(false);
    const manifestCheck = result.checks.find((c) => c.name.includes('manifest'));
    expect(manifestCheck?.passed).toBe(false);
  });

  it('detects bad JSON output from a health verb', async () => {
    const dir = await makeTmpDir();
    const script = await writeScript(dir, 'run.sh', 'echo "NOT JSON"');

    const manifest = makePluginManifest();
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(false);
    const verbCheck = result.checks.find((c) => c.name.includes('health'));
    expect(verbCheck?.passed).toBe(false);
  });

  it('detects health output missing required fields', async () => {
    const dir = await makeTmpDir();
    // Missing confidence
    const script = await writeScript(
      dir,
      'run.sh',
      'echo \'{"status":"healthy","summary":"ok"}\'',
    );

    const manifest = makePluginManifest();
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(false);
    const verbCheck = result.checks.find((c) => c.name.includes('health'));
    expect(verbCheck?.passed).toBe(false);
    expect(verbCheck?.message).toContain('confidence');
  });

  it('detects diagnose output missing required fields', async () => {
    const dir = await makeTmpDir();
    // Missing healthy boolean
    const script = await writeScript(
      dir,
      'run.sh',
      'echo \'{"summary":"ok","findings":[]}\'',
    );

    const manifest = makePluginManifest({ verbs: ['diagnose'] });
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(false);
    const verbCheck = result.checks.find((c) => c.name.includes('diagnose'));
    expect(verbCheck?.passed).toBe(false);
    expect(verbCheck?.message).toContain('healthy');
  });

  it('detects plan output missing required fields', async () => {
    const dir = await makeTmpDir();
    // Missing steps array
    const script = await writeScript(
      dir,
      'run.sh',
      'echo \'{"name":"fix","description":"fix it"}\'',
    );

    const manifest = makePluginManifest({ verbs: ['plan'] });
    const result = await validateCheckPlugin(script, manifest);

    expect(result.passed).toBe(false);
    const verbCheck = result.checks.find((c) => c.name.includes('plan'));
    expect(verbCheck?.passed).toBe(false);
    expect(verbCheck?.message).toContain('steps');
  });
});
