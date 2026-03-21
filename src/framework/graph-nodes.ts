// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { interrupt } from '@langchain/langgraph';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { StepResult } from '../types/execution-state.js';
import type { AgentManifest } from '../types/manifest.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from './backend.js';
import type { RecoveryGraphStateType } from './graph-state.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { ExecutionMode, RiskLevel } from '../types/common.js';
import type { ForensicLogEntry } from './graph-types.js';
import type { ApprovalHandler } from './approval-handler.js';
import { executeCapture, validateBlastRadius } from './safety.js';
import { shouldAutoApprove } from './coordinator.js';
import { isCatalogCovered } from './catalog.js';
import { resolveStepProviders } from './provider-registry.js';
import { derivePlanMaxRiskLevel } from './risk.js';
import { makeTimestamp } from './graph-helpers.js';
import { makeStepResult } from './step-result.js';

export type { ExecutionMode } from '../types/common.js';

export interface GraphNodeContext {
  backend: ExecutionBackend;
  manifest: AgentManifest;
  agentContext: AgentContext;
  agent: RecoveryAgent;
  mode: ExecutionMode;
  coveredRiskLevels: RiskLevel[];
  approvalHandler?: ApprovalHandler;
}

function makeLogEntry(
  type: ForensicLogEntry['type'],
  stepId: string,
  message: string,
  data?: Record<string, unknown>,
): ForensicLogEntry {
  return { timestamp: makeTimestamp(), type, stepId, message, data };
}

/**
 * Creates a LangGraph node function for a diagnosis_action step.
 */
export function makeDiagnosisNode(step: RecoveryStep & { type: 'diagnosis_action' }, ctx: GraphNodeContext) {
  return async (state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    try {
      const output = await ctx.backend.executeCommand(step.command);
      logs.push(makeLogEntry('step_complete', step.stepId, `Diagnosis action completed: ${step.name}`));

      const result = makeStepResult(step, 'success', startedAt, startTime, { output });

      const stepOutputs: Record<string, unknown> = {};
      if (step.outputCapture) {
        stepOutputs[step.outputCapture.name] = output;
      }

      return {
        completedSteps: [result],
        forensicLog: logs,
        stepOutputs,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logs.push(makeLogEntry('step_failed', step.stepId, `Diagnosis action failed: ${error}`));
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, { error })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
      };
    }
  };
}

/**
 * Creates a LangGraph node function for a human_notification step.
 */
export function makeNotificationNode(step: RecoveryStep & { type: 'human_notification' }, _ctx: GraphNodeContext) {
  return async (_state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();

    return {
      completedSteps: [makeStepResult(step, 'success', startedAt, startTime)],
      forensicLog: [
        makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
        makeLogEntry('notification_sent', step.stepId, `Notification sent: ${step.message.summary}`, {
          recipients: step.recipients,
        }),
      ],
    };
  };
}

/**
 * Creates a LangGraph node function for a checkpoint step.
 */
export function makeCheckpointNode(step: RecoveryStep & { type: 'checkpoint' }, _ctx: GraphNodeContext) {
  return async (_state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    const captureResults = step.stateCaptures.map((capture) => {
      const result = executeCapture(capture);
      return result;
    });

    const requiredFailed = captureResults.some(
      (r, i) => r.status === 'failed' && step.stateCaptures[i].capturePolicy === 'required',
    );

    const captures: Record<string, unknown> = {};
    for (const r of captureResults) {
      if (r.data !== undefined) {
        captures[r.name] = r.data;
      }
    }

    logs.push(makeLogEntry('step_complete', step.stepId, `Checkpoint completed: ${step.name}`));

    return {
      completedSteps: [makeStepResult(step, requiredFailed ? 'failed' : 'success', startedAt, startTime, {
        captureResults: captureResults.map((r) => ({
          name: r.name,
          status: r.status,
          reason: r.reason,
          data: r.data,
        })),
      })],
      captures,
      forensicLog: logs,
      ...(requiredFailed ? { executionOutcome: 'failed' as const, failedStepId: step.stepId } : {}),
    };
  };
}

