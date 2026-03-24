// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep, SystemActionStep } from '../../types/step-types.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState, StepResult } from '../../types/execution-state.js';
import type { AgentManifest } from '../../types/manifest.js';
import type { ExecutionMode } from '../../types/common.js';

/**
 * Lifecycle events where hooks can be registered.
 */
export type HookPoint =
  | 'plan:validate'
  | 'plan:validated'
  | 'step:before'
  | 'step:after'
  | 'step:failed'
  | 'precondition:check'
  | 'approval:request'
  | 'capture:before'
  | 'recovery:complete';

/**
 * Context passed to hook handlers. Each hook point provides relevant
 * fields — handlers should check for undefined.
 */
export interface HookContext {
  plan?: RecoveryPlan;
  step?: RecoveryStep;
  stepResult?: StepResult;
  manifest?: AgentManifest;
  agentContext?: AgentContext;
  diagnosis?: DiagnosisResult;
  executionState?: ExecutionState;
  mode?: ExecutionMode;
}

/**
 * Result returned by a hook handler.
 * Returning void or {} means "continue normally".
 */
export interface HookResult {
  /** Set to true to abort execution with the given reason. */
  abort?: boolean;
  /** Reason for aborting — required when abort is true. */
  reason?: string;
}

/**
 * A hook handler function. Must not throw — the registry wraps calls
 * in try/catch and logs errors without halting the pipeline.
 */
export type HookHandler = (context: HookContext) => Promise<HookResult | void>;

/**
 * A registered hook.
 */
export interface HookRegistration {
  /** Unique name for this hook (used for logging and deregistration). */
  name: string;
  /** Which lifecycle event to attach to. */
  point: HookPoint;
  /** Execution priority — lower runs first. Built-in hooks use 0–99, community hooks use 100+. */
  priority: number;
  /** The handler function. */
  handler: HookHandler;
  /** Where this hook came from. */
  source?: 'builtin' | 'plugin' | 'playbook' | 'user';
}
