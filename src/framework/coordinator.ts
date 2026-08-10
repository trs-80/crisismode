// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { HumanApprovalStep, HumanNotificationStep } from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';

export type ApprovalResult = 'approved' | 'skipped' | 'rejected';

/**
 * Ask a human. Callers reach this only after {@link shouldAutoApprove} declined
 * to auto-approve, so catalog coverage has already been considered — and a
 * second short-circuit here would let a catalog bypass the high/critical gate.
 * The parameter is retained for call-site compatibility and is deliberately
 * not honored as a bypass.
 */
export async function requestApproval(
  _step: HumanApprovalStep,
  _catalogCovered: boolean,
): Promise<ApprovalResult> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const answer = await rl.question(
      '\n    Enter your decision (approve/skip/reject): ',
    );

    const normalized = answer.trim().toLowerCase();
    if (normalized === 'approve' || normalized === 'a' || normalized === 'yes' || normalized === 'y') {
      return 'approved';
    }
    if (normalized === 'skip' || normalized === 's') {
      return 'skipped';
    }
    return 'rejected';
  } finally {
    rl.close();
  }
}

export function sendNotification(_step: HumanNotificationStep): void {
  // In the demo, notifications are displayed by the display module.
  // This is a no-op placeholder for framework routing.
}

export function shouldAutoApprove(
  riskLevel: RiskLevel,
  trustLevel: string,
  catalogCovered: boolean,
  requireApprovalForAllElevated: boolean,
): boolean {
  // High and critical risk always reach a human. This check sits above the
  // catalog short-circuit on purpose: no standing approval may cover them.
  if (riskLevel === 'high' || riskLevel === 'critical') return false;

  if (catalogCovered) return true;

  if (riskLevel === 'elevated') {
    if (requireApprovalForAllElevated) return false;
    return trustLevel === 'autopilot' || trustLevel === 'full_autonomy';
  }

  // routine
  return trustLevel !== 'observe';
}
