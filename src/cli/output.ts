// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Unified output formatting for the CLI.
 * Two modes: pretty terminal (default) and --json for piping.
 */

import chalk from 'chalk';
import { healthStatusColor, signalStatusColor, findingSeverityColor } from './status-presentation.js';
import type { HealthAssessment, HealthStatus, OperatorSummary } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { SynthesisResult } from '../framework/root-cause-synthesis.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { StepResult } from '../types/execution-state.js';
import type { PlanExplanation } from '../framework/ai-explainer.js';
import type { DetectedService } from './detect.js';
import type { NetworkProfile } from '../framework/network-profile.js';
import type { EscalationLevel } from '../framework/escalation.js';
import type { PlainEnglishSummary } from './ai-summary.js';
import { enrichHealth, enrichDiagnosis } from '../framework/signal-explanations.js';
import type { ExplanationContext } from '../framework/signal-explanations.js';
import type { VisibilityReport } from './visibility.js';
import { liveValidatedWatching, bestEffortWatching } from './visibility.js';
import { BEST_EFFORT_GROUP_HINT, BEST_EFFORT_FINDING_SUFFIX } from '../framework/agent-maturity.js';
import { buildRiskFraming } from './risk-framing.js';
import type { TriageReport } from '../framework/triage.js';
import type { ObserverReframe } from './observer-reframe.js';

/**
 * Three output modes:
 *   - human:   colored, interactive, emoji severity indicators (default for TTY)
 *   - pipe:    plain text, no ANSI, tab-separated (auto-detected when stdout is not a TTY)
 *   - machine: structured JSON/JSONL with metadata (--json flag)
 */
export type OutputMode = 'human' | 'pipe' | 'machine';

export interface OutputOptions {
  /** @deprecated Use `mode` instead. Kept for backward compatibility. */
  json: boolean;
  noColor: boolean;
  verbose: boolean;
  mode: OutputMode;
  /** Suppress plain-language explanations, rendering only raw signals. */
  terse: boolean;
}

export let outputOptions: OutputOptions = { json: false, noColor: false, verbose: false, mode: 'human', terse: false };

export function configure(opts: Partial<OutputOptions>): void {
  outputOptions = { ...outputOptions, ...opts };

  // Resolve output mode: explicit --json → machine, otherwise auto-detect TTY
  if (opts.json || opts.mode === 'machine') {
    outputOptions.mode = 'machine';
    outputOptions.json = true;
  } else if (opts.mode) {
    outputOptions.mode = opts.mode;
  } else if (!process.stdout.isTTY) {
    outputOptions.mode = 'pipe';
  } else {
    outputOptions.mode = 'human';
  }

  if (opts.noColor || outputOptions.mode === 'pipe') {
    chalk.level = 0;
  }
}

/**
 * Merge additional output options without touching mode resolution.
 * Unlike `configure`, this never recomputes `mode` from `json`/`mode`/TTY —
 * use it for options (like `terse`) that don't select json/pipe/human mode,
 * so a mode already set via `configure({ json: true })` isn't clobbered.
 */
export function setOutputOptions(opts: Partial<OutputOptions>): void {
  outputOptions = { ...outputOptions, ...opts };
}

/** Get the current output mode. */
export function getOutputMode(): OutputMode {
  return outputOptions.mode;
}

/** Emit one JSONL record in the machine-output shape ({ type, ...data }). */
export function jsonOut(type: string, data: unknown): void {
  console.log(JSON.stringify({ type, ...data as Record<string, unknown> }));
}

function pipeOut(line: string): void {
  console.log(line);
}

// ── Banner ──

export function printBanner(): void {
  if (outputOptions.mode !== 'human') return;
  console.log('');
  console.log(chalk.bold.red('  CrisisMode') + chalk.dim(' — AI-powered infrastructure recovery'));
  console.log('');
}

// ── Detection results ──

