// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, setOutputOptions, printScanSummary, printDiagnosis, printPlan } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import { renderReadinessReport } from '../cli/commands/readiness.js';
import { attachGuidesByRuleId } from '../framework/guidance/attach.js';
import type { ReadinessReport } from '../readiness/types.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import { checkTargetHealth } from '../cli/commands/scan.js';
import type { HealthCheckRegistry } from '../cli/commands/scan.js';
import type { TargetConfig } from '../config/schema.js';

function scanResultWithKeyFinding(): ScanResult {
  return {
    score: 40,
    findings: [{
      id: 'LLM-001',
      service: 'llm-provider (anthropic)',
      status: 'unhealthy',
      summary: 'Anthropic API key is not valid',
      confidence: 0.95,
      escalationLevel: 2,
      checkId: 'llm-provider.key_valid',
      guidancePlatforms: ['anthropic-console'],
      signals: [{ status: 'critical', detail: '401 authentication_error', source: 'llm_key_valid' }],
    }],
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 120,
  };
}

describe('scan output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('human mode renders the numbered guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key');
    expect(text).toContain('1. Open the Anthropic Console');
    expect(text).toContain('https://console.anthropic.com/settings/keys');
    expect(text).toContain('(path verified 2026-08-05)');
  });

  it('--terse collapses the guide to title and URL', () => {
    configure({ mode: 'human', noColor: true });
    setOutputOptions({ terse: true });
    printScanSummary(scanResultWithKeyFinding());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Rotate your Anthropic API key — https://console.anthropic.com/settings/keys');
    expect(text).not.toContain('1. Open the Anthropic Console');
  });

  it('pipe mode adds a guide:<id> reference column instead of the block', () => {
    configure({ mode: 'pipe', noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const fields = lines.find((l: string) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    // Scoped to anthropic-console, so the OpenAI rotate-key guide must not appear.
    expect(fields[6]).toBe('guide:anthropic-rotate-key');
    expect(lines.join('\n')).not.toContain('How to fix it');
  });

  it('pipe mode keeps the column present but empty when a finding has no guides', () => {
    configure({ mode: 'pipe', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    const fields = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.startsWith('finding\t'))!.split('\t');
    expect(fields).toHaveLength(7);
    expect(fields[6]).toBe('');
  });

  it('machine mode emits full guide objects under guides', () => {
    configure({ json: true, noColor: true });
    printScanSummary(scanResultWithKeyFinding());
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.type).toBe('scan');
    const guide = parsed.findings[0].guides[0];
    expect(guide.id).toBe('anthropic-rotate-key');
    expect(guide.consoleSteps.length).toBeGreaterThan(1);
    expect(guide.verifiedOn).toBe('2026-08-05');
  });

  it('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const result: ScanResult = {
      score: 55,
      findings: [{
        id: 'RDS-001',
        service: 'aws-rds (prod-db-01)',
        status: 'unhealthy',
        summary: 'RDS storage is full on instance prod-db-01',
        confidence: 0.95,
        escalationLevel: 2,
        guidancePlatforms: ['aws-rds'],
        signals: [{
          status: 'critical',
          detail: 'allocated storage exhausted',
          source: 'rds_storage',
          checkId: 'aws-rds.storage_full',
          guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
        }],
      }],
      recentChanges: [],
      scannedAt: '2026-08-05T12:00:00.000Z',
      durationMs: 90,
    };
    printScanSummary(result);
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });

  it('a finding with no matching checkId renders no guidance', () => {
    configure({ mode: 'human', noColor: true });
    const result = scanResultWithKeyFinding();
    result.findings[0]!.checkId = 'nothing.matches';
    printScanSummary(result);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain('How to fix it');
  });
});

