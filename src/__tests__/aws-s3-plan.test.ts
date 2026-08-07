// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { AwsS3RecoveryAgent } from '../agent/aws-s3/agent.js';
import { S3RecoverySimulator } from '../agent/aws-s3/simulator.js';
import type { SimulatorState } from '../agent/aws-s3/simulator.js';
import { awsS3RecoveryManifest } from '../agent/aws-s3/manifest.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import type { AgentContext } from '../types/agent-context.js';

function setup(state: SimulatorState) {
  const backend = new S3RecoverySimulator();
  backend.transition(state);
  const agent = new AwsS3RecoveryAgent(backend);
  const trigger: AgentContext['trigger'] = {
    type: 'health_check',
    source: 'cli-scan',
    payload: { alertname: 'aws-s3ScanCheck', bucket: 'prod-backup-bucket', severity: 'info' },
    receivedAt: new Date().toISOString(),
  };
  return { agent, context: assembleContext(trigger, awsS3RecoveryManifest) };
}

/**
 * Regression guard: validatePlan's checkScenario rejects any plan whose
 * metadata.scenario isn't listed in the manifest's failureScenarios, and
 * checkManifestCapabilities/checkStepCapabilities reject any manifest or
 * step capability the CapabilityRegistry doesn't know. Before this fix,
 * every scenario AwsS3RecoveryAgent.plan() could emit produced a plan that
 * failed real validatePlan: the neutral 'healthy' outcome diagnose() can
 * return was never declared in the manifest's failureScenarios (and plan()
 * had no healthy no-op guard — it built the full mutation plan and stamped
 * the un-declared 'healthy' scenario onto it), and the s3.versioning.write /
 * s3.lifecycle.write capabilities the mutation steps require were never
 * registered in the CapabilityRegistry — so `crisismode recover` dead-ended
 * at "Plan validation failed" for every aws-s3 scenario.
 */
describe('AwsS3RecoveryAgent.plan — real validatePlan per simulator scenario', () => {
  const cases: Array<{ state: SimulatorState; scenario: string }> = [
    { state: 'versioning_disabled', scenario: 'versioning_disabled' },
    { state: 'versioning_suspended', scenario: 'versioning_suspended' },
    { state: 'recovering', scenario: 'missing_lifecycle' },
    { state: 'degraded', scenario: 'backup_misconfigured' },
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

  it("builds a no-op plan (no mutation steps) when the bucket is healthy", async () => {
    const { agent, context } = setup('recovered');
    const diagnosis = await agent.diagnose(context);
    expect(diagnosis.scenario).toBe('healthy');

    const plan = await agent.plan(context, diagnosis);
    expect(plan.steps).toEqual([]);
    expect(plan.metadata.scenario).toBe('no_finding');
    expect(plan.rollbackStrategy.type).toBe('none');
  });
});
