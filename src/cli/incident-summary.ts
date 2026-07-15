// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Incident summary artifact — a concise, copy-pasteable summary
 * suitable for Slack, incident channels, or postmortem docs.
 *
 * Formats: timestamp, what was found, severity, what was tried,
 * what's recommended next.
 */

import chalk from 'chalk';
import type { ScanFinding, ScanResult } from './output.js';
import type { HealthStatus } from '../types/health.js';

export interface IncidentSummary {
  /** ISO timestamp of the summary */
  timestamp: string;
  /** Overall health score (0-100) */
  score: number;
  /** One-line status for the whole system */
  headline: string;
  /** Findings grouped by severity */
  critical: SummaryFinding[];
  warning: SummaryFinding[];
  healthy: SummaryFinding[];
  /** Concrete next steps */
  nextSteps: string[];
  /** Duration of the scan/diagnose run */
  durationMs: number;
}

export interface SummaryFinding {
  id: string;
  service: string;
  status: HealthStatus;
  summary: string;
}

/**
 * Build an incident summary from scan results.
 */
export function buildIncidentSummary(result: ScanResult): IncidentSummary {
  const critical: SummaryFinding[] = [];
  const warning: SummaryFinding[] = [];
  const healthy: SummaryFinding[] = [];

  for (const f of result.findings) {
    const entry: SummaryFinding = {
      id: f.id,
      service: f.service,
      status: f.status,
      summary: f.summary,
    };

    if (f.status === 'unhealthy') {
      critical.push(entry);
    } else if (f.status === 'recovering' || f.status === 'unknown') {
      warning.push(entry);
    } else {
      healthy.push(entry);
    }
  }

  const headline = buildHeadline(result.score, critical.length, warning.length, result.findings.length);
  const nextSteps = buildNextSteps(critical, warning, result.findings);

  return {
    timestamp: result.scannedAt,
    score: result.score,
    headline,
    critical,
    warning,
    healthy,
    nextSteps,
    durationMs: result.durationMs,
  };
}

function buildHeadline(
  score: number,
  criticalCount: number,
  warningCount: number,
  totalCount: number,
): string {
  if (criticalCount > 0) {
    const svc = criticalCount === 1 ? 'service' : 'services';
    return `${criticalCount} ${svc} unhealthy out of ${totalCount} checked (score: ${score}/100)`;
  }
  if (warningCount > 0) {
    const svc = warningCount === 1 ? 'service' : 'services';
    return `${warningCount} ${svc} need attention out of ${totalCount} checked (score: ${score}/100)`;
  }
  return `All ${totalCount} services healthy (score: ${score}/100)`;
}

function buildNextSteps(
  critical: SummaryFinding[],
  warning: SummaryFinding[],
  allFindings: ScanFinding[],
): string[] {
  const steps: string[] = [];

  if (critical.length > 0) {
    const first = critical[0]!;
    steps.push(`Investigate: \`crisismode diagnose ${first.id}\``);
    if (critical.length > 1) {
      steps.push(`${critical.length - 1} more unhealthy — diagnose each before attempting recovery`);
    }
    steps.push('When ready to fix: `crisismode recover`');
  } else if (warning.length > 0) {
    const unknowns = warning.filter((w) => w.status === 'unknown');
    if (unknowns.length === warning.length) {
      steps.push('Could not reach some services — try: `crisismode scan --verbose`');
    } else {
      steps.push('Services recovering — monitor with: `crisismode watch`');
    }
  } else if (allFindings.length > 0) {
    steps.push('All systems healthy. Monitor with: `crisismode watch`');
  }

  return steps;
}

/**
 * Print the incident summary to the terminal in human-readable format.
 */
export function printIncidentSummary(summary: IncidentSummary): void {
  console.log('');
  console.log(chalk.bold('  --- Incident Summary (paste into Slack/incident channel) ---'));
  console.log('');
  console.log(chalk.dim(`  Time: ${summary.timestamp}`));
  console.log(chalk.dim(`  Scan completed in ${formatDuration(summary.durationMs)}`));
  console.log('');

  // Headline
  const headlineColor = summary.critical.length > 0 ? chalk.red
    : summary.warning.length > 0 ? chalk.yellow
    : chalk.green;
  console.log(headlineColor(`  ${summary.headline}`));
  console.log('');

  // Critical findings
  if (summary.critical.length > 0) {
    console.log(chalk.red.bold('  UNHEALTHY:'));
    for (const f of summary.critical) {
      console.log(chalk.red(`    [${f.id}] ${f.service} — ${f.summary}`));
    }
    console.log('');
  }

  // Warning findings
  if (summary.warning.length > 0) {
    console.log(chalk.yellow.bold('  NEEDS ATTENTION:'));
    for (const f of summary.warning) {
      console.log(chalk.yellow(`    [${f.id}] ${f.service} — ${f.summary}`));
    }
    console.log('');
  }

  // Healthy (compact)
  if (summary.healthy.length > 0) {
    const names = summary.healthy.map((f) => f.service).join(', ');
    console.log(chalk.green(`  OK: ${names}`));
    console.log('');
  }

  // Next steps
  if (summary.nextSteps.length > 0) {
    console.log(chalk.cyan.bold('  NEXT STEPS:'));
    for (const step of summary.nextSteps) {
      console.log(chalk.cyan(`    -> ${step}`));
    }
    console.log('');
  }
}

/**
 * Format the incident summary as plain text for Slack/pasting.
 */
export function formatIncidentSummaryText(summary: IncidentSummary): string {
  const lines: string[] = [];

  lines.push(`--- CrisisMode Scan Summary ---`);
  lines.push(`Time: ${summary.timestamp} (${formatDuration(summary.durationMs)})`);
  lines.push(`${summary.headline}`);
  lines.push('');

  if (summary.critical.length > 0) {
    lines.push('UNHEALTHY:');
    for (const f of summary.critical) {
      lines.push(`  [${f.id}] ${f.service} — ${f.summary}`);
    }
    lines.push('');
  }

  if (summary.warning.length > 0) {
    lines.push('NEEDS ATTENTION:');
    for (const f of summary.warning) {
      lines.push(`  [${f.id}] ${f.service} — ${f.summary}`);
    }
    lines.push('');
  }

  if (summary.healthy.length > 0) {
    const names = summary.healthy.map((f) => f.service).join(', ');
    lines.push(`OK: ${names}`);
    lines.push('');
  }

  if (summary.nextSteps.length > 0) {
    lines.push('NEXT STEPS:');
    for (const step of summary.nextSteps) {
      lines.push(`  -> ${step}`);
    }
  }

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