// Regression for the platformsForTarget scoping bug found in Task 11:
// autodiscovery.ts derives real llm-provider targets as
// `llm-provider.<provider>` (never the bare 'llm-provider' kind). This drives
// the real scan.ts wiring (checkTargetHealth) with those realistic kinds,
// through to the rendered scan summary, to prove platform scoping actually
// filters out the competing vendor's guide end to end — not just at the
// platformsForTarget/guidesForFindingTypes unit level.
describe('scan output — guidance scoping for real llm-provider.<provider> kinds', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  function keyInvalidRegistry(): HealthCheckRegistry {
    return {
      supportedKinds: () => ['llm-provider.anthropic', 'llm-provider.google'],
      createForTarget: () => Promise.resolve({
        agent: {
          manifest: { name: 'llm-provider', version: '1.0.0', spec: { executionContexts: [] } },
          assessHealth: () => Promise.resolve({
            status: 'unhealthy',
            confidence: 0.9,
            summary: 'API key is not valid',
            observedAt: new Date().toISOString(),
            signals: [{ status: 'critical', detail: '401 authentication_error', source: 'llm_key_valid', checkId: 'llm-provider.key_valid' }],
          }),
        },
        backend: { close: () => Promise.resolve() },
      } as never),
    };
  }

  it('an Anthropic target renders the Anthropic guide but never the OpenAI one', async () => {
    const target: TargetConfig = { name: 'derived-llm-anthropic', kind: 'llm-provider.anthropic' };
    const result = await checkTargetHealth(target, keyInvalidRegistry());
    configure({ mode: 'human', noColor: true });
    printScanSummary({
      score: 40,
      findings: [{ id: 'LLM-001', ...result.finding }],
      recentChanges: [],
      scannedAt: '2026-08-05T12:00:00.000Z',
      durationMs: 1,
    });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('Rotate your Anthropic API key');
    expect(text).not.toContain('OpenAI');
  });

  it('a Google target renders no guidance at all — never another vendor\'s console', async () => {
    const target: TargetConfig = { name: 'derived-llm-google', kind: 'llm-provider.google' };
    const result = await checkTargetHealth(target, keyInvalidRegistry());
    configure({ mode: 'human', noColor: true });
    printScanSummary({
      score: 40,
      findings: [{ id: 'LLM-002', ...result.finding }],
      recentChanges: [],
      scannedAt: '2026-08-05T12:00:00.000Z',
      durationMs: 1,
    });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).not.toContain('How to fix it');
  });
});

describe('diagnose output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
  });

  const diagnosis: DiagnosisResult = {
    status: 'identified',
    scenario: 'quota_exhausted',
    confidence: 0.9,
    findings: [{
      source: 'llm_provider_quota',
      observation: 'Anthropic credit balance is exhausted',
      severity: 'critical',
      checkId: 'llm-provider.quota_billing',
    }],
    diagnosticPlanNeeded: false,
  };

  it('human mode renders the guide under the finding', () => {
    configure({ mode: 'human', noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Restore Anthropic billing or credit balance');
    expect(text).not.toContain('OpenAI');
  });

  it('machine mode carries guides on the finding', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis, undefined, { platforms: ['anthropic-console'] });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.diagnosis.findings[0].guides.map((g: { id: string }) => g.id)).toEqual(['anthropic-billing-credits']);
  });

  it('without a scope, every platform that answers the check is offered', () => {
    configure({ json: true, noColor: true });
    printDiagnosis(diagnosis);
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    const platforms = parsed.diagnosis.findings[0].guides.map((g: { platform: string }) => g.platform);
    expect(new Set(platforms)).toEqual(new Set(['anthropic-console', 'openai-platform']));
  });

  it('resolves aws-rds guide placeholders to concrete target values, not literal tokens', () => {
    configure({ mode: 'human', noColor: true });
    const rdsDiagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'storage_full',
      confidence: 0.9,
      findings: [{
        source: 'rds_storage',
        observation: 'RDS storage is full on instance prod-db-01',
        severity: 'critical',
        checkId: 'aws-rds.storage_full',
        guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
      }],
      diagnosticPlanNeeded: false,
    };
    printDiagnosis(rdsDiagnosis, undefined, { platforms: ['aws-rds'] });
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('prod-db-01');
    expect(text).toContain('40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });
});

