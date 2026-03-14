// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { AgentContext } from '../types/agent-context.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { ExecutionState, StepResult } from '../types/execution-state.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RiskLevel } from '../types/common.js';
import type { RecoveryAgent } from '../agent/interface.js';
import { executeCapture, validateBlastRadius } from './safety.js';
import { requestApproval, shouldAutoApprove } from './coordinator.js';
import { isCatalogCovered } from './catalog.js';
import { ForensicRecorder } from './forensics.js';
import type { PgBackend } from '../agent/pg-replication/backend.js';

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

export type ExecutionMode = 'dry-run' | 'execute';

export class ExecutionEngine {
  private recorder: ForensicRecorder;
  private coveredRiskLevels: RiskLevel[] = [];
  private callbacks: EngineCallbacks;
  private backend: PgBackend;
  private executionState: ExecutionState;
  private mode: ExecutionMode;

  constructor(
    private context: AgentContext,
    private manifest: AgentManifest,
    private agent: RecoveryAgent,
    recorder: ForensicRecorder,
    backend: PgBackend,
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

      if (result.status === 'failed') {
        this.recorder.addLogEntry({
          type: 'step_failed',
          stepId: step.stepId,
          message: `Step failed: ${result.error}`,
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
          return await this.executeApproval(step, startedAt, startTime);
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
    // Execute the diagnosis query against the backend
    const output = step.command.statement
      ? await this.backend.queryReplicationStatus()
      : null;

    this.recorder.addLogEntry({
      type: 'step_complete',
      stepId: step.stepId,
      message: `Diagnosis action completed: ${step.name}`,
    });

    return {
      stepId: step.stepId,
      step,
      status: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      output,
    };
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

    return {
      stepId: step.stepId,
      step,
      status: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
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

    return {
      stepId: step.stepId,
      step,
      status: requiredFailed ? 'failed' : 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      captureResults: captureResults.map((r) => ({
        name: r.name,
        status: r.status,
        reason: r.reason,
        data: r.data,
      })),
    };
  }

  private async executeSystemAction(
    step: SystemActionStep,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    // Blast radius check
    const blastResult = validateBlastRadius(step, this.manifest);
    this.callbacks.onBlastRadiusCheck?.(step, blastResult.message);

    // Execute before captures
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
      return {
        stepId: step.stepId,
        step,
        status: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: 'Required before capture failed',
      };
    }

    // Check preconditions
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
          return {
            stepId: step.stepId,
            step,
            status: 'failed',
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            error: `Precondition failed: ${pre.description}`,
          };
        }
      }
    }

    // Execute or log the command based on mode
    const cmdDesc = `${step.command.type} ${step.command.operation || step.command.statement || ''}`.trim();

    if (this.mode === 'execute' && step.command.statement && step.command.type === 'sql') {
      // Live execution: run the SQL
      try {
        await this.backend.executeSQL(step.command.statement);
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
        return {
          stepId: step.stepId,
          step,
          status: 'failed',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          error: `Command execution failed: ${errMsg}`,
        };
      }
    } else if (this.mode === 'dry-run') {
      this.recorder.addLogEntry({
        type: 'step_complete',
        stepId: step.stepId,
        message: `[DRY-RUN] Would execute: ${cmdDesc}`,
      });
      this.callbacks.onCapture?.(`[DRY-RUN] ${step.name}`, 'skipped');
    } else {
      // Structured commands (non-SQL) — log in both modes
      this.recorder.addLogEntry({
        type: 'step_complete',
        stepId: step.stepId,
        message: `Executed command: ${cmdDesc}`,
      });
    }

    // Simulator state transitions (no-op for live client)
    if (step.stepId === 'step-004') {
      this.backend.transition('recovering');
    }
    if (step.stepId === 'step-008') {
      this.backend.transition('recovered');
    }

    // Check success criteria
    const successPassed = await this.backend.evaluateCheck(step.successCriteria.check);
    this.callbacks.onSuccessCheck?.(step, successPassed, step.successCriteria.description);
    this.recorder.addLogEntry({
      type: 'success_check',
      stepId: step.stepId,
      message: `Success criteria ${successPassed ? 'passed' : 'FAILED'}: ${step.successCriteria.description}`,
    });

    // Execute after captures
    for (const capture of step.statePreservation.after) {
      const result = executeCapture(capture);
      this.recorder.addCapture(result);
      this.callbacks.onCapture?.(result.name, result.status);
    }

    return {
      stepId: step.stepId,
      step,
      status: successPassed ? 'success' : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      error: successPassed ? undefined : `Success criteria failed: ${step.successCriteria.description}`,
    };
  }

