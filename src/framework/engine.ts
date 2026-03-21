// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { AgentContext } from '../types/agent-context.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { ExecutionState, StepResult } from '../types/execution-state.js';
import type { AgentManifest } from '../types/manifest.js';
import type { ExecutionMode, RiskLevel } from '../types/common.js';
import type { RecoveryAgent } from '../agent/interface.js';
import { executeCapture, validateBlastRadius } from './safety.js';
import { requestApproval, shouldAutoApprove } from './coordinator.js';
import { isCatalogCovered } from './catalog.js';
import { ForensicRecorder } from './forensics.js';
import type { ExecutionBackend } from './backend.js';
import { resolveStepProviders } from './provider-registry.js';
import { derivePlanMaxRiskLevel, getMaxRiskIndex } from './risk.js';
import { collectExecutionContexts } from './step-walker.js';
import { makeStepResult } from './step-result.js';

export type { ExecutionMode } from '../types/common.js';

export interface EngineCallbacks {
  onStepStart?: (step: RecoveryStep, index: number) => void;
  onStepComplete?: (step: RecoveryStep, result: StepResult) => void;
  onPreConditionCheck?: (step: RecoveryStep, passed: boolean, description: string) => void;
  onSuccessCheck?: (step: RecoveryStep, passed: boolean, description: string) => void;
  onCapture?: (name: string, status: string) => void;
  onNotification?: (step: RecoveryStep) => void;
  onApprovalRequest?: (step: RecoveryStep) => void;
  onApprovalResult?: (step: RecoveryStep, result: string, catalogCovered: boolean) => void;
  onConditionalEval?: (step: RecoveryStep, result: boolean) => void;
  onReplanStart?: (step: RecoveryStep) => void;
  onReplanResult?: (action: string, details?: string) => void;
  onBlastRadiusCheck?: (step: SystemActionStep, message: string) => void;
}

/**
 * Legacy sequential execution engine.
 * Use RecoveryGraphEngine for checkpointed, resumable execution.
 */
export class LegacyExecutionEngine {
  private recorder: ForensicRecorder;
  private coveredRiskLevels: RiskLevel[] = [];
  private callbacks: EngineCallbacks;
  private backend: ExecutionBackend;
  private executionState: ExecutionState;
  private mode: ExecutionMode;

  constructor(
    private context: AgentContext,
    private manifest: AgentManifest,
    private agent: RecoveryAgent,
    recorder: ForensicRecorder,
    backend: ExecutionBackend,
    callbacks: EngineCallbacks = {},
    mode: ExecutionMode = 'dry-run',
  ) {
    this.recorder = recorder;
    this.callbacks = callbacks;
    this.backend = backend;
    this.mode = mode;
    this.executionState = {
      completedSteps: [],
      currentStepIndex: 0,
      captures: {},
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
    };
  }

  setCoveredRiskLevels(levels: RiskLevel[]): void {
    this.coveredRiskLevels = levels;
  }

  async executePlan(plan: RecoveryPlan, diagnosis: DiagnosisResult): Promise<StepResult[]> {
    const results: StepResult[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      this.executionState.currentStepIndex = i;
      this.callbacks.onStepStart?.(step, i);

      const result = await this.executeStep(step, plan, diagnosis);
      results.push(result);
      this.recorder.addStepResult(result);
      this.executionState.completedSteps.push(result);

      this.callbacks.onStepComplete?.(step, result);

      if (result.status === 'failed' || (step.type === 'human_approval' && result.status === 'skipped')) {
        this.recorder.addLogEntry({
          type: result.status === 'failed' ? 'step_failed' : 'info',
          stepId: step.stepId,
          message: result.status === 'failed'
            ? `Step failed: ${result.error}`
            : 'Execution halted after approval step was skipped',
        });
        break;
      }
    }

    return results;
  }

