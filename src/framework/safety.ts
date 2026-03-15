// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CaptureDirective, RiskLevel } from '../types/common.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { AgentManifest } from '../types/manifest.js';

export interface CaptureResult {
  name: string;
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  timestamp: string;
  data?: unknown;
}

export function executeCapture(capture: CaptureDirective): CaptureResult {
  // Simulate capture execution based on cost/policy
  const timestamp = new Date().toISOString();

  // Deferred captures are queued for execution after the action or after
  // system health improves — not executed inline during plan execution
  if (capture.capturePolicy === 'deferred') {
    return {
      name: capture.name,
      status: 'skipped',
      reason: 'Deferred capture — queued for post-action or post-recovery execution',
      timestamp,
    };
  }

  if (capture.captureCost === 'expensive') {
    if (capture.capturePolicy === 'best_effort') {
      return {
        name: capture.name,
        status: 'skipped',
        reason: 'Expensive capture skipped during active degradation (best_effort)',
        timestamp,
      };
    }
  }

  // Simulate successful capture
  return {
    name: capture.name,
    status: 'captured',
    timestamp,
    data: simulateCaptureData(capture),
  };
}

function simulateCaptureData(capture: CaptureDirective): unknown {
  switch (capture.captureType) {
    case 'sql_query':
      return { rows: '[simulated query result]', statement: capture.statement };
    case 'file_snapshot':
      return { files: capture.targets, snapshotId: `snap-${Date.now()}` };
    case 'command_output':
      return { output: '[simulated command output]' };
    default:
      return { type: capture.captureType, captured: true };
  }
}

export function validateBlastRadius(
  step: SystemActionStep,
  manifest: AgentManifest,
): { valid: boolean; message: string } {
  // Tier 1: verify target is within manifest's declared execution contexts
  const targetTech = step.target.split('-')[0]; // simplified extraction
  const hasContext = manifest.spec.executionContexts.some(
    (ec) => ec.name === step.executionContext,
  );

  if (!hasContext) {
    return {
      valid: false,
      message: `Step targets context '${step.executionContext}' not declared in manifest`,
    };
  }

  // Tier 2: check blast radius declaration completeness (advisory)
  if (
    step.blastRadius.directComponents.length === 0 &&
    step.riskLevel !== 'routine'
  ) {
    return {
      valid: true,
      message:
        'Warning: no direct components declared in blast radius for non-routine action',
    };
  }

  return {
    valid: true,
    message: `Blast radius validated: ${step.blastRadius.directComponents.length} direct, ${step.blastRadius.indirectComponents.length} indirect components`,
  };
}

export function shouldRequireApproval(
  riskLevel: RiskLevel,
  trustLevel: string,
  policies: { requireApprovalForAllElevated: boolean },
  catalogCovers: boolean,
): boolean {
  if (catalogCovers) return false;

  if (riskLevel === 'high' || riskLevel === 'critical') return true;

  if (riskLevel === 'elevated') {
    if (policies.requireApprovalForAllElevated) return true;
    if (trustLevel === 'autopilot' || trustLevel === 'full_autonomy') return false;
    return true;
  }

  // routine
  if (trustLevel === 'observe') return true;
  return false;
}