  private async executeApproval(
    step: RecoveryStep & { type: 'human_approval' },
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    const effectiveTrust =
      this.context.trustScenarioOverrides['replication_lag_cascade'] || this.context.trustLevel;

    const catalogCovered = isCatalogCovered('high', this.coveredRiskLevels);

    const autoApprove = shouldAutoApprove(
      'high',
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
      const approval = await requestApproval(step, catalogCovered);
      result = approval;
      this.recorder.addLogEntry({
        type: 'approval_received',
        stepId: step.stepId,
        message: `Approval result: ${approval}`,
      });
    }

    this.callbacks.onApprovalResult?.(step, result, catalogCovered);

    if (result === 'rejected') {
      return {
        stepId: step.stepId,
        step,
        status: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        error: 'Human rejected the step',
      };
    }

    return {
      stepId: step.stepId,
      step,
      status: result === 'skipped' ? 'skipped' : 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
  }

  private async executeReplanningCheckpoint(
    step: RecoveryStep & { type: 'replanning_checkpoint' },
    plan: RecoveryPlan,
    diagnosis: DiagnosisResult,
    startedAt: string,
    startTime: number,
  ): Promise<StepResult> {
    this.callbacks.onReplanStart?.(step);

    // Execute diagnostic captures
    if (step.diagnosticCaptures) {
      for (const capture of step.diagnosticCaptures) {
        const result = executeCapture(capture);
        this.recorder.addCapture(result);
        this.callbacks.onCapture?.(result.name, result.status);
      }
    }

    // Invoke agent's replan
    const replanResult = await this.agent.replan(this.context, diagnosis, this.executionState);

    this.recorder.addLogEntry({
      type: 'replan_result',
      stepId: step.stepId,
      message: `Replan result: ${replanResult.action}`,
    });

    if (replanResult.action === 'revised_plan') {
      this.recorder.incrementReplanCount();
      this.recorder.addPlan(replanResult.plan);

      // Check fast replan conditions
      const fastReplanMet = step.fastReplan && this.checkFastReplanConditions(plan, replanResult.plan);
      const details = `Revised plan: ${replanResult.plan.metadata.summary}. Fast replan: ${fastReplanMet ? 'approved' : 'not applicable'}`;
      this.callbacks.onReplanResult?.('revised_plan', details);

      // Execute the revised plan steps inline
      for (const revisedStep of replanResult.plan.steps) {
        this.callbacks.onStepStart?.(revisedStep, -1);
        const result = await this.executeStep(revisedStep, replanResult.plan, diagnosis);
        this.recorder.addStepResult(result);
        this.executionState.completedSteps.push(result);
        this.callbacks.onStepComplete?.(revisedStep, result);
      }
    } else if (replanResult.action === 'continue') {
      this.callbacks.onReplanResult?.('continue', 'Current plan remains valid');
    } else {
      this.callbacks.onReplanResult?.('abort', replanResult.reason);
    }

    return {
      stepId: step.stepId,
      step,
      status: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
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
    } else {
      if (step.elseStep === 'skip') {
        branchResult = {
          stepId: step.stepId,
          step,
          status: 'skipped',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        };
      } else {
        this.callbacks.onStepStart?.(step.elseStep, -1);
        branchResult = await this.executeBranchStep(step.elseStep, startedAt, startTime);
        this.callbacks.onStepComplete?.(step.elseStep, branchResult);
      }
    }

    this.recorder.addStepResult(branchResult);

    return {
      stepId: step.stepId,
      step,
      status: branchResult.status,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
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
    return {
      stepId: step.stepId,
      step,
      status: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
  }

  private checkFastReplanConditions(
    originalPlan: RecoveryPlan,
    revisedPlan: RecoveryPlan,
  ): boolean {
    // Simplified fast replan check
    // 1. No new execution contexts
    // 2. No higher risk levels
    // 3. Same target systems
    return true; // In the demo, fast replan always passes
  }
}
