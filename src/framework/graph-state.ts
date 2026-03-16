// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { Annotation } from '@langchain/langgraph';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { StepResult } from '../types/execution-state.js';
import type { ForensicLogEntry } from './graph-types.js';

/**
 * LangGraph state schema for recovery plan execution.
 *
 * Reducers:
 * - completedSteps: append — each node returns new results, they accumulate
 * - captures: merge — downstream steps read upstream captures
 * - stepOutputs: merge — downstream steps read upstream diagnosis/command outputs
 * - forensicLog: append — streaming forensic entries
 * - plan, diagnosis, executionOutcome: replace — latest value wins
 * - rollbackNeeded, rollbackResults: replace/append for Phase 3
 */
export const RecoveryGraphState = Annotation.Root({
  /** The recovery plan being executed */
  plan: Annotation<RecoveryPlan>,

  /** Diagnosis that triggered this plan */
  diagnosis: Annotation<DiagnosisResult>,

  /** Accumulated step results — append reducer */
  completedSteps: Annotation<StepResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** State captures keyed by name — merge reducer */
  captures: Annotation<Record<string, unknown>>({
    reducer: (existing, updates) => ({ ...existing, ...updates }),
    default: () => ({}),
  }),

  /** Inter-step data passing — merge reducer */
  stepOutputs: Annotation<Record<string, unknown>>({
    reducer: (existing, updates) => ({ ...existing, ...updates }),
    default: () => ({}),
  }),

  /** Forensic log entries — append reducer */
  forensicLog: Annotation<ForensicLogEntry[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Overall execution outcome — replace reducer */
  executionOutcome: Annotation<'success' | 'failed' | 'partial_success' | 'aborted' | 'pending'>({
    reducer: (_existing, update) => update,
    default: () => 'pending' as const,
  }),

  /** Whether rollback is needed — replace reducer (Phase 3) */
  rollbackNeeded: Annotation<boolean>({
    reducer: (_existing, update) => update,
    default: () => false,
  }),

  /** Rollback step results — append reducer (Phase 3) */
  rollbackResults: Annotation<StepResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** ID of the step that triggered failure/rollback */
  failedStepId: Annotation<string | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),
});

export type RecoveryGraphStateType = typeof RecoveryGraphState.State;
