// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { playbookToPlan, interpolateVariables } from '../framework/playbook/runtime.js';
import type { ParsedPlaybook, PlaybookStep } from '../framework/playbook/types.js';

function makeStep(overrides: Partial<PlaybookStep> = {}): PlaybookStep {
  return {
    position: 1,
    title: 'Test step',
    type: 'diagnosis_action',
    body: 'Step body text',
    codeBlocks: [],
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<ParsedPlaybook> = {}): ParsedPlaybook {
  return {
    frontmatter: {
      name: 'test-playbook',
      version: '1.0.0',
      description: 'A test recovery playbook',
      agent: 'pg-replication',
      ...(overrides.frontmatter as object),
    },
    steps: overrides.steps ?? [makeStep()],
    rawMarkdown: '---\nname: test\n---',
    ...overrides,
  };
}

describe('playbookToPlan', () => {
  it('converts a playbook to a RecoveryPlan with correct metadata', () => {
    const playbook = makePlaybook();
    const plan = playbookToPlan(playbook);

    expect(plan.apiVersion).toBe('crisismode.dev/v1');
    expect(plan.kind).toBe('RecoveryPlan');
    expect(plan.metadata.planId).toMatch(/^test-playbook-/);
    expect(plan.metadata.agentName).toBe('pg-replication');
    expect(plan.metadata.scenario).toBe('A test recovery playbook');
    expect(plan.metadata.summary).toBe('A test recovery playbook');
    expect(plan.metadata.agentVersion).toBe('1.0.0');
  });

  it('converts a diagnosis_action step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'diagnosis_action',
          title: 'Check lag',
          executionContext: 'replica',
          target: 'replica-1',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('diagnosis_action');
    expect(step.stepId).toBe('test-playbook-step-1');
    expect(step.name).toBe('Check lag');
    if (step.type === 'diagnosis_action') {
      expect(step.executionContext).toBe('replica');
      expect(step.target).toBe('replica-1');
    }
  });

  it('converts a system_action step with blast_radius', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'system_action',
          position: 2,
          title: 'Restart service',
          risk: 'elevated',
          precondition: 'Service is running',
          success: 'Service restarted',
          blastRadius: { max_downtime_seconds: 60, max_affected_rows: 500 },
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('system_action');
    if (step.type === 'system_action') {
      expect(step.riskLevel).toBe('elevated');
      expect(step.blastRadius.maxImpact).toContain('60');
      expect(step.preConditions).toHaveLength(1);
      expect(step.preConditions![0].description).toBe('Service is running');
      expect(step.successCriteria.description).toBe('Service restarted');
    }
  });

  it('converts a human_notification step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'human_notification',
          title: 'Notify oncall',
          message: 'Database lag resolved',
          channel: 'pagerduty',
          risk: 'high',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('human_notification');
    if (step.type === 'human_notification') {
      expect(step.recipients[0].role).toBe('oncall');
      expect(step.recipients[0].urgency).toBe('high');
      expect(step.message.summary).toBe('Database lag resolved');
      expect(step.channel).toBe('pagerduty');
    }
  });

  it('converts a human_approval step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'human_approval',
          title: 'Approve failover',
          description: 'Manual approval required before failover',
          timeout: '10m',
          escalation: 'manager',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('human_approval');
    if (step.type === 'human_approval') {
      expect(step.approvers[0].role).toBe('oncall');
      expect(step.timeout).toBe('10m');
      expect(step.timeoutAction).toBe('escalate');
    }
  });

  it('converts a checkpoint step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'checkpoint',
          position: 3,
          title: 'Save state',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('checkpoint');
    if (step.type === 'checkpoint') {
      expect(step.stateCaptures).toHaveLength(1);
      expect(step.stateCaptures[0].name).toBe('checkpoint-3');
      expect(step.stateCaptures[0].captureType).toBe('command_output');
    }
  });

  it('converts a replanning_checkpoint step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'replanning_checkpoint',
          title: 'Re-evaluate',
          timeout: '120s',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('replanning_checkpoint');
    if (step.type === 'replanning_checkpoint') {
      expect(step.replanTimeout).toBe('120s');
    }
  });

  it('converts a conditional step', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'conditional',
          title: 'Check if lag is resolved',
          condition: 'Lag is below threshold',
          onSuccess: 'Lag resolved',
          onFailure: 'Lag still high',
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    expect(step.type).toBe('conditional');
    if (step.type === 'conditional') {
      expect(step.condition.description).toBe('Lag is below threshold');
      expect(step.thenStep).toBeDefined();
      if (step.thenStep && typeof step.thenStep !== 'string') {
        expect(step.thenStep.name).toBe('Lag resolved');
      }
      if (step.elseStep && typeof step.elseStep !== 'string') {
        expect(step.elseStep.name).toBe('Lag still high');
      }
    }
  });

  it('builds command from SQL code block', () => {
    const playbook = makePlaybook({
      steps: [
        makeStep({
          type: 'diagnosis_action',
          codeBlocks: [{ lang: 'sql', content: 'SELECT 1' }],
        }),
      ],
    });

    const plan = playbookToPlan(playbook);
    const step = plan.steps[0];

    if (step.type === 'diagnosis_action') {
      expect(step.command).toEqual({ type: 'sql', statement: 'SELECT 1' });
    }
  });

  it('uses rollback section for rollback strategy', () => {
    const playbook = makePlaybook({
      rollback: 'Restore from the checkpoint taken in step 2.',
    });

    const plan = playbookToPlan(playbook);

    expect(plan.rollbackStrategy.description).toBe(
      'Restore from the checkpoint taken in step 2.',
    );
  });
});

describe('interpolateVariables', () => {
  it('replaces tokens with context values', () => {
    const result = interpolateVariables('lag is {diagnosis.lag}', {
      diagnosis: { lag: 42 },
    });

    expect(result).toBe('lag is 42');
  });

  it('preserves unresolved tokens', () => {
    const result = interpolateVariables('host is {unknown.path}', {});

    expect(result).toBe('host is {unknown.path}');
  });
});
