// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock the coordinator so human_approval steps don't block on stdin
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved',
  shouldAutoApprove: () => true,
}));
import { ExecutionEngine } from '../framework/engine.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { EngineCallbacks } from '../framework/engine.js';

function setup() {
  const simulator = new PgSimulator();
  const agent = new PgReplicationAgent(simulator);
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  const context = assembleContext(trigger, agent.manifest);
  const recorder = new ForensicRecorder();
  recorder.setContext(context);

  return { simulator, agent, context, recorder };
}

describe('ExecutionEngine', () => {
  it('executes a full plan in dry-run mode', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    expect(results.length).toBe(plan.steps.length);

    const failedSteps = results.filter((r) => r.status === 'failed');
    expect(failedSteps.length).toBe(0);
  });

  it('triggers state transitions via stateTransition field', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    expect(simulator.getState()).toBe('degraded');
    await engine.executePlan(plan, diagnosis);
    expect(simulator.getState()).toBe('recovered');
  });

  it('invokes callbacks during execution', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    const stepsStarted: string[] = [];
    const callbacks: EngineCallbacks = {
      onStepStart: (step) => stepsStarted.push(step.stepId),
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      callbacks,
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    await engine.executePlan(plan, diagnosis);
    expect(stepsStarted.length).toBeGreaterThanOrEqual(plan.steps.length);
  });

  it('stops execution on step failure', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);

    // Break the simulator so preconditions fail for step-004
    const origEval = simulator.evaluateCheck.bind(simulator);
    let callCount = 0;
    simulator.evaluateCheck = async (check) => {
      callCount++;
      // Fail the first precondition check for the disconnect step
      if (check.statement?.includes("client_addr = '10.0.1.52'") && !check.statement.includes("state = 'streaming'") && callCount <= 5) {
        return false;
      }
      return origEval(check);
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      {},
      'dry-run',
    );
    engine.setCoveredRiskLevels(['routine', 'elevated']);

    const results = await engine.executePlan(plan, diagnosis);
    const failed = results.find((r) => r.status === 'failed');
    expect(failed).toBeDefined();

    // Execution should stop after the failed step
    expect(results.length).toBeLessThan(plan.steps.length);
  });
});
