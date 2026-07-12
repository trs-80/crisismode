// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export interface DiagnosisResult {
  status: 'identified' | 'partial' | 'inconclusive' | 'unable';
  scenario: string | null;
  confidence: number;
  findings: DiagnosisFinding[];
  diagnosticPlanNeeded: boolean;
}

export interface DiagnosisFinding {
  source: string;
  observation: string;
  severity: 'info' | 'warning' | 'critical';
  data?: Record<string, unknown>;
  /** Plain-English one-liner: what this signal measures and why it matters. */
  explanation?: string;
  /** Where an unfamiliar operator can learn more about this concept. */
  learnMoreUrl?: string;
}
