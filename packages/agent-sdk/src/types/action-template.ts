// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ActionClass, MutationType } from './evidence-bundle.js';
import type {
  BlastRadius,
  CaptureDirective,
  PreCondition,
  RiskLevel,
  RollbackDirective,
  SuccessCriteria,
} from './common.js';

/**
 * ActionTemplate — bridge between the SRE-skills bundle vocabulary
 * and CrisisMode's typed recovery steps.
 *
 * A template carries the scaffolding metadata needed to expand a
 * bundle-level `action_id` (e.g. `inspect_database_pool`) into a
 * concrete `DiagnosisActionStep` or `SystemActionStep`.
 *
 * Templates are data-only; the builder lives in the framework
 * (`templateToStep`).
 */
export interface ActionTemplate {
  /** Bundle-level identifier (e.g. `inspect_database_pool`). */
  action_id: string;
  /** Human-readable label for operator surfaces. */
  display_name: string;
  description: string;
  /** Domain bucket aligned with bundle `skill_domains` values. */
  skill_domain: string;
  /** Action class (0 = read, 3 = state-mutating). */
  action_class: ActionClass;
  mutation_type: MutationType;
  /** Which step type to emit. */
  step_type: 'diagnosis_action' | 'system_action';
  /** Target kinds this template applies to (e.g. `postgresql`, `kubernetes`). */
  target_kinds: string[];
  /** CrisisMode capability IDs this template needs from a provider. */
  required_capabilities: string[];
  /** Execution context tag passed to the engine (e.g. `postgresql_read`). */
  execution_context: string;
  /** ISO 8601 duration (e.g. `PT30S`). */
  default_timeout: string;
  /** Risk level — required when `step_type === 'system_action'`. */
  risk_level?: RiskLevel;
  /** Blast radius defaults — required when `step_type === 'system_action'`. */
  blast_radius?: BlastRadius;
  /** Whether mutating steps need a checkpoint before. */
  needs_state_preservation?: boolean;
  /** Whether mutating steps need a human_approval gate before. */
  needs_human_approval?: boolean;
  // ── Class 2+ safety scaffolding ──
  /** Preconditions that must hold before executing the mutation. */
  preconditions?: PreCondition[];
  /** State captures taken before the mutation runs (required for class >= 2). */
  state_captures_before?: CaptureDirective[];
  /** State captures taken after the mutation runs (for diffing / forensics). */
  state_captures_after?: CaptureDirective[];
  /** How the engine verifies the mutation succeeded (required for class >= 2). */
  success_check?: SuccessCriteria;
  /** Rollback directive (required for class >= 2). */
  rollback?: RollbackDirective;
}
