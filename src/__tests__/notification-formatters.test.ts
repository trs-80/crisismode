// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  formatSlackNotification,
  formatGitHubIssue,
  formatMarkdownNotification,
  generatePostmortemDraft,
} from '../framework/notification-formatters.js';
import type { NotificationContext } from '../framework/notification-formatters.js';
import type { HealthAssessment, OperatorSummary } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { HealthCard } from '../framework/watch-state.js';

// ── Helpers ──

function makeHealth(status: 'healthy' | 'unhealthy' | 'recovering' = 'unhealthy'): HealthAssessment {
  return {
    status,
    confidence: 0.87,
    summary: 'PostgreSQL replication lag exceeds threshold',
    observedAt: '2026-03-17T12:00:00.000Z',
    signals: [
      { source: 'replication', status: 'critical', detail: 'Lag: 45s on replica-1', observedAt: '2026-03-17T12:00:00.000Z' },
      { source: 'connections', status: 'warning', detail: 'Connection pool at 85%', observedAt: '2026-03-17T12:00:00.000Z' },
    ],
    recommendedActions: ['Check replication status', 'Monitor connection pool'],
  };
}

function makeDiagnosis(): DiagnosisResult {
  return {
    status: 'identified',
    scenario: 'replication_lag',
    confidence: 0.92,
    findings: [
      { source: 'pg_stat_replication', observation: 'Replica replay lag at 45 seconds', severity: 'critical' },
      { source: 'pg_stat_activity', observation: 'Long-running query blocking WAL apply', severity: 'warning' },
    ],
    diagnosticPlanNeeded: false,
  };
}

function makePlan(): RecoveryPlan {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'plan-repl-001',
      agentName: 'pg-replication',
      agentVersion: '1.0.0',
      scenario: 'replication_lag',
      createdAt: '2026-03-17T12:01:00.000Z',
      estimatedDuration: 'PT5M',
      summary: 'Cancel blocking query and verify replication catch-up',
      supersedes: null,
    },
    impact: {
      affectedSystems: [{ identifier: 'pg-replica-1', technology: 'postgresql', role: 'replica', impactType: 'read-latency' }],
      affectedServices: ['api-service', 'reporting'],
      estimatedUserImpact: 'Read queries may be stale for up to 60 seconds',
      dataLossRisk: 'none',
    },
    steps: [
      { stepId: 'diag-1', type: 'diagnosis_action' as const, name: 'Check current lag', executionContext: 'primary', target: 'pg', command: { type: 'sql' as const, statement: 'SELECT pg_wal_lsn_diff(...)' }, timeout: 'PT30S' },
      { stepId: 'action-1', type: 'system_action' as const, name: 'Cancel blocking query', executionContext: 'primary', target: 'pg', command: { type: 'sql' as const, statement: 'SELECT pg_cancel_backend(...)' }, riskLevel: 'elevated' as const, requiredCapabilities: ['db.query.write'], timeout: 'PT30S', statePreservation: { before: [], after: [] }, successCriteria: { description: 'Query cancelled', check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq' as const, value: '1' } } }, blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'single-query', cascadeRisk: 'none' as const } },
    ],
    rollbackStrategy: { type: 'stepwise' as const, description: 'Each step has individual rollback' },
  };
}

function makeOperatorSummary(): OperatorSummary {
  return {
    currentState: 'unhealthy',
    confidence: 0.87,
    summary: 'Replication lag detected',
    actionRequired: 'investigate',
    automationStatus: 'no_mutations_performed',
    executeReadiness: 'ready',
    mutationsPerformed: false,
    recommendedNextStep: 'Run `crisismode recover --target pg-primary`',
    recommendedActions: ['Monitor replication lag', 'Check blocking queries'],
    evidence: [],
    validationBlockers: [],
    observedAt: '2026-03-17T12:00:00.000Z',
  };
}

function makeHealthCard(): HealthCard {
  return {
    target: 'pg-primary',
    currentStatus: 'unhealthy',
    currentConfidence: 0.87,
    uptimePercent: 94.5,
    avgConfidence: 0.91,
    totalCycles: 200,
    transitionCount: 3,
    proposalCount: 1,
    patterns: [],
    lastChecked: '2026-03-17T12:00:00.000Z',
    watchingSince: '2026-03-17T06:00:00.000Z',
  };
}

function fullContext(): NotificationContext {
  return {
    health: makeHealth(),
    diagnosis: makeDiagnosis(),
    plan: makePlan(),
    operatorSummary: makeOperatorSummary(),
    healthCard: makeHealthCard(),
  };
}

// ── Slack Formatter Tests ──

