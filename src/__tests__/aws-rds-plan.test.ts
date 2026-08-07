// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { AwsRdsRecoveryAgent } from '../agent/aws-rds/agent.js';
import { RdsRecoverySimulator } from '../agent/aws-rds/simulator.js';
import type { SimulatorState } from '../agent/aws-rds/simulator.js';
import { awsRdsRecoveryManifest } from '../agent/aws-rds/manifest.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import type { AgentContext } from '../types/agent-context.js';

function setup(state: SimulatorState) {
  const backend = new RdsRecoverySimulator();
  backend.transition(state);
  const agent = new AwsRdsRecoveryAgent(backend);
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'aws-rdsScanCheck', instance: 'prod-db-01', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, awsRdsRecoveryManifest) };
}

/**
 * Regression guard: validatePlan's checkScenario rejects any plan whose
 * metadata.scenario isn't listed in the manifest's failureScenarios, and
 * checkManifestCapabilities/checkStepCapabilities reject any manifest or
 * step capability the CapabilityRegistry doesn't know. Before this fix,
 * every one of RdsRecoverySimulator's ten states — which collapse to these
 * seven distinct diagnose()-selected scenarios — produced a plan that
 * failed real validatePlan: the control-plane scenarios plan() emits
 * (storage_full, connection_saturation, sg_blocked, instance_unavailable)
 * and the neutral 'healthy' outcome were never declared in the manifest's
 * failureScenarios, and the rds.* capabilities referenced by the manifest's
 * execution contexts and the retention-increase system_action step were
 * never registered in the CapabilityRegistry — so `crisismode recover`
 * dead-ended at "Plan validation failed" for every aws-rds scenario.
 */
describe('AwsRdsRecoveryAgent.plan — real validatePlan per simulator scenario', () => {
  const cases: Array<{ state: SimulatorState; scenario: string }> = [
    { state: 'degraded', scenario: 'backup_disabled' },
    { state: 'recovering', scenario: 'missing_backup' },
    { state: 'healthy', scenario: 'healthy' },
    { state: 'storage_full', scenario: 'storage_full' },
    { state: 'connection_saturation', scenario: 'connection_saturation' },
    { state: 'sg_blocked', scenario: 'sg_blocked' },
    { state: 'instance_stopped', scenario: 'instance_unavailable' },
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
