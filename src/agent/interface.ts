// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentContext } from '../types/agent-context.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { ExecutionState } from '../types/execution-state.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { AgentManifest } from '../types/manifest.js';
import type { HealthAssessment } from '../types/health.js';

export type ReplanResult =
  | { action: 'continue' }
  | { action: 'revised_plan'; plan: RecoveryPlan }
  | { action: 'abort'; reason: string };

export interface RecoveryAgent {
  manifest: AgentManifest;
  assessHealth(context: AgentContext): Promise<HealthAssessment>;
  diagnose(context: AgentContext): Promise<DiagnosisResult>;
  plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan>;
  replan(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult>;
  revisePlan?(
    context: AgentContext,
    diagnosis: DiagnosisResult,
    feedback: { reasons: string[] },
  ): Promise<RecoveryPlan>;
}
