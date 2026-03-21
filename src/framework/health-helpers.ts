// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { HealthAssessment, HealthSignalStatus, HealthStatus } from '../types/health.js';
import type { HealthSignal } from '../types/health.js';

/**
 * Derive a signal-level status from critical/warning boolean flags.
 * Replaces the repeated `critical ? 'critical' : warning ? 'warning' : 'healthy'` ternary.
 */
export function signalStatus(critical: boolean, warning?: boolean): HealthSignalStatus {
  if (critical) return 'critical';
  if (warning) return 'warning';
  return 'healthy';
}

/**
 * Build a HealthAssessment from pre-computed status, signals, and status-keyed
 * summary/actions maps. Each agent still computes its own status and signals;
 * this function eliminates the repeated ternary chains for summary and actions.
 */
export function buildHealthAssessment(opts: {
  status: HealthStatus;
  signals: HealthSignal[];
  confidence: number;
  summary: Record<'healthy' | 'recovering' | 'unhealthy', string>;
  actions: Record<'healthy' | 'recovering' | 'unhealthy', string[]>;
}): HealthAssessment {
  const observedAt = opts.signals[0]?.observedAt ?? new Date().toISOString();
  const key = opts.status as 'healthy' | 'recovering' | 'unhealthy';
  return {
    status: opts.status,
    confidence: opts.confidence,
    summary: opts.summary[key] ?? `Status: ${opts.status}`,
    observedAt,
    signals: opts.signals,
    recommendedActions: opts.actions[key] ?? [],
  };
}