export function printDetection(services: DetectedService[]): void {
  if (outputOptions.mode === 'machine') {
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

export function printHealthStatus(assessment: HealthAssessment, ctx?: ExplanationContext): void {
  assessment = enrichHealth(assessment, ctx);
  if (outputOptions.mode === 'machine') {
    jsonOut('health', { assessment });
    return;
  }

  const statusColor = healthStatusColor(assessment.status);

  console.log(chalk.bold('  Health: ') + statusColor(assessment.status) + chalk.dim(` (${(assessment.confidence * 100).toFixed(0)}% confidence)`));
  console.log(chalk.dim(`  ${assessment.summary}`));
  console.log('');

  for (const signal of assessment.signals) {
    const color = signalStatusColor(signal.status);
    console.log(color(`    [${signal.status.toUpperCase()}] `) + chalk.dim(`${signal.source}: ${signal.detail}`));
    if (signal.status !== 'healthy' && signal.explanation) {
      console.log(chalk.dim(`        ${signal.explanation}`));
      if (signal.learnMoreUrl) {
        console.log(chalk.dim(`        Learn more: ${signal.learnMoreUrl}`));
      }
    }
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

export function printDiagnosis(diagnosis: DiagnosisResult, ctx?: ExplanationContext): void {
  diagnosis = enrichDiagnosis(diagnosis, ctx);
  if (outputOptions.mode === 'machine') {
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
    const sevColor = findingSeverityColor(finding.severity);
    console.log(sevColor(`    [${finding.severity.toUpperCase()}] `) + chalk.dim(`${finding.source}: ${finding.observation}`));
    if (finding.severity !== 'info' && finding.explanation) {
      console.log(chalk.dim(`        ${finding.explanation}`));
      if (finding.learnMoreUrl) {
        console.log(chalk.dim(`        Learn more: ${finding.learnMoreUrl}`));
      }
    }
  }
  console.log('');
}

// ── Cross-system synthesis ──

export function printSynthesis(result: SynthesisResult): void {
  if (outputOptions.mode === 'machine') {
    // Machine contract: JSON structure and numeric confidence stable; narrative text
    // intentionally updated to "Possible pattern match:" framing per honesty spec.
    jsonOut('synthesis', { synthesis: result });
    return;
  }
  if (result.clusters.length === 0) return;

  // A correlation rule firing means these signals have co-occurred in this
  // shape before — it is a place to start looking, not a diagnosis. The
  // actionable content is the investigation order; the rule's own wording is
  // demoted to a labelled pattern description, and the numeric confidence
  // (an ordering weight, not odds) is not shown to humans at all.
  console.log(chalk.bold('  Possible pattern match') + chalk.dim(' — investigation hint, not a diagnosis'));
  console.log(chalk.dim(`  ${result.narrative}`));
  console.log('');
  for (const cluster of result.clusters) {
    console.log(
      chalk.cyan('    Investigate in this order: ')
      + chalk.white(cluster.investigationOrder.join(' -> ')),
    );
    console.log(chalk.dim(`    Pattern matched: ${cluster.rootCause}`));
  }
  console.log('');
}

// ── Plan ──

export function printPlan(plan: RecoveryPlan): void {
  if (outputOptions.mode === 'machine') {
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

  for (const [i, s] of plan.steps.entries()) {
    const num = `${i + 1}`.padEnd(4);
    const type = s.type.padEnd(24);
    const risk = s.type === 'system_action'
      ? riskBadge(s.riskLevel)
      : chalk.dim('-'.padEnd(12));
    console.log(chalk.dim('  ') + num + type + risk + s.name);

    const framing = outputOptions.mode === 'human' && !outputOptions.terse ? buildRiskFraming(s, plan.rollbackStrategy) : null;
    if (framing) {
      console.log(chalk.dim(`       what:  ${framing.does}`));
      console.log(chalk.yellow(`       risk:  `) + chalk.dim(framing.couldGoWrong));
      console.log(chalk.dim(`       undo:  ${framing.undo}`));
    }
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
  if (outputOptions.mode === 'machine') {
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
  if (outputOptions.mode === 'machine') {
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
  if (outputOptions.mode === 'machine') {
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
  if (outputOptions.mode === 'machine') {
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

// ── Network profile ──

export function printNetworkProfile(profile: NetworkProfile): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('network', { profile });
    return;
  }

  const modeLabel: Record<string, string> = {
    full: 'Full connectivity',
    private_only: 'Private network only (no internet)',
    isolated: 'Isolated (no network)',
    unknown: 'Unknown',
  };

  const modeColor =
    profile.mode === 'full' ? chalk.green
    : profile.mode === 'private_only' ? chalk.yellow
    : profile.mode === 'isolated' ? chalk.red
    : chalk.dim;

  console.log(chalk.bold('  Network: ') + modeColor(modeLabel[profile.mode] ?? profile.mode));

  if (profile.internet.status === 'unavailable') {
    console.log(chalk.yellow('    AI features will use rule-based fallback (no internet)'));
  }

  if (profile.hub.status !== 'unknown') {
    const hubColor = profile.hub.status === 'available' ? chalk.green : chalk.yellow;
    console.log(chalk.dim('    Hub: ') + hubColor(profile.hub.status));
  }

  if (outputOptions.verbose) {
    if (profile.dns.available) {
      console.log(chalk.dim(`    DNS: OK (${profile.dns.latencyMs}ms)`));
    } else {
      console.log(chalk.yellow(`    DNS: unavailable`));
    }

    for (const probe of [...profile.internet.probes, ...profile.targets.probes]) {
      const icon = probe.reachable ? chalk.green('OK') : chalk.red('FAIL');
      const latency = probe.reachable ? chalk.dim(` (${probe.latencyMs}ms)`) : '';
      const error = probe.error ? chalk.dim(` — ${probe.error}`) : '';
      console.log(chalk.dim(`    ${probe.target}: `) + icon + latency + error);
    }
  }

  console.log('');
}

// ── Generic messages ──

export function printInfo(msg: string): void {
  if (outputOptions.mode === 'machine') return;
  console.log(chalk.dim(`  ${msg}`));
}

export function printSuccess(msg: string): void {
  if (outputOptions.mode === 'machine') return;
  console.log(chalk.green(`  ✓ ${msg}`));
}

export function printWarning(msg: string): void {
  if (outputOptions.mode === 'machine') return;
  console.log(chalk.yellow(`  ! ${msg}`));
}

export function printError(msg: string): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('error', { message: msg });
    return;
  }
  console.error(chalk.red(`  ✗ ${msg}`));
}

// ── Scan summary ──

export interface ScanFinding {
  id: string;
  service: string;
  status: HealthStatus;
  summary: string;
  confidence: number;
  escalationLevel: EscalationLevel;
  signals: Array<{ status: string; detail: string; source?: string; checkId?: string }>;
  /** Plain-language explanation of the dominant signal (static knowledge map). */
  explanation?: string;
  learnMoreUrl?: string;
  /**
   * True when the agent behind this finding has never been validated against
   * real infrastructure. The finding is still a real probe result — it counts
   * in the headline and score — but it is a lead, not a conclusion.
   */
  bestEffort?: true;
  /** Triage attributed this unreachable finding to the observer's own machine/network. */
  possiblyObserverCaused?: true;
  /** Stable id of the check behind the dominant signal (e.g. 'llm-provider.key_valid'). Present only for agents that emit check ids. */
  checkId?: string;
}

export interface RecentChange {
  type: 'container_restart' | 'config_change' | 'deploy';
  description: string;
  detectedAt: string;
}

export interface ScanResult {
  score: number;
  findings: ScanFinding[];
  recentChanges: RecentChange[];
  scannedAt: string;
  durationMs: number;
  /** Copy-pasteable incident summary (present in --json output). */
  summary?: string;
  /** Plain-English AI-generated or fallback summary. */
  aiSummary?: string;
  /** What CrisisMode can see, what it found but can't check, and what's invisible by design. */
  visibility?: VisibilityReport;
  /** Step-0 triage report: is the problem this machine, the network, or the services? */
  triage?: TriageReport;
  /** Present when triage attributed unreachable findings to this machine/network. */
  observerReframe?: ObserverReframe;
}

export function printScanSummary(result: ScanResult): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('scan', { ...result });
    return;
  }

  if (outputOptions.mode === 'pipe') {
    // Tab-separated: score, scanned_at, duration_ms
    pipeOut(`scan\t${result.score}\t${result.scannedAt}\t${result.durationMs}`);
    for (const f of result.findings) {
      pipeOut(`finding\t${f.id}\t${f.service}\t${f.status}\t${f.confidence}\t${f.summary}`);
    }
    return;
  }

  // Human mode — incident-native, grouped by severity
  console.log('');
  const scoreColor = result.score >= 80 ? chalk.green
    : result.score >= 50 ? chalk.yellow
    : chalk.red;
  console.log(chalk.bold('  System Health Score: ') + scoreColor(`${result.score}/100`));
  console.log(chalk.dim(`  Scanned at ${result.scannedAt} (${result.durationMs}ms)`));
  console.log('');

  if (result.findings.length === 0) {
    console.log(chalk.dim('  No services detected. Run with --verbose for details.'));
    console.log('');
    return;
  }

  // Observer reframe — "six services are down" is the wrong headline when the
  // cause is this machine's network. Lead with the cause, collapse the rest.
  const reframe = result.observerReframe;
  const reframedIds = new Set(reframe?.findingIds ?? []);
  if (reframe) {
    console.log(chalk.yellow.bold('  LIKELY THIS MACHINE, NOT YOUR SERVICES'));
    console.log(chalk.yellow(`    ${reframe.headline}`));
    console.log(chalk.dim(`    Next: ${reframe.nextStep}`));
    console.log(chalk.dim(`    Collapsed ${reframe.findingIds.length} unreachable finding(s): ${reframe.findingIds.join(', ')}`));
    console.log(chalk.dim('    Run `crisismode triage` for the per-layer detail.'));
    console.log('');
  }
  const presented = result.findings.filter((f) => !reframedIds.has(f.id));

  // Group findings by severity
  const unhealthy = presented.filter((f) => f.status === 'unhealthy');
  const recovering = presented.filter((f) => f.status === 'recovering');
  const unknown = presented.filter((f) => f.status === 'unknown');
  const healthy = presented.filter((f) => f.status === 'healthy');

  // Unhealthy first — this is what matters during an incident
  if (unhealthy.length > 0) {
    console.log(chalk.red.bold('  UNHEALTHY'));
    printFindingGroup(unhealthy);
    console.log('');
  }

  // Recovering / needs attention
  if (recovering.length > 0) {
    console.log(chalk.yellow.bold('  RECOVERING'));
    printFindingGroup(recovering);
    console.log('');
  }

  // Unknown
  if (unknown.length > 0) {
    console.log(chalk.dim.bold('  UNKNOWN'));
    printFindingGroup(unknown);
    console.log('');
  }

  // Healthy — compact
  if (healthy.length > 0) {
    console.log(chalk.green.bold('  HEALTHY'));
    printFindingGroup(healthy);
    console.log('');
  }

  // Recent changes
  if (result.recentChanges.length > 0) {
    console.log(chalk.cyan.bold('  RECENT CHANGES'));
    for (const change of result.recentChanges) {
      const icon = change.type === 'container_restart' ? chalk.yellow('restart')
        : change.type === 'deploy' ? chalk.cyan('deploy')
        : change.type === 'config_change' ? chalk.magenta('config')
        : chalk.dim('env');
      console.log(`    ${icon}  ${change.description}`);
    }
    console.log('');
  }
}

function printFindingGroup(findings: ScanFinding[]): void {
  for (const f of findings) {
    const statusIcon = healthStatusIcon(f.status);
    console.log(
      chalk.dim('  ') +
      chalk.cyan(f.id.padEnd(12)) +
      statusIcon + ' ' +
      f.service +
      chalk.dim(` — ${f.summary}`),
    );
    if (!outputOptions.terse && f.explanation) {
      console.log(chalk.dim(`      ${f.explanation}`));
      if (f.learnMoreUrl) console.log(chalk.dim(`      Learn more: ${f.learnMoreUrl}`));
    }
    if (!outputOptions.terse && f.bestEffort) {
      console.log(chalk.dim(`      ${BEST_EFFORT_FINDING_SUFFIX}`));
    }
  }
}

function healthStatusIcon(status: HealthStatus): string {
  const label = status === 'healthy' ? 'OK' : status.toUpperCase();
  return healthStatusColor(status)(label);
}

export function printVisibility(report: VisibilityReport): void {
  if (outputOptions.mode === 'machine') {
    jsonOut('visibility', { ...report });
    return;
  }
  if (outputOptions.mode === 'pipe' || outputOptions.terse) return;

  console.log(chalk.bold('  What CrisisMode can see'));

  // Two watching buckets, never one number: only live-validated agents are
  // claimed as watched. Best-effort agents run the same checks but have
  // never been proven against real infrastructure.
  for (const e of liveValidatedWatching(report)) {
    console.log(chalk.green('    watching     ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
  }
  const bestEffort = bestEffortWatching(report);
  for (const e of bestEffort) {
    console.log(chalk.yellow('    best-effort  ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
  }
  if (bestEffort.length > 0) {
    console.log(chalk.dim(`                 ${BEST_EFFORT_GROUP_HINT}`));
  }

  for (const e of report.blocked) {
    console.log(chalk.yellow('    found        ') + `${e.label} ` + chalk.dim(`— ${e.detail}`));
    if (e.hint) console.log(chalk.dim(`                 ${e.hint}`));
  }
  for (const e of report.invisible) {
    console.log(chalk.dim(`    invisible    ${e.label} — ${e.detail}`));
  }
  console.log('');
}

/**
 * One line of context when triage found nothing wrong locally. When triage
 * did localize the problem, the reframe in printScanSummary already says so,
 * and repeating it here would be noise.
 */
export function printTriageContext(report: TriageReport): void {
  if (outputOptions.mode !== 'human') return;
  if (report.verdict !== 'healthy' && report.verdict !== 'remote') return;
  const detail = report.verdict === 'healthy'
    ? 'triage passed — this machine, its DNS, and its internet path look healthy'
    : 'triage passed — this machine and its network are fine; the services did not answer';
  console.log(chalk.dim(`  Network path: ${detail}`));
  console.log('');
}

// ── Plain-English summary ──

export function printPlainEnglishSummary(summary: PlainEnglishSummary): void {
  if (outputOptions.mode !== 'human') return;

  const sourceLabel = summary.source === 'ai' ? chalk.dim(' (AI-generated)') : chalk.dim(' (auto-generated)');
  console.log('');
  console.log(chalk.bold('  Summary') + sourceLabel);
  console.log(`    ${summary.text}`);
  console.log('');
}

// ── Escalation badges ──

const ESCALATION_LABELS: Record<EscalationLevel, string> = {
  1: 'Observe',
  2: 'Diagnose',
  3: 'Suggest',
  4: 'Repair',
  5: 'Repair!',
};

export function escalationBadge(level: EscalationLevel): string {
  const label = ESCALATION_LABELS[level];
  switch (level) {
    case 1: return chalk.dim(label);
    case 2: return chalk.blue(label);
    case 3: return chalk.cyan(label);
    case 4: return chalk.yellow(label);
    case 5: return chalk.red(label);
  }
}

// ── Next action suggestions ──

export function printNextAction(message: string): void {
  if (outputOptions.mode === 'machine') return;
  if (outputOptions.mode === 'pipe') return;
  console.log(chalk.cyan('  → ') + chalk.white(message));
  console.log('');
}
