// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { AwsDynamoDbRecoveryAgent } from '../agent/aws-dynamodb/agent.js';
import { DynamoDbRecoverySimulator } from '../agent/aws-dynamodb/simulator.js';
import type { SimulatorState } from '../agent/aws-dynamodb/simulator.js';
import { awsDynamoDbRecoveryManifest } from '../agent/aws-dynamodb/manifest.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import type { AgentContext } from '../types/agent-context.js';

function setup(state: SimulatorState) {
  const backend = new DynamoDbRecoverySimulator();
  backend.transition(state);
  const agent = new AwsDynamoDbRecoveryAgent(backend);
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'aws-dynamodbScanCheck', table: 'orders-production', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, awsDynamoDbRecoveryManifest) };
}

/**
 * Regression guard: validatePlan's checkScenario rejects any plan whose
 * metadata.scenario isn't listed in the manifest's failureScenarios. Before
 * this fix, plan()'s healthy no-op branch stamped the plan envelope with the
 * literal 'healthy' scenario, which is not declared in the manifest's
 * failureScenarios (only pitr_disabled and backup_disabled are) — so every
 * healthy-table plan failed real validatePlan despite doing nothing.
 */
describe('AwsDynamoDbRecoveryAgent.plan — real validatePlan per simulator scenario', () => {
  const cases: Array<{ state: SimulatorState; scenario: string }> = [
    { state: 'degraded', scenario: 'pitr_disabled' },
    { state: 'recovered', scenario: 'no_finding' },
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
});
