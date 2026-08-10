// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Single source for status → terminal color across every rendering surface
 * (CLI output, demo display). Slack emoji/label tables live with the Slack
 * formatter but are keyed on the same HealthStatus union, so adding a status
 * fails compilation everywhere a presentation is missing.
 */

import chalk, { type ChalkInstance } from 'chalk';
import { ExitCode } from './exit-codes.js';
import type { HealthStatus, HealthSignalStatus } from '../types/health.js';
import type { DiagnosisFinding } from '../types/diagnosis-result.js';
import type { TriageVerdict } from '../framework/triage.js';
import type { ReadinessReport } from '../readiness/types.js';

export const HEALTH_STATUS_COLOR: Record<HealthStatus, ChalkInstance> = {
  healthy: chalk.green,
  recovering: chalk.yellow,
  unhealthy: chalk.red,
  unknown: chalk.dim,
};

export const SIGNAL_STATUS_COLOR: Record<HealthSignalStatus, ChalkInstance> = {
  healthy: chalk.green,
  warning: chalk.yellow,
  critical: chalk.red,
  unknown: chalk.dim,
};

export const FINDING_SEVERITY_COLOR: Record<DiagnosisFinding['severity'], ChalkInstance> = {
  info: chalk.dim,
  warning: chalk.yellow,
  critical: chalk.red,
};

export function healthStatusColor(status: HealthStatus): ChalkInstance {
  return HEALTH_STATUS_COLOR[status] ?? chalk.dim;
}

export function signalStatusColor(status: HealthSignalStatus): ChalkInstance {
  return SIGNAL_STATUS_COLOR[status] ?? chalk.dim;
}

export function findingSeverityColor(severity: DiagnosisFinding['severity']): ChalkInstance {
  return FINDING_SEVERITY_COLOR[severity] ?? chalk.dim;
}

export const TRIAGE_VERDICT_COLOR: Record<TriageVerdict, ChalkInstance> = {
  local: chalk.red,
  network: chalk.red,
  mixed: chalk.yellow,
  remote: chalk.cyan,
  healthy: chalk.green,
};

export function triageVerdictColor(verdict: TriageVerdict): ChalkInstance {
  return TRIAGE_VERDICT_COLOR[verdict] ?? chalk.dim;
}

/**
 * Exhaustive: a health status → the exit code a command reporting it must
 * return. It lives here, next to the color/label maps, because it is the
 * same kind of thing — one more presentation of a `HealthStatus`, for the
 * one consumer that is a shell rather than a human — and because adding a
 * status must fail compilation in every place a presentation is missing.
 *
 * `unknown` is deliberately OK: it means "CrisisMode could not check this"
 * (no agent registered for the kind, a probe that timed out), not "this is
 * broken". Exiting non-zero on it would make every `crisismode && deploy`
 * chain fail for a service nobody asked CrisisMode to watch.
 */
export const HEALTH_STATUS_EXIT_CODE: Record<HealthStatus, ExitCode> = {
  healthy: ExitCode.OK,
  recovering: ExitCode.UNHEALTHY,
  unhealthy: ExitCode.UNHEALTHY,
  unknown: ExitCode.OK,
};

/**
 * The exit code for a set of findings.
 *
 * Worst status wins, with one extra rule: if every finding evaluated came
 * back `unknown`, the answer is `INDETERMINATE` (3) rather than `OK` —
 * CrisisMode determined nothing, and a CI gate must not read that as health.
 *
 * Three boundaries are deliberate:
 *
 * - **A definite answer beats "could not check".** `['unhealthy', 'unknown']`
 *   is UNHEALTHY, not INDETERMINATE. Something real was measured and it was
 *   bad news.
 * - **Partial unknown stays OK.** Nine healthy findings plus one unknown is
 *   OK. Failing a deploy for one unmeasurable signal is the cliff this code
 *   exists to avoid; INDETERMINATE is for "nothing at all", not "not
 *   everything".
 * - **An empty set is OK, not INDETERMINATE.** `[].every()` is vacuously
 *   true, so the all-unknown check is guarded on a non-empty set. A scan with
 *   no findings had nothing to observe, which is a different situation from
 *   having targets that could not be observed; the no-config onboarding path
 *   already guides that case, and reporting 3 for `--category nonexistent`
 *   would be actively misleading.
 */
export function severityExitCode(statuses: Iterable<HealthStatus>): ExitCode {
  let evaluated = 0;
  let unknown = 0;
  for (const status of statuses) {
    evaluated++;
    if (HEALTH_STATUS_EXIT_CODE[status] === ExitCode.UNHEALTHY) return ExitCode.UNHEALTHY;
    if (status === 'unknown') unknown++;
  }
  if (evaluated > 0 && unknown === evaluated) return ExitCode.INDETERMINATE;
  return ExitCode.OK;
}

/**
 * Exhaustive: readiness's own verdict vocabulary → the same contract.
 * `at-risk` maps to UNHEALTHY for the same reason `recovering` does — the
 * report is telling you something will break, and a CI gate asking "is this
 * stack ready" wants that to fail. `unknown` means no rule could be
 * evaluated, which is INDETERMINATE for the same reason an all-unknown scan
 * is: the run produced no evidence either way, and the readiness report
 * already aggregates exactly this as `evaluated` / `unknown`.
 */
export const READINESS_VERDICT_EXIT_CODE: Record<ReadinessReport['verdict'], ExitCode> = {
  ready: ExitCode.OK,
  unknown: ExitCode.INDETERMINATE,
  'at-risk': ExitCode.UNHEALTHY,
  'not-ready': ExitCode.UNHEALTHY,
};

/**
 * The Record above is exhaustive, so the fallback is unreachable today. It
 * defaults to INDETERMINATE rather than OK deliberately: if the verdict union
 * ever grows, a code CrisisMode has no mapping for means it does not know how
 * the run went, and reporting success for that is a fail-open default inside
 * the exit-code layer itself — the one place it is least likely to be noticed.
 */
export function readinessExitCode(verdict: ReadinessReport['verdict']): ExitCode {
  return READINESS_VERDICT_EXIT_CODE[verdict] ?? ExitCode.INDETERMINATE;
}
