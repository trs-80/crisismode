// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../types/recovery-plan.js';

export const RECOVERY_PLAN_API_VERSION = 'v0.2.1';

/**
 * Generate a plan ID with a timestamp and agent-specific suffix.
 * Format: rp-YYYYMMDDHHMMSS-{suffix}-{sequence}
 */
export function generatePlanId(suffix: string, sequence: number = 1): string {
  const now = new Date().toISOString();
  const ts = now.replace(/[-:T]/g, '').slice(0, 14);
  return `rp-${ts}-${suffix}-${String(sequence).padStart(3, '0')}`;
}

/**
 * Create the common envelope (apiVersion, kind, metadata) for a RecoveryPlan.
 * Agents call this instead of duplicating the boilerplate.
 */
export function createPlanEnvelope(opts: {
  planIdSuffix: string;
  agentName: string;
  agentVersion: string;
  scenario: string;
  estimatedDuration: string;
  summary: string;
  sequence?: number;
  supersedes?: string | null;
}): Pick<RecoveryPlan, 'apiVersion' | 'kind' | 'metadata'> {
  return {
    apiVersion: RECOVERY_PLAN_API_VERSION,
    kind: 'RecoveryPlan',
    metadata: {
      planId: generatePlanId(opts.planIdSuffix, opts.sequence),
      agentName: opts.agentName,
      agentVersion: opts.agentVersion,
      scenario: opts.scenario,
      createdAt: new Date().toISOString(),
      estimatedDuration: opts.estimatedDuration,
      summary: opts.summary,
      supersedes: opts.supersedes ?? null,
    },
  };
}
