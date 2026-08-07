// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from './remediation-guide.js';

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
  /** Stable id of the check that produced this finding (e.g. 'llm-provider.key_valid') — consumed by the guidance registry. Optional: agents adopt it incrementally. */
  checkId?: string;
  /** Remediation guides matched to this finding's checkId (attached at render time). */
  guides?: RemediationGuide[] | undefined;
  /** Per-target substitutions for this finding's checkId's matched guide, applied before attachment — mirrors HealthSignal.guideVars. */
  guideVars?: Record<string, string> | undefined;
}
