// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export type HealthStatus = 'healthy' | 'recovering' | 'unhealthy' | 'unknown';

export type HealthSignalStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface HealthSignal {
  source: string;
  status: HealthSignalStatus;
  detail: string;
  observedAt: string;
  /** Plain-English one-liner: what this signal measures and why it matters. */
  explanation?: string;
  /** Where an unfamiliar operator can learn more about this concept. */
  learnMoreUrl?: string;
  /** Stable identifier of the concrete resource this signal is about (e.g. an RDS instance id) — used for cross-agent correlation. */
  entityId?: string;
  /** Stable id of the check that produced this signal (e.g. 'llm-provider.key_valid') — consumed by the guidance registry. Optional: agents adopt it incrementally. */
  checkId?: string;
  /** Per-target substitutions (e.g. { instance: 'prod-db-01' }) for this signal's checkId's matched guide, applied before the guide is attached. Undefined when the checkId's guide has no placeholders to fill. */
  guideVars?: Record<string, string> | undefined;
}

export interface HealthAssessment {
  status: HealthStatus;
  confidence: number;
  summary: string;
  observedAt: string;
  signals: HealthSignal[];
  recommendedActions: string[];
}

export type OperatorActionRequired =
  | 'none'
  | 'monitor'
  | 'investigate'
  | 'retry_with_execute'
  | 'manual_intervention_required'
  | 'use_different_tool';

export type AutomationStatus =
  | 'no_mutations_performed'
  | 'partial_mutations_performed'
  | 'recovery_completed';

export type ExecuteReadiness = 'ready' | 'blocked' | 'not_applicable';

export interface OperatorSummary {
  currentState: HealthStatus;
  confidence: number;
  summary: string;
  actionRequired: OperatorActionRequired;
  automationStatus: AutomationStatus;
  executeReadiness: ExecuteReadiness;
  mutationsPerformed: boolean;
  recommendedNextStep: string;
  recommendedActions: string[];
  evidence: HealthSignal[];
  validationBlockers: string[];
  observedAt: string;
}