describe('formatSlackNotification', () => {
  it('produces blocks with header and health summary', () => {
    const result = formatSlackNotification({ health: makeHealth() });
    expect(result.text).toContain('Unhealthy');
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);

    const header = result.blocks.find((b) => b.type === 'header');
    expect(header).toBeDefined();
    expect(header!.text!.text).toContain('Unhealthy');
  });

  it('includes signals section', () => {
    const result = formatSlackNotification({ health: makeHealth() });
    const signalBlock = result.blocks.find(
      (b) => b.type === 'section' && b.text?.text?.includes('Signals'),
    );
    expect(signalBlock).toBeDefined();
    expect(signalBlock!.text!.text).toContain('replication');
  });

  it('includes diagnosis fields when provided', () => {
    const result = formatSlackNotification({ health: makeHealth(), diagnosis: makeDiagnosis() });
    const diagBlock = result.blocks.find((b) => b.fields?.some((f) => f.text.includes('Scenario')));
    expect(diagBlock).toBeDefined();
  });

  it('includes approval buttons when plan is provided', () => {
    const ctx = fullContext();
    const result = formatSlackNotification(ctx);
    const actionsBlock = result.blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock!.elements!.length).toBe(3);
    expect(actionsBlock!.elements![0].action_id).toBe('crisismode_approve');
    expect(actionsBlock!.elements![1].action_id).toBe('crisismode_reject');
    expect(actionsBlock!.elements![2].action_id).toBe('crisismode_details');
  });

  it('includes health card context when provided', () => {
    const ctx = fullContext();
    const result = formatSlackNotification(ctx);
    const contextBlock = result.blocks.find((b) => b.type === 'context');
    expect(contextBlock).toBeDefined();
    const mrkdwn = contextBlock!.elements![0] as unknown as { type: string; text: string };
    expect(mrkdwn.text).toContain('94.5%');
    expect(mrkdwn.text).toContain('200');
  });

  it('handles healthy status with correct emoji', () => {
    const result = formatSlackNotification({ health: makeHealth('healthy') });
    const header = result.blocks.find((b) => b.type === 'header');
    expect(header!.text!.text).toContain('Healthy');
  });

  it('handles recovering status', () => {
    const result = formatSlackNotification({ health: makeHealth('recovering') });
    expect(result.text).toContain('Recovering');
  });

  it('includes recommended next step when operator summary provided', () => {
    const ctx = fullContext();
    const result = formatSlackNotification(ctx);
    const nextStep = result.blocks.find(
      (b) => b.type === 'section' && b.text?.text?.includes('Next step'),
    );
    expect(nextStep).toBeDefined();
  });

  it('limits signals to 5', () => {
    const health = makeHealth();
    health.signals = Array.from({ length: 10 }, (_, i) => ({
      source: `probe-${i}`,
      status: 'warning' as const,
      detail: `Signal ${i}`,
      observedAt: '2026-03-17T12:00:00.000Z',
    }));

    const result = formatSlackNotification({ health });
    const signalBlock = result.blocks.find(
      (b) => b.type === 'section' && b.text?.text?.includes('Signals'),
    );
    // Should only have 5 signals listed
    const signalLines = signalBlock!.text!.text.split('\n').filter((l) => l.includes('probe-'));
    expect(signalLines.length).toBe(5);
  });
});

// ── GitHub Issue Formatter Tests ──

describe('formatGitHubIssue', () => {
  it('generates title with scenario', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.title).toContain('CrisisMode');
    expect(result.title).toContain('replication lag');
  });

  it('generates title from summary when no diagnosis', () => {
    const result = formatGitHubIssue({ health: makeHealth() });
    expect(result.title).toContain('PostgreSQL replication lag');
  });

  it('includes health status labels', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.labels).toContain('crisismode');
    expect(result.labels).toContain('health:unhealthy');
    expect(result.labels).toContain('scenario:replication_lag');
  });

  it('includes health assessment section in body', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.body).toContain('## Health Assessment');
    expect(result.body).toContain('87%');
    expect(result.body).toContain('Unhealthy');
  });

  it('includes signals table', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.body).toContain('| Status | Source | Detail |');
    expect(result.body).toContain('replication');
  });

  it('includes diagnosis section', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.body).toContain('## Diagnosis');
    expect(result.body).toContain('Replication Lag');
  });

  it('includes recovery plan steps table', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.body).toContain('### Steps');
    expect(result.body).toContain('Check current lag');
    expect(result.body).toContain('Cancel blocking query');
  });

  it('includes recommended actions', () => {
    const ctx = fullContext();
    const result = formatGitHubIssue(ctx);
    expect(result.body).toContain('## Recommended Actions');
    expect(result.body).toContain('Monitor replication lag');
  });

  it('includes CrisisMode footer', () => {
    const result = formatGitHubIssue({ health: makeHealth() });
    expect(result.body).toContain('Generated by [CrisisMode]');
  });

  it('works with minimal context (health only)', () => {
    const result = formatGitHubIssue({ health: makeHealth() });
    expect(result.title).toBeDefined();
    expect(result.body).toContain('## Health Assessment');
    expect(result.body).not.toContain('## Diagnosis');
    expect(result.labels).toEqual(['crisismode', 'health:unhealthy']);
  });
});