/**
 * Creates a LangGraph node function for a system_action step.
 */
export function makeSystemActionNode(step: SystemActionStep, ctx: GraphNodeContext) {
  return async (state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    // Blast radius check
    const blastResult = validateBlastRadius(step, ctx.manifest, ctx.agentContext);
    if (!blastResult.valid) {
      logs.push(makeLogEntry('step_failed', step.stepId, `Blast radius validation failed: ${blastResult.message}`));
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          error: `Blast radius validation failed: ${blastResult.message}`,
        })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
        rollbackNeeded: true,
      };
    }

    // Provider resolution
    const providerResolution = resolveStepProviders(step, ctx.manifest, ctx.backend, ctx.mode);
    logs.push(makeLogEntry(
      providerResolution.resolved ? 'info' : 'step_failed',
      step.stepId,
      `Provider resolution: ${providerResolution.summary}`,
      { providers: providerResolution.providers, capabilities: providerResolution.capabilities },
    ));

    if (ctx.mode === 'execute' && !providerResolution.resolved) {
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          error: `Provider resolution failed: ${providerResolution.summary}`,
          providerResolution: providerResolution.capabilities,
        })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
        rollbackNeeded: true,
      };
    }

    // Execute before captures
    const beforeCaptures = step.statePreservation.before.map((capture) => executeCapture(capture));
    const requiredBeforeFailed = beforeCaptures.some(
      (r, i) => r.status === 'failed' && step.statePreservation.before[i].capturePolicy === 'required',
    );
    if (requiredBeforeFailed) {
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          error: 'Required before capture failed',
          providerResolution: providerResolution.capabilities,
        })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
        rollbackNeeded: true,
      };
    }

    // Check preconditions
    if (step.preConditions) {
      for (const pre of step.preConditions) {
        const passed = await ctx.backend.evaluateCheck(pre.check);
        logs.push(makeLogEntry('precondition_check', step.stepId,
          `Precondition ${passed ? 'passed' : 'FAILED'}: ${pre.description}`));
        if (!passed) {
          return {
            completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
              error: `Precondition failed: ${pre.description}`,
              providerResolution: providerResolution.capabilities,
            })],
            forensicLog: logs,
            executionOutcome: 'failed' as const,
            failedStepId: step.stepId,
            rollbackNeeded: true,
          };
        }
      }
    }

    // Execute or dry-run
    const cmdDesc = `${step.command.type} ${step.command.operation || step.command.statement || ''}`.trim();
    let output: unknown;

    if (ctx.mode === 'execute') {
      try {
        output = await ctx.backend.executeCommand(step.command);
        logs.push(makeLogEntry('step_complete', step.stepId, `Executed command: ${cmdDesc}`));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logs.push(makeLogEntry('step_failed', step.stepId, `Command execution failed: ${errMsg}`));
        return {
          completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
            error: `Command execution failed: ${errMsg}`,
            providerResolution: providerResolution.capabilities,
          })],
          forensicLog: logs,
          executionOutcome: 'failed' as const,
          failedStepId: step.stepId,
          rollbackNeeded: true,
        };
      }
    } else {
      logs.push(makeLogEntry('step_complete', step.stepId, `[DRY-RUN] Would execute: ${cmdDesc}`));

      if (step.stateTransition) {
        ctx.backend.transition?.(step.stateTransition);
      }

      return {
        completedSteps: [makeStepResult(step, 'success', startedAt, startTime, {
          output: { dryRun: true },
          providerResolution: providerResolution.capabilities,
        })],
        forensicLog: logs,
      };
    }

    if (step.stateTransition) {
      ctx.backend.transition?.(step.stateTransition);
    }

    // Check success criteria
    const successPassed = await ctx.backend.evaluateCheck(step.successCriteria.check);
    logs.push(makeLogEntry('success_check', step.stepId,
      `Success criteria ${successPassed ? 'passed' : 'FAILED'}: ${step.successCriteria.description}`));

    // Execute after captures
    for (const capture of step.statePreservation.after) {
      executeCapture(capture);
    }

    if (!successPassed) {
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          output,
          providerResolution: providerResolution.capabilities,
          error: `Success criteria failed: ${step.successCriteria.description}`,
        })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
        rollbackNeeded: true,
      };
    }

    return {
      completedSteps: [makeStepResult(step, 'success', startedAt, startTime, {
        output,
        providerResolution: providerResolution.capabilities,
      })],
      forensicLog: logs,
    };
  };
}

