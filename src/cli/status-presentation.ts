// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Single source for status → terminal color across every rendering surface
 * (CLI output, demo display). Slack emoji/label tables live with the Slack
 * formatter but are keyed on the same HealthStatus union, so adding a status
 * fails compilation everywhere a presentation is missing.
 */

import chalk, { type ChalkInstance } from 'chalk';
import type { HealthStatus, HealthSignalStatus } from '../types/health.js';
import type { DiagnosisFinding } from '../types/diagnosis-result.js';

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