// ── Markdown Formatter Tests ──

describe('formatMarkdownNotification', () => {
  it('produces markdown with health status header', () => {
    const result = formatMarkdownNotification({ health: makeHealth() });
    expect(result).toContain('# CrisisMode Alert: Unhealthy');
    expect(result).toContain('87%');
  });

  it('includes signals section', () => {
    const result = formatMarkdownNotification({ health: makeHealth() });
    expect(result).toContain('## Signals');
    expect(result).toContain('replication');
  });

  it('includes diagnosis section', () => {
    const ctx = fullContext();
    const result = formatMarkdownNotification(ctx);
    expect(result).toContain('## Diagnosis');
    expect(result).toContain('Replication Lag');
  });

  it('includes recovery plan section', () => {
    const ctx = fullContext();
    const result = formatMarkdownNotification(ctx);
    expect(result).toContain('## Recovery Plan');
    expect(result).toContain('Check current lag');
  });

  it('includes watch status when health card provided', () => {
    const ctx = fullContext();
    const result = formatMarkdownNotification(ctx);
    expect(result).toContain('## Watch Status');
    expect(result).toContain('94.5%');
    expect(result).toContain('200');
  });

  it('includes recommended actions', () => {
    const ctx = fullContext();
    const result = formatMarkdownNotification(ctx);
    expect(result).toContain('## Recommended Actions');
  });

  it('works with minimal context', () => {
    const result = formatMarkdownNotification({ health: makeHealth('healthy') });
    expect(result).toContain('# CrisisMode Alert: Healthy');
    expect(result).not.toContain('## Diagnosis');
  });
});

// ── Postmortem Generator Tests ──

describe('generatePostmortemDraft', () => {
  it('generates postmortem title with scenario and date', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    expect(result.title).toContain('Postmortem');
    expect(result.title).toContain('Replication Lag');
    expect(result.title).toContain('2026-03-17');
  });

  it('includes incident summary section', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const summary = result.sections.find((s) => s.heading === 'Incident Summary');
    expect(summary).toBeDefined();
    expect(summary!.content).toContain('unhealthy');
    expect(summary!.content).toContain('87%');
  });

  it('includes timeline section with TODO placeholders', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const timeline = result.sections.find((s) => s.heading === 'Timeline');
    expect(timeline).toBeDefined();
    expect(timeline!.content).toContain('Health degradation detected');
    expect(timeline!.content).toContain('[TODO]');
  });

  it('includes impact section from plan', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const impact = result.sections.find((s) => s.heading === 'Impact');
    expect(impact).toBeDefined();
    expect(impact!.content).toContain('Read queries may be stale');
    expect(impact!.content).toContain('api-service');
  });

  it('includes impact section with TODOs when no plan', () => {
    const result = generatePostmortemDraft({ health: makeHealth() });
    const impact = result.sections.find((s) => s.heading === 'Impact');
    expect(impact!.content).toContain('[TODO');
  });

  it('includes root cause section with findings', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const rca = result.sections.find((s) => s.heading === 'Root Cause');
    expect(rca).toBeDefined();
    expect(rca!.content).toContain('Replica replay lag at 45 seconds');
  });

  it('includes resolution section with plan steps', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const resolution = result.sections.find((s) => s.heading === 'Resolution');
    expect(resolution).toBeDefined();
    expect(resolution!.content).toContain('Cancel blocking query');
  });

  it('includes action items table', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const actions = result.sections.find((s) => s.heading === 'Action Items');
    expect(actions).toBeDefined();
    expect(actions!.content).toContain('Priority');
    expect(actions!.content).toContain('P1');
  });

  it('includes lessons learned section', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    const lessons = result.sections.find((s) => s.heading === 'Lessons Learned');
    expect(lessons).toBeDefined();
    expect(lessons!.content).toContain('CrisisMode detected the issue');
  });

  it('generates valid markdown document', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    expect(result.markdown).toContain(`# ${result.title}`);
    expect(result.markdown).toContain('Generated by [CrisisMode]');
    expect(result.markdown).toContain('[TODO]');
  });

  it('works with minimal context (health only)', () => {
    const result = generatePostmortemDraft({ health: makeHealth() });
    expect(result.title).toContain('Unknown Incident');
    expect(result.sections.length).toBeGreaterThanOrEqual(5);
  });

  it('has correct section count', () => {
    const ctx = fullContext();
    const result = generatePostmortemDraft(ctx);
    expect(result.sections).toHaveLength(7);
  });
});