describe('readiness output — guidance', () => {
  const report: ReadinessReport = {
    verdict: 'at-risk',
    score: 60,
    evaluated: 1,
    unknown: 0,
    findings: [{
      ruleId: 'serverless-pooling',
      title: 'Serverless connection pooling',
      status: 'at_risk',
      evidence: ['DATABASE_URL points at port 5432 (direct connection)'],
      explanation: 'Each serverless invocation opens its own connection; the database runs out long before traffic does.',
      fix: 'Route serverless traffic through a transaction pooler.',
      learnMoreUrl: 'https://vercel.com/guides/connection-pooling-with-serverless-functions',
    }],
  };

  it('renders the matching platform guides under an at-risk finding', () => {
    const lines = renderReadinessReport(report).join('\n');
    expect(lines).toContain('How to fix it: Use the Supabase transaction pooler for serverless functions');
    expect(lines).toContain('How to fix it: Switch Neon to the pooled connection endpoint');
    expect(lines).toContain('(path verified 2026-08-05)');
  });

  it('collapses guides to title and URL when terse', () => {
    const lines = renderReadinessReport(report, { terse: true }).join('\n');
    expect(lines).toContain('How to fix it: Use the Supabase transaction pooler for serverless functions — https://supabase.com/dashboard/project/_/settings/database');
    expect(lines).not.toContain('1. Open the Supabase dashboard');
  });

  it('renders no guidance for a ready finding', () => {
    const ready: ReadinessReport = {
      ...report,
      findings: [{ ...report.findings[0]!, status: 'ready' }],
    };
    expect(renderReadinessReport(ready).join('\n')).not.toContain('How to fix it');
  });

  it('renders no guidance for a rule with no guides', () => {
    const other: ReadinessReport = {
      ...report,
      findings: [{ ...report.findings[0]!, ruleId: 'long-transactions' }],
    };
    expect(renderReadinessReport(other).join('\n')).not.toContain('How to fix it');
  });

  it('attaches full guide objects for --json consumers', () => {
    const attached = { ...report, findings: report.findings.map((f) => attachGuidesByRuleId(f)) };
    expect(attached.findings[0]!.guides?.map((g) => g.id)).toEqual(['supabase-pooler-mode', 'neon-pooled-connection']);
    expect(attached.findings[0]!.guides?.[0]?.consoleSteps.length).toBeGreaterThan(1);
  });
});

function planWithGuidedSuggestion(): RecoveryPlan {
  return {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'plan-aws-rds-control-plane',
      agentName: 'aws-rds-recovery',
      agentVersion: '1.0.0',
      scenario: 'storage_full',
      createdAt: '2026-08-05T12:00:00.000Z',
      estimatedDuration: 'PT5M',
      summary: 'Suggested remediation for RDS instance prod-db-01.',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: ['database-availability'],
      estimatedUserImpact: 'No user-facing impact.',
      dataLossRisk: 'none',
    },
    steps: [{
      stepId: 'step-002',
      type: 'human_notification',
      name: 'Increase allocated storage on RDS instance prod-db-01',
      recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
      message: {
        summary: 'Increase allocated storage on RDS instance prod-db-01',
        detail: 'RDS storage is full on instance prod-db-01.',
        actionRequired: true,
        guideIds: ['aws-rds-increase-storage'],
        guideVars: { instance: 'prod-db-01', 'target-storage-gb': '40' },
      },
      channel: 'auto',
    }],
    rollbackStrategy: { type: 'none', description: 'No mutations were performed by this plan.' },
  };
}

describe('recover output — guidance', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false, mode: 'human' });
    setOutputOptions({ terse: false });
  });

  it('renders the guide for a suggestion step, resolved with its guideVars', () => {
    configure({ mode: 'human', noColor: true });
    printPlan(planWithGuidedSuggestion());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Increase allocated storage on RDS instance prod-db-01');
    expect(text).toContain('Modify → Allocated storage and raise it to 40 GiB');
    expect(text).not.toContain('<instance>');
    expect(text).not.toContain('<target-storage-gb>');
  });

  it('renders from the registry, not from message.detail prose', () => {
    configure({ mode: 'human', noColor: true });
    const plan = planWithGuidedSuggestion();
    const step = plan.steps[0]!;
    if (step.type === 'human_notification') step.message.detail = '';
    printPlan(plan);
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('aws rds modify-db-instance');
  });

  it('collapses to title and URL when terse', () => {
    configure({ mode: 'human', noColor: true });
    setOutputOptions({ terse: true });
    printPlan(planWithGuidedSuggestion());
    const text = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(text).toContain('How to fix it: Increase allocated storage on RDS instance prod-db-01 — https://console.aws.amazon.com/rds/');
    expect(text).not.toContain('Modify → Allocated storage and raise it');
  });

  it('machine mode prints the plan as JSON with guideIds intact and no rendered block', () => {
    configure({ json: true, noColor: true });
    printPlan(planWithGuidedSuggestion());
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.plan.steps[0].message.guideIds).toEqual(['aws-rds-increase-storage']);
    expect(logSpy.mock.calls).toHaveLength(1);
  });

  it('a plan step with no guideIds renders no guidance', () => {
    configure({ mode: 'human', noColor: true });
    const plan = planWithGuidedSuggestion();
    if (plan.steps[0]!.type === 'human_notification') delete plan.steps[0]!.message.guideIds;
    printPlan(plan);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain('How to fix it');
  });
});
