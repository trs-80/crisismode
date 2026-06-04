// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency.
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import { walkSteps } from '../framework/step-walker.js';
import type { AgentContext } from '../types/agent-context.js';

/**
 * Backend that fails the reachability probe, forcing the `database_unreachable`
 * diagnosis and therefore the primary-down recovery plan (which includes the
 * elevated-risk "Restart PostgreSQL service" step). This path is not exercised
 * by the replication-lag fixtures in safety-invariants, which is how an elevated
 * step with empty statePreservation.before once slipped through.
 */
class UnreachablePgSimulator extends PgSimulator {
  override async queryReplicationStatus(): Promise<never> {
    throw new Error('connection refused');
  }
}

function makeContext(agent: PgReplicationAgent): AgentContext {
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresDown',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  return assembleContext(trigger, agent.manifest);
}

describe('PgReplicationAgent — primary-down (unreachable) plan', () => {
  it('diagnoses database_unreachable when the reachability probe fails', async () => {
    const agent = new PgReplicationAgent(new UnreachablePgSimulator());
    const diagnosis = await agent.diagnose(makeContext(agent));
    expect(diagnosis.scenario).toBe('database_unreachable');
  });

  it('emits statePreservation.before captures on the elevated restart step', async () => {
    const agent = new PgReplicationAgent(new UnreachablePgSimulator());
    const context = makeContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    const restart = plan.steps.find((s) => s.stepId === 'step-005');
    expect(restart).toBeDefined();
    expect(restart?.type).toBe('system_action');
    if (restart?.type === 'system_action') {
      expect(restart.riskLevel).toBe('elevated');
      expect(restart.statePreservation?.before?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('passes the state-preservation validation check', async () => {
    const agent = new PgReplicationAgent(new UnreachablePgSimulator());
    const context = makeContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    // Scope the assertion to the state-preservation invariant. (Full plan
    // validity additionally requires capability registration, which is global
    // test-harness setup orthogonal to this regression.)
    const result = validatePlan(plan, agent.manifest);
    const statePreservation = result.checks.find(
      (c) => c.name === 'State preservation for elevated+ steps',
    );
    expect(statePreservation?.passed).toBe(true);
  });

  it('keeps every elevated+ system_action covered by before-captures', async () => {
    const agent = new PgReplicationAgent(new UnreachablePgSimulator());
    const context = makeContext(agent);
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    walkSteps(plan.steps, (step) => {
      if (step.type === 'system_action' && step.riskLevel !== 'routine') {
        expect(
          step.statePreservation?.before?.length ?? 0,
          `Step "${step.stepId}" at risk "${step.riskLevel}" must have statePreservation.before captures`,
        ).toBeGreaterThan(0);
      }
    });
  });
});