/**
 * Creates a LangGraph node function for a human_approval step.
 * Uses interrupt() for true human-in-the-loop when an approvalHandler is provided,
 * otherwise falls back to auto-approve logic.
 */
export function makeApprovalNode(
  step: RecoveryStep & { type: 'human_approval' },
  ctx: GraphNodeContext,
) {
  return async (state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    const plan = state.plan;
    const planRiskLevel = derivePlanMaxRiskLevel(plan);
    const effectiveTrust =
      ctx.agentContext.trustScenarioOverrides[plan.metadata.scenario] || ctx.agentContext.trustLevel;
    const catalogCovered = isCatalogCovered(planRiskLevel, ctx.coveredRiskLevels);
    const autoApprove = shouldAutoApprove(
      planRiskLevel,
      effectiveTrust,
      catalogCovered,
      ctx.agentContext.organizationalPolicies.requireApprovalForAllElevated,
    );

    let result: string;
    if (autoApprove) {
      result = 'approved';
      logs.push(makeLogEntry('approval_auto', step.stepId, 'Approval auto-satisfied by trust level or catalog'));
    } else if (ctx.approvalHandler) {
      // Use interrupt for human-in-the-loop approval
      const decision = interrupt({
        type: 'approval_request',
        stepId: step.stepId,
        presentation: step.presentation,
        approvers: step.approvers,
        catalogCovered,
      });
      result = decision as string;
      logs.push(makeLogEntry('approval_received', step.stepId, `Approval result: ${result}`));
    } else {
      // Fallback: auto-approve when no handler and no interrupt support
      result = 'approved';
      logs.push(makeLogEntry('approval_auto', step.stepId, 'No approval handler — auto-approved'));
    }

    if (result === 'rejected') {
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          error: 'Human rejected the step',
        })],
        forensicLog: logs,
        executionOutcome: 'failed' as const,
      };
    }

    const status = result === 'skipped' ? 'skipped' as const : 'success' as const;
    return {
      completedSteps: [makeStepResult(step, status, startedAt, startTime)],
      forensicLog: logs,
      ...(status === 'skipped' ? { executionOutcome: 'aborted' as const } : {}),
    };
  };
}

/**
 * Creates a LangGraph node function for a replanning_checkpoint step.
 */
export function makeReplanningNode(
  step: RecoveryStep & { type: 'replanning_checkpoint' },
  ctx: GraphNodeContext,
) {
  return async (state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    // Execute diagnostic captures
    if (step.diagnosticCaptures) {
      for (const capture of step.diagnosticCaptures) {
        executeCapture(capture);
      }
    }

    // Build execution state for the agent's replan method
    const executionState = {
      completedSteps: state.completedSteps,
      currentStepIndex: state.completedSteps.length,
      captures: state.captures,
      startedAt: state.completedSteps[0]?.startedAt ?? startedAt,
      elapsedMs: state.completedSteps.reduce((sum, s) => sum + s.durationMs, 0),
    };

    const replanResult = await ctx.agent.replan(ctx.agentContext, state.diagnosis, executionState);
    logs.push(makeLogEntry('replan_result', step.stepId, `Replan result: ${replanResult.action}`));

    if (replanResult.action === 'abort') {
      return {
        completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
          error: `Replan aborted execution: ${replanResult.reason}`,
        })],
        forensicLog: logs,
        executionOutcome: 'aborted' as const,
      };
    }

    if (replanResult.action === 'revised_plan') {
      // Execute revised plan steps inline (simplified — full subgraph in Phase 3)
      const revisedResults: StepResult[] = [];
      for (const revisedStep of replanResult.plan.steps) {
        const nodeFactory = createNodeForStep(revisedStep, ctx);
        const nodeResult = await nodeFactory(state);
        const stepResults = (nodeResult as { completedSteps?: StepResult[] }).completedSteps ?? [];
        revisedResults.push(...stepResults);

        const lastResult = stepResults[stepResults.length - 1];
        if (lastResult?.status === 'failed') {
          return {
            completedSteps: [makeStepResult(step, 'failed', startedAt, startTime, {
              error: `Revised plan failed at step ${revisedStep.stepId}: ${lastResult.error ?? 'unknown error'}`,
            })],
            forensicLog: logs,
            executionOutcome: 'failed' as const,
          };
        }
      }
    }

    return {
      completedSteps: [makeStepResult(step, 'success', startedAt, startTime)],
      forensicLog: logs,
    };
  };
}

