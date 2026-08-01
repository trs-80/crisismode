// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Plain-language consequence framing for plan steps, rendered before approval
 * gates. Pure derivation from safety data every plan already carries
 * (blast radius, state preservation, rollback) — no per-step authoring.
 */

import type { RecoveryPlan } from '../types/index.js';

export interface RiskFraming {
  does: string;
  couldGoWrong: string;
  undo: string;
}

const RISK_WARNING: Record<string, string> = {
  elevated: 'This changes a live system.',
  high: 'This makes a significant change to a live system — a mistake here causes real downtime.',
  critical: 'This is a last-resort action that can cause data loss or extended downtime if it goes wrong.',
};

type Step = RecoveryPlan['steps'][number];

export function buildRiskFraming(step: Step): RiskFraming | null {
  if (step.type !== 'system_action') return null;
  const warning = RISK_WARNING[step.riskLevel];
  if (!warning) return null; // routine (or unknown) — no framing needed

  const affected = [
    ...step.blastRadius.directComponents,
    ...step.blastRadius.indirectComponents,
  ].filter(Boolean);
  const couldGoWrong = [
    warning,
    affected.length > 0 ? `Affects: ${affected.join(', ')}.` : '',
    step.blastRadius.maxImpact ? `Worst case: ${step.blastRadius.maxImpact}.` : '',
  ].filter(Boolean).join(' ');

  const captures = step.statePreservation.before.map((c) => c.name).filter(Boolean);
  const undo = step.rollback
    ? step.rollback.description
    : captures.length > 0
      ? `No automatic undo — state (${captures.join(', ')}) is captured first so an operator can restore it manually.`
      : 'No automatic undo for this step.';

  return {
    does: step.description ?? step.name,
    couldGoWrong,
    undo,
  };
}
