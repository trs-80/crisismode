// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { ServiceStatusAgent } from '../agent/service-status/agent.js';
import { ServiceStatusSimulator } from '../agent/service-status/simulator.js';
import type { ServiceStatusScenario } from '../agent/service-status/simulator.js';
import { serviceStatusManifest } from '../agent/service-status/manifest.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import type { AgentContext } from '../types/agent-context.js';

function setup(state: ServiceStatusScenario) {
  const backend = new ServiceStatusSimulator();
  backend.transition(state);
  const agent = new ServiceStatusAgent(backend);
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'service-statusScanCheck', instance: 'stripe', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, serviceStatusManifest) };
}

/**
 * Pinned rule: every scenario ServiceStatusAgent.plan() can emit must produce
 * a plan that passes the real validatePlan, and the neutral healthy outcome
 * must be a true no-op (no steps) — this agent never mutates a third-party
 * provider, so it has nothing to suggest beyond notifying a human.
 */
describe('ServiceStatusAgent.plan — real validatePlan per simulator scenario', () => {
  const cases: Array<{ state: ServiceStatusScenario; scenario: string }> = [
    { state: 'incident', scenario: 'dependency_incident' },
    { state: 'degraded', scenario: 'dependency_degraded' },
    { state: 'down_for_you', scenario: 'dependency_unreachable' },
    { state: 'status_unavailable', scenario: 'dependency_unreachable' },
    { state: 'healthy', scenario: 'no_finding' },
  ];

  it.each(cases)(
    'produces a plan that passes validatePlan for simulator state $state (scenario $scenario)',
    async ({ state, scenario }) => {
      const { agent, context } = setup(state);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);

      expect(plan.metadata.scenario).toBe(scenario);

      const validation = validatePlan(plan, agent.manifest);
      const failures = validation.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`);
      expect(failures).toEqual([]);
      expect(validation.valid).toBe(true);
    },
  );

  it('builds a true no-op plan (steps: []) when the checked service is healthy — following the aws-dynamodb shape, not vector-store\'s', async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBeNull();

    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps).toEqual([]);
    expect(plan.metadata.scenario).toBe('no_finding');
    expect(plan.rollbackStrategy).toBeTruthy();
    expect(plan.rollbackStrategy.description.length).toBeGreaterThan(0);
  });

  it('never emits a system_action step for a non-healthy scenario — suggestion only, per the spec\'s escalation model', async () => {
    for (const state of ['incident', 'degraded', 'down_for_you', 'status_unavailable'] as const) {
      const { agent, context } = setup(state);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.every((s) => s.type !== 'system_action')).toBe(true);
    }
  });

  it('never sets message.guideIds on the notification step — Task 8 has not registered the guide yet', async () => {
    for (const state of ['incident', 'degraded', 'down_for_you', 'status_unavailable'] as const) {
      const { agent, context } = setup(state);
      const diagnosis = await agent.diagnose(context);
      const plan = await agent.plan(context, diagnosis);
      for (const step of plan.steps) {
        if (step.type === 'human_notification') {
          expect(step.message.guideIds).toBeUndefined();
        }
      }
    }
  });
});
