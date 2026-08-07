// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { VectorStoreAgent } from '../agent/vector-store/agent.js';
import { VectorStoreSimulator } from '../agent/vector-store/simulator.js';
import { vectorStoreManifest } from '../agent/vector-store/manifest.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import type { AgentContext } from '../types/agent-context.js';
import type { VectorStoreScenario } from '../agent/vector-store/simulator.js';

function setup(scenario: VectorStoreScenario = 'healthy') {
  const backend = new VectorStoreSimulator();
  backend.transition(scenario);
  const agent = new VectorStoreAgent(backend, async () => null);
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'vector-storeScanCheck', instance: 'derived-vector-store', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, vectorStoreManifest) };
}

/**
 * Regression guard: validatePlan's checkScenario rejects any plan whose
 * metadata.scenario isn't listed in the manifest's failureScenarios. This
 * agent's plan() used to default an un-actionable diagnosis (scenario ===
 * null) to the literal string 'healthy', which is not a failure scenario and
 * was never declared in vectorStoreManifest.spec.failureScenarios — every
 * plan generated for a healthy target failed real validation despite every
 * other unit assertion (rollback strategy present, no mutations, unique step
 * ids) passing. Each of the five scenarios below is a case plan() can
 * actually produce: run it through the real validator, not a hand-built plan
 * or a string-list assertion against failureScenarios, so a future drift
 * between diagnose()'s scenario picker and the manifest fails here first.
 */
describe('VectorStoreAgent.plan — real validatePlan per scenario', () => {
  const scenarios: VectorStoreScenario[] = ['healthy', 'unreachable', 'bad_key', 'index_not_ready', 'no_indexes'];

  it.each(scenarios)('produces a plan that passes validatePlan for scenario %s', async (scenario) => {
    const { agent, context } = setup(scenario);
    const plan = await agent.plan(context, await agent.diagnose(context));

    const validation = validatePlan(plan, agent.manifest);
    const failures = validation.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`);
    expect(failures).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("defaults an un-actionable diagnosis to the declared 'no_finding' scenario, not 'healthy'", async () => {
    const { agent, context } = setup('healthy');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBeNull();

    const plan = await agent.plan(context, diagnosis);
    expect(plan.metadata.scenario).toBe('no_finding');
    expect(vectorStoreManifest.spec.failureScenarios).toContain('no_finding');
  });
});
