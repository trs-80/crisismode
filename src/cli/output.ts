// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Unified output formatting for the CLI.
 * Two modes: pretty terminal (default) and --json for piping.
 */

import chalk from 'chalk';
import type { HealthAssessment, OperatorSummary } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { StepResult } from '../types/execution-state.js';
import type { PlanExplanation } from '../framework/ai-explainer.js';
import type { DetectedService } from './detect.js';

export interface OutputOptions {
  json: boolean;
  noColor: boolean;
  verbose: boolean;
}

let outputOptions: OutputOptions = { json: false, noColor: false, verbose: false };

export function configure(opts: Partial<OutputOptions>): void {
  outputOptions = { ...outputOptions, ...opts };
  if (opts.noColor) {
    chalk.level = 0;
  }
}

function jsonOut(type: string, data: unknown): void {
  console.log(JSON.stringify({ type, ...data as Record<string, unknown> }));
}

// ── Banner ──

export function printBanner(): void {
  if (outputOptions.json) return;
  console.log('');
  console.log(chalk.bold.red('  CrisisMode') + chalk.dim(' — AI-powered infrastructure recovery'));
  console.log('');
}

// ── Detection results ──

export function printDetection(services: DetectedService[]): void {
  if (outputOptions.json) {
    jsonOut('detection', { services });
    return;
  }

  const detected = services.filter((s) => s.detected);
  const notDetected = services.filter((s) => !s.detected);

  if (detected.length > 0) {
    console.log(chalk.bold('  Detected services:'));
    for (const s of detected) {
      console.log(chalk.green(`    ✓ ${s.kind}`) + chalk.dim(` at ${s.host}:${s.port}`));
    }
  }

  if (outputOptions.verbose && notDetected.length > 0) {
    console.log(chalk.dim('  Not detected:'));
    for (const s of notDetected) {
      console.log(chalk.dim(`    · ${s.kind} (${s.host}:${s.port})`));
    }
  }
  console.log('');
}

// ── Health status ──

export function printHealthStatus(assessment: HealthAssessment): void {
  if (outputOptions.json) {
    jsonOut('health', { assessment });
    return;
  }

  const statusColor =
    assessment.status === 'healthy' ? chalk.green
    : assessment.status === 'recovering' ? chalk.yellow
    : assessment.status === 'unhealthy' ? chalk.red
    : chalk.dim;

  console.log(chalk.bold('  Health: ') + statusColor(assessment.status) + chalk.dim(` (${(assessment.confidence * 100).toFixed(0)}% confidence)`));
  console.log(chalk.dim(`  ${assessment.summary}`));
  console.log('');

  for (const signal of assessment.signals) {
    const color =
      signal.status === 'critical' ? chalk.red
      : signal.status === 'warning' ? chalk.yellow
      : signal.status === 'healthy' ? chalk.green
      : chalk.dim;
    console.log(color(`    [${signal.status.toUpperCase()}] `) + chalk.dim(`${signal.source}: ${signal.detail}`));
  }

  if (assessment.recommendedActions.length > 0) {
    console.log('');
    console.log(chalk.cyan('  Recommendations:'));
    for (const action of assessment.recommendedActions) {
      console.log(chalk.dim(`    - ${action}`));
    }
  }
  console.log('');
}

// ── Diagnosis ──

export function printDiagnosis(diagnosis: DiagnosisResult): void {
  if (outputOptions.json) {
    jsonOut('diagnosis', { diagnosis });
    return;
  }

  const statusColor = diagnosis.status === 'identified' ? chalk.green : chalk.yellow;
  console.log(chalk.bold('  Diagnosis: ') + statusColor(diagnosis.status));
  console.log(chalk.dim(`  Scenario:   ${diagnosis.scenario}`));
  console.log(chalk.dim(`  Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%`));

  const rootCause = diagnosis.findings[0]?.data?.root_cause;
  if (rootCause) {
    console.log('');
    console.log(chalk.cyan('  Root cause: ') + chalk.white(String(rootCause)));
  }

  const recommendations = diagnosis.findings[0]?.data?.recommendations;
  if (Array.isArray(recommendations) && recommendations.length > 0) {
    console.log('');
    console.log(chalk.cyan('  Recommendations:'));
    for (const rec of recommendations) {
      console.log(chalk.dim(`    - ${rec}`));
    }
  }

  console.log('');
  for (const finding of diagnosis.findings) {
    const sevColor =
      finding.severity === 'critical' ? chalk.red
      : finding.severity === 'warning' ? chalk.yellow
      : chalk.dim;
    console.log(sevColor(`    [${finding.severity.toUpperCase()}] `) + chalk.dim(`${finding.source}: ${finding.observation}`));
  }
  console.log('');
}

