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
 * The exit code for a set of findings: OK unless something is actually
 * wrong. Worst status wins.
 */
export function severityExitCode(statuses: Iterable<HealthStatus>): ExitCode {
  for (const status of statuses) {
    if (HEALTH_STATUS_EXIT_CODE[status] === ExitCode.UNHEALTHY) return ExitCode.UNHEALTHY;
  }
  return ExitCode.OK;
}

/**
 * Exhaustive: readiness's own verdict vocabulary → the same contract.
 * `at-risk` maps to UNHEALTHY for the same reason `recovering` does — the
 * report is telling you something will break, and a CI gate asking "is this
 * stack ready" wants that to fail. `unknown` (nothing could be evaluated)
 * is OK, matching the health mapping above.
 */
export const READINESS_VERDICT_EXIT_CODE: Record<ReadinessReport['verdict'], ExitCode> = {
  ready: ExitCode.OK,
  unknown: ExitCode.OK,
  'at-risk': ExitCode.UNHEALTHY,
  'not-ready': ExitCode.UNHEALTHY,
};

export function readinessExitCode(verdict: ReadinessReport['verdict']): ExitCode {
  return READINESS_VERDICT_EXIT_CODE[verdict] ?? ExitCode.OK;
}
