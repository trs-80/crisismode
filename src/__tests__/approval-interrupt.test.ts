// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { MemorySaver, Command } from '@langchain/langgraph';

// Mock the Anthropic SDK so agent.ts can be imported without the dependency
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

// Mock shouldAutoApprove to return false so we hit the interrupt path
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: vi.fn(async () => 'approved'),
  shouldAutoApprove: vi.fn(() => false),
}));

import { RecoveryGraphEngine } from '../framework/graph-engine.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { ApprovalHandler, ApprovalDecision } from '../framework/approval-handler.js';

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

function makeApprovalPlan(agent: PgReplicationAgent, scenario: string): RecoveryPlan {
  return {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'approval-interrupt-test',
      agentName: agent.manifest.metadata.name,
      agentVersion: agent.manifest.metadata.version,
      scenario,
      createdAt: new Date().toISOString(),
      estimatedDuration: 'PT1M',
      summary: 'Test interrupt/resume approval',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps: [
      {
        stepId: 'step-notify',
        type: 'human_notification',
        name: 'Notify team',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Recovery starting', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
      {
        stepId: 'step-approve',
        type: 'human_approval',
        name: 'Approve recovery',
        approvers: [{ role: 'on_call_dba', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: 'Approve recovery action',
          detail: 'This will modify the system',
          proposedActions: ['Disconnect lagging replica'],
          alternatives: [{ action: 'skip', description: 'Skip this step' }],
        },
        timeout: 'PT5M',
        timeoutAction: 'escalate',
      },
      {
        stepId: 'step-final',
        type: 'human_notification',
        name: 'Completion notice',
        recipients: [{ role: 'on_call_dba', urgency: 'low' }],
        message: { summary: 'Recovery complete', detail: 'Done', actionRequired: false },
        channel: 'auto',
      },
    ],
    rollbackStrategy: {
      type: 'none',
      description: 'Notification-only plan.',
    },
  };
}

describe('Approval interrupt/resume', () => {
  it('pauses at human_approval with interrupt and resumes with approved', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = makeApprovalPlan(agent, diagnosis.scenario ?? 'test');

    // Create a mock approval handler to trigger the interrupt path
    const mockHandler: ApprovalHandler = {
      requestApproval: vi.fn(async () => 'approved' as ApprovalDecision),
    };

    const checkpointer = new MemorySaver();
    const threadId = `approval-test-${Date.now()}`;

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      {
        checkpointer,
        threadId,
        approvalHandler: mockHandler,
      },
    );
    engine.setCoveredRiskLevels([]);

    // First run — should pause at the approval step
    const results = await engine.executePlan(plan, diagnosis);

    // The graph should have paused at the approval interrupt.
    // Only the notification before approval should have completed.
    expect(results.length).toBe(1);
    expect(results[0].stepId).toBe('step-notify');

    // Resume with approval
    const resumedResults = await engine.resume('approved');

    // After resume, all steps should be complete
    expect(resumedResults.length).toBe(3);
    expect(resumedResults[1].stepId).toBe('step-approve');
    expect(resumedResults[1].status).toBe('success');
    expect(resumedResults[2].stepId).toBe('step-final');
    expect(resumedResults[2].status).toBe('success');
  });

  it('halts execution when approval is rejected after resume', async () => {
    const { simulator, agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);
    const plan = makeApprovalPlan(agent, diagnosis.scenario ?? 'test');

    const mockHandler: ApprovalHandler = {
      requestApproval: vi.fn(async () => 'approved' as ApprovalDecision),
    };

    const checkpointer = new MemorySaver();
    const threadId = `approval-reject-${Date.now()}`;

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      simulator,
      'dry-run',
      {
        checkpointer,
        threadId,
        approvalHandler: mockHandler,
      },
    );
    engine.setCoveredRiskLevels([]);

    // First run — pauses at approval
    await engine.executePlan(plan, diagnosis);

    // Resume with rejection
    const resumedResults = await engine.resume('rejected');

    // Approval should show as failed, and no further steps should execute
    const approvalResult = resumedResults.find((r) => r.stepId === 'step-approve');
    expect(approvalResult?.status).toBe('failed');
    expect(approvalResult?.error).toContain('Human rejected');

    // step-final should not appear
    const finalResult = resumedResults.find((r) => r.stepId === 'step-final');
    expect(finalResult).toBeUndefined();
  });

  it('passes inter-step data through stepOutputs', async () => {
    const { agent, context, recorder } = setup();
    const diagnosis = await agent.diagnose(context);

    const backend: ExecutionBackend = {
      executeCommand: async (cmd) => ({ replicationLag: 42, query: cmd.statement }),
      evaluateCheck: async () => true,
      close: async () => {},
    };

    const plan: RecoveryPlan = {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: 'inter-step-state',
        agentName: agent.manifest.metadata.name,
        agentVersion: agent.manifest.metadata.version,
        scenario: diagnosis.scenario ?? 'test',
        createdAt: new Date().toISOString(),
        estimatedDuration: 'PT1M',
        summary: 'Test inter-step data passing',
        supersedes: null,
      },
      impact: {
        affectedSystems: [],
        affectedServices: [],
        estimatedUserImpact: 'none',
        dataLossRisk: 'none',
      },
      steps: [
        {
          stepId: 'step-diag',
          type: 'diagnosis_action',
          name: 'Check replication lag',
          executionContext: 'psql_cli',
          target: 'pg-primary',
          command: {
            type: 'sql',
            statement: 'SELECT replay_lag FROM pg_stat_replication;',
          },
          outputCapture: {
            name: 'replication_lag',
            format: 'json',
            availableTo: 'downstream_steps',
          },
          timeout: 'PT10S',
        },
        {
          stepId: 'step-notify',
          type: 'human_notification',
          name: 'Report results',
          recipients: [{ role: 'on_call_dba', urgency: 'high' }],
          message: { summary: 'Lag check complete', detail: 'See outputs', actionRequired: false },
          channel: 'auto',
        },
      ],
      rollbackStrategy: {
        type: 'none',
        description: 'Read-only plan.',
      },
    };

    const checkpointer = new MemorySaver();
    const threadId = `inter-step-${Date.now()}`;

    const engine = new RecoveryGraphEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      'dry-run',
      { checkpointer, threadId },
    );

    await engine.executePlan(plan, diagnosis);

    const state = await engine.getState();
    expect(state).toBeDefined();
    expect(state!.stepOutputs['replication_lag']).toEqual({
      replicationLag: 42,
      query: 'SELECT replay_lag FROM pg_stat_replication;',
    });
  });
});
