// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export type HealthStatus = 'healthy' | 'recovering' | 'unhealthy' | 'unknown';

export type HealthSignalStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface HealthSignal {
  source: string;
  status: HealthSignalStatus;
  detail: string;
  observedAt: string;
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
