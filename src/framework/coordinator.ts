import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { HumanApprovalStep, HumanNotificationStep } from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';

export type ApprovalResult = 'approved' | 'skipped' | 'rejected';

export async function requestApproval(
  step: HumanApprovalStep,
  catalogCovered: boolean,
): Promise<ApprovalResult> {
  if (catalogCovered) {
    return 'approved';
  }

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

export function sendNotification(step: HumanNotificationStep): void {
  // In the demo, notifications are displayed by the display module.
  // This is a no-op placeholder for framework routing.
}

export function shouldAutoApprove(
  riskLevel: RiskLevel,
  trustLevel: string,
  catalogCovered: boolean,
  requireApprovalForAllElevated: boolean,
): boolean {
  if (catalogCovered) return true;

  if (riskLevel === 'high' || riskLevel === 'critical') return false;

  if (riskLevel === 'elevated') {
    if (requireApprovalForAllElevated) return false;
    return trustLevel === 'autopilot' || trustLevel === 'full_autonomy';
  }

  // routine
  return trustLevel !== 'observe';
}
