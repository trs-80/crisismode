// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { assembleContext } from '../framework/context.js';
import { validateAgent } from '../framework/agent-test-harness.js';
import type { AgentContext } from '../types/agent-context.js';
import type { LlmProviderScenario } from '../agent/llm-provider/simulator.js';

function setup(scenario: LlmProviderScenario = 'bad_key') {
  const agent = new LlmProviderDiagnosisAgent(new LlmProviderSimulator(scenario), async () => null);
  const trigger: AgentContext['trigger'] = {
    type: 'manual',
    source: 'cli',
    payload: { instance: 'derived-llm-anthropic', severity: 'warning' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, agent.manifest) };
}

describe('LlmProviderDiagnosisAgent.plan', () => {
  it('produces a valid plan with unique step ids and a rollback strategy', async () => {
    const { agent, context } = setup();
    const plan = await agent.plan(context, await agent.diagnose(context));

    expect(plan.kind).toBe('RecoveryPlan');
    expect(plan.metadata.agentName).toBe('llm-provider-diagnosis');
    expect(plan.rollbackStrategy).toBeDefined();
    const ids = plan.steps.map((s) => s.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never proposes a mutating step — this agent only suggests', async () => {
    const { agent, context } = setup();
    const plan = await agent.plan(context, await agent.diagnose(context));
    expect(plan.steps.some((s) => s.type === 'system_action')).toBe(false);
    expect(plan.impact.dataLossRisk).toBe('none');
  });

  it('puts the fix direction for the diagnosed scenario in the notification', async () => {
    const { agent, context } = setup('quota_exhausted');
    const plan = await agent.plan(context, await agent.diagnose(context));
    const notification = plan.steps.find((s) => s.type === 'human_notification')!;
    expect(JSON.stringify(notification)).toMatch(/billing|credit/i);
  });

  it('does not invent an incident when the diagnosis found nothing', async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBeNull();

    const plan = await agent.plan(context, diagnosis);
    expect(plan.metadata.scenario).toBe('no_finding');

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toMatch(/incident/i);
    expect(serialized).not.toMatch(/status page/i);
    expect(plan.steps.find((s) => s.type === 'human_notification')!.message.actionRequired).toBe(false);
    expect(plan.metadata.summary).toMatch(/no actionable/i);
  });

  it('passes the generic agent contract harness', async () => {
    const { agent, context } = setup();
    const result = await validateAgent(agent, context);
    const failures = result.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`);
    expect(failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