  private async executeStep(
    step: RecoveryStep,
    plan: RecoveryPlan,
    diagnosis: DiagnosisResult,
  ): Promise<StepResult> {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    this.recorder.addLogEntry({
      type: 'step_start',
      stepId: step.stepId,
      message: `Starting step: ${step.name}`,
    });

    try {
      switch (step.type) {
        case 'diagnosis_action':
          return this.executeDiagnosisAction(step, startedAt, startTime);
        case 'human_notification':
          return this.executeNotification(step, startedAt, startTime);
        case 'checkpoint':
          return this.executeCheckpoint(step, startedAt, startTime);
        case 'system_action':
          return this.executeSystemAction(step, startedAt, startTime);
        case 'human_approval':
          return await this.executeApproval(step, plan, startedAt, startTime);
        case 'replanning_checkpoint':
          return await this.executeReplanningCheckpoint(step, plan, diagnosis, startedAt, startTime);
        case 'conditional':
          return this.executeConditional(step, startedAt, startTime);
        default: {
          const _exhaustive: never = step;
          throw new Error(`Unknown step type: ${(_exhaustive as RecoveryStep).type}`);
        }
      }
    } catch (err) {
      return {
        stepId: step.stepId,
        step,
        status: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async executeDiagnosisAction(
    step: RecoveryStep & { type: 'diagnosis_action' },
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    const output = await this.backend.executeCommand(step.command);

    this.recorder.addLogEntry({
      type: 'step_complete',
      stepId: step.stepId,
      message: `Diagnosis action completed: ${step.name}`,
    });

    return makeStepResult(step, 'success', startedAt, startTime, { output });
  }

  private executeNotification(
    step: RecoveryStep & { type: 'human_notification' },
    startedAt: string,
    startTime: number,
  ): StepResult {
    this.callbacks.onNotification?.(step);

    this.recorder.addLogEntry({
      type: 'notification_sent',
      stepId: step.stepId,
      message: `Notification sent: ${step.message.summary}`,
      data: { recipients: step.recipients },
    });

    return makeStepResult(step, 'success', startedAt, startTime);
  }

  private executeCheckpoint(
    step: RecoveryStep & { type: 'checkpoint' },
    startedAt: string,
    startTime: number,
  ): StepResult {
    const captureResults = step.stateCaptures.map((capture) => {
      const result = executeCapture(capture);
      this.recorder.addCapture(result);
      this.callbacks.onCapture?.(result.name, result.status);
      return result;
    });

    const requiredFailed = captureResults.some(
      (r, i) => r.status === 'failed' && step.stateCaptures[i].capturePolicy === 'required',
    );

    return makeStepResult(step, requiredFailed ? 'failed' : 'success', startedAt, startTime, {
      captureResults: captureResults.map((r) => ({
        name: r.name,
        status: r.status,
        reason: r.reason,
        data: r.data,
      })),
    });
  }

  private async executeSystemAction(
    step: SystemActionStep,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    const fail = (error: string, extra?: Partial<StepResult>) =>
      makeStepResult(step, 'failed', startedAt, startTime, { error, ...extra });

    // Phase 1: Blast radius validation
    const blastResult = validateBlastRadius(step, this.manifest, this.context);
    this.callbacks.onBlastRadiusCheck?.(step, blastResult.message);
    if (!blastResult.valid) {
      this.recorder.addLogEntry({
        type: 'step_failed',
        stepId: step.stepId,
        message: `Blast radius validation failed: ${blastResult.message}`,
      });
      return fail(`Blast radius validation failed: ${blastResult.message}`);
    }

    // Phase 2: Provider resolution
    const providerResolution = resolveStepProviders(step, this.manifest, this.backend, this.mode);
    this.recorder.addLogEntry({
      type: providerResolution.resolved ? 'info' : 'step_failed',
      stepId: step.stepId,
      message: `Provider resolution: ${providerResolution.summary}`,
      data: {
        providers: providerResolution.providers,
        capabilities: providerResolution.capabilities,
      },
    });
    if (this.mode === 'execute' && !providerResolution.resolved) {
      return fail(`Provider resolution failed: ${providerResolution.summary}`, {
        providerResolution: providerResolution.capabilities,
      });
    }

    // Phase 3: Before captures
    const beforeCaptures = step.statePreservation.before.map((capture) => {
      const result = executeCapture(capture);
      this.recorder.addCapture(result);
      this.callbacks.onCapture?.(result.name, result.status);
      return result;
    });

    const requiredBeforeFailed = beforeCaptures.some(
      (r, i) => r.status === 'failed' && step.statePreservation.before[i].capturePolicy === 'required',
    );
    if (requiredBeforeFailed) {
      return fail('Required before capture failed', {
        providerResolution: providerResolution.capabilities,
      });
    }

    // Phase 4: Preconditions
    if (step.preConditions) {
      for (const pre of step.preConditions) {
        const passed = await this.backend.evaluateCheck(pre.check);
        this.callbacks.onPreConditionCheck?.(step, passed, pre.description);
        this.recorder.addLogEntry({
          type: 'precondition_check',
          stepId: step.stepId,
          message: `Precondition ${passed ? 'passed' : 'FAILED'}: ${pre.description}`,
        });
        if (!passed) {
          return fail(`Precondition failed: ${pre.description}`, {
            providerResolution: providerResolution.capabilities,
          });
        }
      }
    }

    // Phase 5: Command execution
    const cmdDesc = `${step.command.type} ${step.command.operation || step.command.statement || ''}`.trim();

    if (this.mode !== 'execute') {
      this.recorder.addLogEntry({
        type: 'step_complete',
        stepId: step.stepId,
        message: `[DRY-RUN] Would execute: ${cmdDesc}`,
      });
      this.callbacks.onCapture?.(`[DRY-RUN] ${step.name}`, 'skipped');

      if (step.stateTransition) {
        this.backend.transition?.(step.stateTransition);
      }

      return makeStepResult(step, 'success', startedAt, startTime, {
        output: { dryRun: true },
        providerResolution: providerResolution.capabilities,
      });
    }

    let output: unknown;
    try {
      output = await this.backend.executeCommand(step.command);
      this.recorder.addLogEntry({
        type: 'step_complete',
        stepId: step.stepId,
        message: `Executed command: ${cmdDesc}`,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.recorder.addLogEntry({
        type: 'step_failed',
        stepId: step.stepId,
        message: `Command execution failed: ${errMsg}`,
      });
      return fail(`Command execution failed: ${errMsg}`, {
        providerResolution: providerResolution.capabilities,
      });
    }

    if (step.stateTransition) {
      this.backend.transition?.(step.stateTransition);
    }

    // Phase 6: Success criteria
    const successPassed = await this.backend.evaluateCheck(step.successCriteria.check);
    this.callbacks.onSuccessCheck?.(step, successPassed, step.successCriteria.description);
    this.recorder.addLogEntry({
      type: 'success_check',
      stepId: step.stepId,
      message: `Success criteria ${successPassed ? 'passed' : 'FAILED'}: ${step.successCriteria.description}`,
    });

    // Phase 7: After captures
    for (const capture of step.statePreservation.after) {
      const result = executeCapture(capture);
      this.recorder.addCapture(result);
      this.callbacks.onCapture?.(result.name, result.status);
    }

    return makeStepResult(step, successPassed ? 'success' : 'failed', startedAt, startTime, {
      output,
      providerResolution: providerResolution.capabilities,
      error: successPassed ? undefined : `Success criteria failed: ${step.successCriteria.description}`,
    });
  }

  private async executeApproval(
    step: RecoveryStep & { type: 'human_approval' },
    plan: RecoveryPlan,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    const planRiskLevel = derivePlanMaxRiskLevel(plan);
    const effectiveTrust =
      this.context.trustScenarioOverrides[plan.metadata.scenario] || this.context.trustLevel;
    const catalogCovered = isCatalogCovered(planRiskLevel, this.coveredRiskLevels);
    const autoApprove = shouldAutoApprove(
      planRiskLevel,
      effectiveTrust,
      catalogCovered,
      this.context.organizationalPolicies.requireApprovalForAllElevated,
    );

    this.callbacks.onApprovalRequest?.(step);

    let result: string;
    if (autoApprove) {
      result = 'approved';
      this.recorder.addLogEntry({
        type: 'approval_auto',
        stepId: step.stepId,
        message: 'Approval auto-satisfied by trust level or catalog',
      });
    } else {
      result = await requestApproval(step, catalogCovered);
      this.recorder.addLogEntry({
        type: 'approval_received',
        stepId: step.stepId,
        message: `Approval result: ${result}`,
      });
    }

    this.callbacks.onApprovalResult?.(step, result, catalogCovered);

    if (result === 'rejected') {
      return makeStepResult(step, 'failed', startedAt, startTime, {
        error: 'Human rejected the step',
      });
    }

    return makeStepResult(step, result === 'skipped' ? 'skipped' : 'success', startedAt, startTime);
  }

  private async executeReplanningCheckpoint(
    step: RecoveryStep & { type: 'replanning_checkpoint' },
    plan: RecoveryPlan,
    diagnosis: DiagnosisResult,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    this.callbacks.onReplanStart?.(step);

    if (step.diagnosticCaptures) {
      for (const capture of step.diagnosticCaptures) {
        const result = executeCapture(capture);
        this.recorder.addCapture(result);
        this.callbacks.onCapture?.(result.name, result.status);
      }
    }

    const replanResult = await this.agent.replan(this.context, diagnosis, this.executionState);
    this.recorder.addLogEntry({
      type: 'replan_result',
      stepId: step.stepId,
      message: `Replan result: ${replanResult.action}`,
    });

    if (replanResult.action === 'abort') {
      this.callbacks.onReplanResult?.('abort', replanResult.reason);
      return makeStepResult(step, 'failed', startedAt, startTime, {
        error: `Replan aborted execution: ${replanResult.reason}`,
      });
    }

    if (replanResult.action === 'continue') {
      this.callbacks.onReplanResult?.('continue', 'Current plan remains valid');
      return makeStepResult(step, 'success', startedAt, startTime);
    }

    // revised_plan
    this.recorder.incrementReplanCount();
    this.recorder.addPlan(replanResult.plan);

    const fastReplanMet = step.fastReplan && this.checkFastReplanConditions(plan, replanResult.plan);
    const details = `Revised plan: ${replanResult.plan.metadata.summary}. Fast replan: ${fastReplanMet ? 'approved' : 'not applicable'}`;
    this.callbacks.onReplanResult?.('revised_plan', details);

    for (const revisedStep of replanResult.plan.steps) {
      this.callbacks.onStepStart?.(revisedStep, -1);
      const result = await this.executeStep(revisedStep, replanResult.plan, diagnosis);
      this.recorder.addStepResult(result);
      this.executionState.completedSteps.push(result);
      this.callbacks.onStepComplete?.(revisedStep, result);
      if (result.status === 'failed') {
        return makeStepResult(step, 'failed', startedAt, startTime, {
          error: `Revised plan failed at step ${revisedStep.stepId}: ${result.error ?? 'unknown error'}`,
        });
      }
    }

    return makeStepResult(step, 'success', startedAt, startTime);
  }

  private async executeConditional(
    step: RecoveryStep & { type: 'conditional' },
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    const conditionMet = await this.backend.evaluateCheck(step.condition.check);
    this.callbacks.onConditionalEval?.(step, conditionMet);

    this.recorder.addLogEntry({
      type: 'conditional_eval',
      stepId: step.stepId,
      message: `Condition '${step.condition.description}': ${conditionMet ? 'TRUE' : 'FALSE'}`,
    });

    let branchResult: StepResult;
    if (conditionMet) {
      this.callbacks.onStepStart?.(step.thenStep, -1);
      branchResult = await this.executeBranchStep(step.thenStep, startedAt, startTime);
      this.callbacks.onStepComplete?.(step.thenStep, branchResult);
    } else if (step.elseStep === 'skip') {
      branchResult = makeStepResult(step, 'skipped', startedAt, startTime);
    } else {
      this.callbacks.onStepStart?.(step.elseStep, -1);
      branchResult = await this.executeBranchStep(step.elseStep, startedAt, startTime);
      this.callbacks.onStepComplete?.(step.elseStep, branchResult);
    }

    this.recorder.addStepResult(branchResult);

    return makeStepResult(step, branchResult.status, startedAt, startTime);
  }

  private async executeBranchStep(
    step: RecoveryStep,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    if (step.type === 'system_action') {
      return this.executeSystemAction(step, startedAt, startTime);
    }
    if (step.type === 'human_notification') {
      return this.executeNotification(step, startedAt, startTime);
    }
    return makeStepResult(step, 'success', startedAt, startTime);
  }

  private checkFastReplanConditions(
    originalPlan: RecoveryPlan,
    revisedPlan: RecoveryPlan,
  ): boolean {
    // Condition 1: No new execution contexts
    const originalContexts = collectExecutionContexts(originalPlan.steps);
    const revisedContexts = collectExecutionContexts(revisedPlan.steps);
    for (const ctx of revisedContexts) {
      if (!originalContexts.has(ctx)) return false;
    }

    // Condition 2: No higher risk levels
    if (getMaxRiskIndex(revisedPlan.steps) > getMaxRiskIndex(originalPlan.steps)) return false;

    // Condition 3: Same target systems
    const getTargets = (plan: RecoveryPlan): Set<string> =>
      new Set(plan.impact.affectedSystems.map((s) => s.identifier));
    const originalTargets = getTargets(originalPlan);
    const revisedTargets = getTargets(revisedPlan);
    for (const target of revisedTargets) {
      if (!originalTargets.has(target)) return false;
    }

    return true;
  }
}

/**
 * Backwards-compatible alias.
 * Callers that import ExecutionEngine continue to get the legacy engine.
 */
export const ExecutionEngine = LegacyExecutionEngine;