/**
 * Creates a LangGraph node function for a conditional step.
 */
export function makeConditionalNode(
  step: RecoveryStep & { type: 'conditional' },
  ctx: GraphNodeContext,
) {
  return async (state: RecoveryGraphStateType) => {
    const startTime = Date.now();
    const startedAt = makeTimestamp();
    const logs: ForensicLogEntry[] = [
      makeLogEntry('step_start', step.stepId, `Starting step: ${step.name}`),
    ];

    const conditionMet = await ctx.backend.evaluateCheck(step.condition.check);
    logs.push(makeLogEntry('conditional_eval', step.stepId,
      `Condition '${step.condition.description}': ${conditionMet ? 'TRUE' : 'FALSE'}`));

    if (conditionMet) {
      const branchNode = createNodeForStep(step.thenStep, ctx);
      const branchResult = await branchNode(state);
      const branchSteps = (branchResult as { completedSteps?: StepResult[] }).completedSteps ?? [];
      const branchLogs = (branchResult as { forensicLog?: ForensicLogEntry[] }).forensicLog ?? [];

      return {
        completedSteps: [makeStepResult(step, branchSteps[0]?.status ?? 'success', startedAt, startTime)],
        forensicLog: [...logs, ...branchLogs],
        ...(branchSteps[0]?.status === 'failed' ? {
          executionOutcome: 'failed' as const,
          failedStepId: step.stepId,
        } : {}),
      };
    }

    if (step.elseStep === 'skip') {
      return {
        completedSteps: [makeStepResult(step, 'skipped', startedAt, startTime)],
        forensicLog: logs,
      };
    }

    const elseBranchNode = createNodeForStep(step.elseStep, ctx);
    const elseBranchResult = await elseBranchNode(state);
    const elseBranchSteps = (elseBranchResult as { completedSteps?: StepResult[] }).completedSteps ?? [];
    const elseBranchLogs = (elseBranchResult as { forensicLog?: ForensicLogEntry[] }).forensicLog ?? [];

    return {
      completedSteps: [makeStepResult(step, elseBranchSteps[0]?.status ?? 'success', startedAt, startTime)],
      forensicLog: [...logs, ...elseBranchLogs],
      ...(elseBranchSteps[0]?.status === 'failed' ? {
        executionOutcome: 'failed' as const,
        failedStepId: step.stepId,
      } : {}),
    };
  };
}

/**
 * Factory function: given a RecoveryStep, returns the appropriate node function.
 */
type NodeFunction = (state: RecoveryGraphStateType) => Promise<Partial<RecoveryGraphStateType>>;

/**
 * Factory function: given a RecoveryStep, returns the appropriate node function.
 */
export function createNodeForStep(
  step: RecoveryStep,
  ctx: GraphNodeContext,
): NodeFunction {
  switch (step.type) {
    case 'diagnosis_action':
      return makeDiagnosisNode(step, ctx);
    case 'human_notification':
      return makeNotificationNode(step, ctx);
    case 'checkpoint':
      return makeCheckpointNode(step, ctx);
    case 'system_action':
      return makeSystemActionNode(step, ctx);
    case 'human_approval':
      return makeApprovalNode(step, ctx);
    case 'replanning_checkpoint':
      return makeReplanningNode(step, ctx);
    case 'conditional':
      return makeConditionalNode(step, ctx);
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step type: ${(_exhaustive as RecoveryStep).type}`);
    }
  }
}