// ── Plan ──

export function printPlan(plan: RecoveryPlan): void {
  if (outputOptions.json) {
    jsonOut('plan', { plan });
    return;
  }

  console.log(chalk.bold('  Recovery Plan'));
  console.log(chalk.dim(`  Duration: ${plan.metadata.estimatedDuration} | Rollback: ${plan.rollbackStrategy.type}`));
  console.log(chalk.dim(`  ${plan.metadata.summary}`));
  console.log('');

  console.log(
    chalk.dim('  ') +
    chalk.bold('#'.padEnd(4)) +
    chalk.bold('Type'.padEnd(24)) +
    chalk.bold('Risk'.padEnd(12)) +
    chalk.bold('Name'),
  );
  console.log(chalk.dim('  ' + '-'.repeat(68)));

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const num = `${i + 1}`.padEnd(4);
    const type = s.type.padEnd(24);
    const risk = s.type === 'system_action'
      ? riskBadge(s.riskLevel)
      : chalk.dim('-'.padEnd(12));
    console.log(chalk.dim('  ') + num + type + risk + s.name);
  }
  console.log('');
}

function riskBadge(risk: string): string {
  switch (risk) {
    case 'routine': return chalk.green(risk.padEnd(12));
    case 'elevated': return chalk.yellow(risk.padEnd(12));
    case 'high': return chalk.red(risk.padEnd(12));
    case 'critical': return chalk.bgRed.white(risk.padEnd(12));
    default: return risk.padEnd(12);
  }
}

// ── Plan Explanation ──

export function printPlanExplanation(explanation: PlanExplanation): void {
  if (outputOptions.json) {
    jsonOut('plan_explanation', { explanation });
    return;
  }

  const sourceLabel = explanation.source === 'ai' ? 'AI-Generated' : 'Structural';
  console.log(chalk.cyan(`  Plan Explanation (${sourceLabel}):`));
  console.log(chalk.white(`  ${explanation.summary}`));
  console.log('');

  if (explanation.risks.length > 0) {
    console.log(chalk.yellow('  Risks:'));
    for (const risk of explanation.risks) {
      console.log(chalk.yellow(`    - ${risk}`));
    }
    console.log('');
  }
}

// ── Results ──

export function printResults(results: StepResult[]): void {
  if (outputOptions.json) {
    jsonOut('results', { results });
    return;
  }

  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  console.log(chalk.bold('  Results: ') +
    chalk.green(`${succeeded} succeeded`) + ', ' +
    (failed > 0 ? chalk.red(`${failed} failed`) : chalk.dim(`${failed} failed`)) + ', ' +
    chalk.dim(`${skipped} skipped`));
  console.log('');
}

// ── Operator Summary ──

export function printOperatorSummary(summary: OperatorSummary): void {
  if (outputOptions.json) {
    jsonOut('operator_summary', { summary });
    return;
  }

  console.log(chalk.bold('  Operator Summary'));
  console.log(chalk.dim(`  State:     ${summary.currentState}`));
  console.log(chalk.dim(`  Action:    ${summary.actionRequired}`));
  console.log(chalk.dim(`  Summary:   ${summary.summary}`));
  console.log(chalk.dim(`  Next step: ${summary.recommendedNextStep}`));

  if (summary.validationBlockers.length > 0) {
    console.log('');
    console.log(chalk.red('  Blockers:'));
    for (const b of summary.validationBlockers) {
      console.log(chalk.red(`    - ${b}`));
    }
  }
  console.log('');
}

// ── Status table ──

export function printStatus(services: Array<{ kind: string; host: string; port: number; status: 'up' | 'down' | 'degraded' }>): void {
  if (outputOptions.json) {
    jsonOut('status', { services });
    return;
  }

  for (const s of services) {
    const icon = s.status === 'up' ? chalk.green('UP')
      : s.status === 'degraded' ? chalk.yellow('DEGRADED')
      : chalk.red('DOWN');
    console.log(`  ${icon}  ${s.kind.padEnd(14)} ${s.host}:${s.port}`);
  }
  console.log('');
}

// ── Generic messages ──

export function printInfo(msg: string): void {
  if (outputOptions.json) return;
  console.log(chalk.dim(`  ${msg}`));
}

export function printSuccess(msg: string): void {
  if (outputOptions.json) return;
  console.log(chalk.green(`  ✓ ${msg}`));
}

export function printWarning(msg: string): void {
  if (outputOptions.json) return;
  console.log(chalk.yellow(`  ! ${msg}`));
}

export function printError(msg: string): void {
  if (outputOptions.json) {
    jsonOut('error', { message: msg });
    return;
  }
  console.error(chalk.red(`  ✗ ${msg}`));
}
