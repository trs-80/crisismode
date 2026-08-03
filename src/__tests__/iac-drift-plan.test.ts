// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { IacDriftRecoveryAgent } from '../agent/iac-drift/agent.js';
import { IacDriftSimulator } from '../agent/iac-drift/simulator.js';
import { validatePlan } from '../framework/validator.js';
import { iacDriftManifest } from '../agent/iac-drift/manifest.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';

function iacContext(agent: IacDriftRecoveryAgent): AgentContext {
  return assembleContext(
    { type: 'manual', source: 'test', payload: {}, receivedAt: new Date().toISOString() },
    agent.manifest,
  );
}

describe('IacDriftRecoveryAgent.plan', () => {
  it('emits a suggestion-only plan: no system_action, no human_approval', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const context = iacContext(agent);
    const plan = await agent.plan(context, await agent.diagnose(context));
    expect(plan.steps.length).toBeGreaterThanOrEqual(3); // capture + >=2 suggestions
    for (const step of plan.steps) {
      expect(['diagnosis_action', 'human_notification']).toContain(step.type);
    }
  });

  it('presents the terraform-plan-first fork for attribute drift', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const context = iacContext(agent);
    const plan = await agent.plan(context, await agent.diagnose(context));
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('terraform plan');            // confirm first
    expect(text).toContain('reverts the manual change'); // apply direction flagged destructive
    expect(text).toContain('update');                    // backport direction (edit .tf)
  });

  it('suggests the recreate-vs-remove fork for missing resources', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const context = iacContext(agent);
    const plan = await agent.plan(context, await agent.diagnose(context));
    const text = JSON.stringify(plan.steps);
    expect(text).toContain('user-uploads');
    expect(text).toContain('recreate');
  });

  it('passes the plan validator', async () => {
    const agent = new IacDriftRecoveryAgent(new IacDriftSimulator('drifted'));
    const context = iacContext(agent);
    const plan = await agent.plan(context, await agent.diagnose(context));
    const result = validatePlan(plan, iacDriftManifest); // ValidationResult { valid, checks }
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
