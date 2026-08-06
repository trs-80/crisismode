// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode triage` — is it me, my network, or them?
 *
 * Deterministic, dependency-free localization. Works with no internet and no
 * API key. Read-only (escalation level 2: Diagnose).
 *
 * Exit codes: 0 when this machine is not the problem (healthy, remote),
 * 1 when it might be (local, network, mixed) — so scripts can branch.
 */

import chalk from 'chalk';
import { runTriage } from '../../framework/triage.js';
import { getEscalationInfo } from '../../framework/escalation.js';
import { getOutputMode, jsonOut, outputOptions, printBanner, printWarning } from '../output.js';
import { triageVerdictColor } from '../status-presentation.js';
import { discoverStack } from '../autodiscovery.js';
import { ConfigNotFoundError, loadConfigWithDetection } from '../../config/loader.js';
import type { TriageLayerStatus, TriageReport, TriageTarget, TriageVerdict } from '../../framework/triage.js';

export interface TriageCommandOptions {
  configPath?: string | undefined;
}

/** Exhaustive: adding a layer status must fail compilation here. */
const LAYER_ICON: Record<TriageLayerStatus, string> = {
  pass: '✅', fail: '🔴', unknown: '❔', skipped: '·',
};

const VERDICT_HEADLINE: Record<TriageVerdict, string> = {
  local: 'Verdict: local — the problem looks like this machine',
  network: 'Verdict: network — the problem looks like the network this machine is on',
  remote: 'Verdict: remote — this machine and its network are fine',
  mixed: 'Verdict: mixed — triage could not localize the problem',
  healthy: 'Verdict: healthy — nothing local or network-level is wrong',
};

/** 0 when this machine is not the problem, 1 when it might be. */
export function triageExitCode(verdict: TriageVerdict): 0 | 1 {
  return verdict === 'healthy' || verdict === 'remote' ? 0 : 1;
}

export function renderTriageReport(report: TriageReport): string[] {
  const escalation = getEscalationInfo(report.escalationLevel);
  const lines: string[] = [];
  // The verdict is the headline — bold + severity color, matching how
  // printScanSummary renders the health score (output.ts:512). These lines
  // are printed with console.log in runTriageCommand's human branch, not
  // printInfo — printInfo wraps every line in chalk.dim, which would gray
  // out this feature's flagship plain-language explanation and next step.
  // chalk emits nothing when --no-color or pipe mode set chalk.level = 0, so
  // substring assertions in tests are unaffected.
  lines.push(chalk.bold(triageVerdictColor(report.verdict)(VERDICT_HEADLINE[report.verdict])));
  // --terse suppresses the plain-language explanation and next-step lines,
  // matching how scan/demo/recover honor it (output.ts) — the verdict
  // headline stays either way.
  if (!outputOptions.terse) {
    lines.push(report.explanation);
    lines.push(`Next: ${report.nextStep}`);
  }
  lines.push('');
  lines.push('Layers checked:');
  for (const layer of report.layers) {
    lines.push(`  ${LAYER_ICON[layer.status]} ${layer.layer} — ${layer.detail}`);
  }
  lines.push('');
  lines.push(`Observer: ${report.observerContext} (${report.observerContextEvidence})`);
  lines.push(`Escalation: ${escalation.label} — ${escalation.description}`);
  lines.push(`Checked at ${report.checkedAt} (${report.durationMs}ms)`);
  return lines;
}

export function renderTriagePipe(report: TriageReport): string[] {
  const lines = [`triage\t${report.verdict}\t${report.checkedAt}\t${report.durationMs}`];
  for (const layer of report.layers) {
    lines.push(`layer\t${layer.layer}\t${layer.status}\t${layer.detail}`);
  }
  return lines;
}

/**
 * Hard cap on resolved targets, mirroring Stage 4's own `MAX_STAGE4_TARGETS`
 * in `runTriage`. A large config or a noisy autodiscovery result could
 * otherwise hand Stage 4 an unbounded list; capping here means the operator
 * finds out *why* targets were dropped (below) instead of just seeing a
 * truncated report.
 */
const MAX_TRIAGE_TARGETS = 20;

/**
 * Targets for layer 6: configured targets first (their names are what the
 * operator recognizes), then autodiscovered services that aren't already
 * covered, deduped by host:port, capped at `MAX_TRIAGE_TARGETS`.
 */
export async function resolveTriageTargets(configPath?: string): Promise<TriageTarget[]> {
  const byEndpoint = new Map<string, TriageTarget>();

  let configured: TriageTarget[] = [];
  try {
    const { config } = loadConfigWithDetection(configPath !== undefined ? { configPath } : {});
    configured = (config?.targets ?? [])
      .filter((t) => t.primary !== undefined)
      .map((t) => ({ host: t.primary!.host, port: t.primary!.port, label: t.name }));
  } catch (err) {
    // An explicitly named config file that doesn't exist is a user error.
    if (err instanceof ConfigNotFoundError) throw err;
  }
  for (const target of configured) {
    byEndpoint.set(`${target.host}:${target.port}`, target);
  }

  const profile = await discoverStack();
  for (const service of profile.services) {
    if (!service.detected) continue;
    const key = `${service.host}:${service.port}`;
    if (!byEndpoint.has(key)) {
      byEndpoint.set(key, { host: service.host, port: service.port, label: service.kind });
    }
  }

  const all = [...byEndpoint.values()];
  if (all.length > MAX_TRIAGE_TARGETS) {
    const omitted = all.length - MAX_TRIAGE_TARGETS;
    // Configured targets were inserted first, so the truncation below keeps
    // them over autodiscovered ones.
    printWarning(
      `${omitted} target(s) omitted from triage — probing only the first ${MAX_TRIAGE_TARGETS} (configured targets take priority).`,
    );
    return all.slice(0, MAX_TRIAGE_TARGETS);
  }
  return all;
}

export async function runTriageCommand(opts: TriageCommandOptions = {}): Promise<number> {
  const targets = await resolveTriageTargets(opts.configPath);
  const report = await runTriage({ targets });

  const mode = getOutputMode();
  if (mode === 'machine') {
    jsonOut('triage', report);
  } else if (mode === 'pipe') {
    for (const line of renderTriagePipe(report)) console.log(line);
  } else {
    printBanner();
    // console.log, not printInfo — printInfo dims every line (chalk.dim),
    // which would gray out the explanation and next-step lines below.
    for (const line of renderTriageReport(report)) console.log(line);
  }

  const code = triageExitCode(report.verdict);
  process.exitCode = code;
  return code;
}
