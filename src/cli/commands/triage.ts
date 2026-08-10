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
import type { ExitCode } from '../exit-codes.js';
import { discoverStack } from '../autodiscovery.js';
import { ConfigNotFoundError, ConfigValidationError, loadConfigWithDetection } from '../../config/loader.js';
import { resolveTarget } from '../../framework/service-status/catalog.js';
import type { TriageLayerStatus, TriageReport, TriageTarget, TriageVerdict } from '../../framework/triage.js';
import type { ServiceConfigEntry } from '../../config/schema.js';
// Type-only: a local/network triage run must never pull in checker.ts's
// runtime graph (node:dns/promises, triage-probes) just to name its type —
// the real implementation is dynamic-imported in enrichWithServiceStatus,
// only on the remote/mixed path that actually needs it.
import type { checkServices, ServiceTarget } from '../../framework/service-status/checker.js';
import type { ServiceStatusReport } from '../../framework/service-status/types.js';

export interface TriageCommandOptions {
  configPath?: string | undefined;
  /** Injection seam for tests; defaults to the real checker.ts implementation, dynamic-imported. */
  checkServices?: typeof checkServices;
  /** Injection seam for tests; defaults to reading `services:` from the resolved config. */
  loadServices?: () => ServiceConfigEntry[];
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
    // A config file that doesn't exist, or one that exists but is invalid
    // (including the services:/targets: name-collision check), is a user
    // error — propagate it rather than silently falling through to
    // autodiscovery (mirrors down.ts's resolveDownTargets for the same case).
    if (err instanceof ConfigNotFoundError || err instanceof ConfigValidationError) throw err;
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

/** Shared status-page fetch deadline for the enrichment pass below. */
const SERVICE_STATUS_TIMEOUT_MS = 1500;

/**
 * Hard cap on services checked during triage enrichment, mirroring
 * `resolveTriageTargets`'s `MAX_TRIAGE_TARGETS` for the same reason: an
 * unbounded `services:` list must not turn an optional status-page
 * annotation into an unbounded wall-time cost. `checkServices` bounds
 * concurrency and each fetch is bounded by `SERVICE_STATUS_TIMEOUT_MS`, but
 * the pass as a whole was not — with N services the added wall time is
 * `ceil(N / CHECK_CONCURRENCY) * SERVICE_STATUS_TIMEOUT_MS`.
 */
const MAX_ENRICHMENT_SERVICES = 10;

/**
 * Reads `services:` from the resolved config, mirroring down.ts's
 * resolveDownTargets for the same load. A config that fails to load here
 * would already have failed identically in resolveTriageTargets above
 * (same configPath, same loader) and thrown before this ever runs; the
 * error handling exists for defense, not because it is expected to fire.
 */
function defaultLoadServices(configPath?: string): ServiceConfigEntry[] {
  try {
    const { config } = loadConfigWithDetection(configPath !== undefined ? { configPath } : {});
    return config?.services ?? [];
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigValidationError) throw err;
    return [];
  }
}

/** No-op reachability probe — triage has already probed connectivity (layer 6); this pass only fetches status pages. */
async function noopProbe(): Promise<'reachable'> {
  return 'reachable';
}

/** One line per service whose status page reports something other than operational. Pure. */
export function serviceStatusEnrichmentLines(reports: readonly ServiceStatusReport[]): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    const title = report.incidents[0]?.title;
    if (report.statusAssessment === 'incident_reported') {
      lines.push(
        title
          ? `${report.label}'s status page reports an incident: ${title}`
          : `${report.label}'s status page reports an incident.`,
      );
    } else if (report.statusAssessment === 'degraded_reported') {
      lines.push(
        title
          ? `${report.label}'s status page reports degraded performance: ${title}`
          : `${report.label}'s status page reports degraded performance.`,
      );
    }
  }
  return lines;
}

/**
 * Enrichment at the command layer, not in framework/triage.ts (which stays
 * pure): when the verdict points away from this machine, name which
 * configured service's status page explains why. `checkServices` is
 * dynamic-imported so a plain local/network/healthy triage run — the common
 * case — never pulls in checker.ts's heavier runtime graph.
 */
async function enrichWithServiceStatus(
  services: readonly ServiceConfigEntry[],
  checkServicesImpl?: typeof checkServices,
): Promise<string[]> {
  const impl = checkServicesImpl ?? (await import('../../framework/service-status/checker.js')).checkServices;
  const capped = services.slice(0, MAX_ENRICHMENT_SERVICES);
  const targets: ServiceTarget[] = capped.map((entry) => resolveTarget(entry));
  const reports = await impl(targets, {
    // Triage already probed reachability (layer 6/targets) — this pass is
    // status-fetch only, per the spec's honesty rule against re-asserting a
    // fact already gathered.
    probeImpl: noopProbe,
    statusTimeoutMs: SERVICE_STATUS_TIMEOUT_MS,
  });
  const lines = serviceStatusEnrichmentLines(reports);
  const omitted = services.length - capped.length;
  if (omitted > 0) {
    lines.push(
      `(${omitted} more configured service(s) not checked — showing status for the first ${MAX_ENRICHMENT_SERVICES}.)`,
    );
  }
  return lines;
}

export async function runTriageCommand(opts: TriageCommandOptions = {}): Promise<ExitCode> {
  const targets = await resolveTriageTargets(opts.configPath);
  const report = await runTriage({ targets });

  // Never for local/network/healthy — only remote/mixed point away from this
  // machine, where naming the culprit service is useful rather than noise.
  let serviceLines: string[] = [];
  if (report.verdict === 'remote' || report.verdict === 'mixed') {
    // Enrichment is an annotation on an already-computed report. A failure
    // here (the dynamic import failing, or resolveTarget throwing on a
    // malformed services: entry) must never cost the operator the report
    // itself or its exit code — print nothing and move on.
    // defaultLoadServices intentionally rethrows ConfigNotFoundError and
    // ConfigValidationError, but resolveTriageTargets above already loaded
    // the same configPath and would have thrown those first — reaching this
    // catch means something else went wrong, not a swallowed config error.
    try {
      const loadServices = opts.loadServices ?? (() => defaultLoadServices(opts.configPath));
      const services = loadServices();
      if (services.length > 0) {
        serviceLines = await enrichWithServiceStatus(services, opts.checkServices);
      }
    } catch {
      serviceLines = [];
    }
  }

  const mode = getOutputMode();
  if (mode === 'machine') {
    jsonOut('triage', serviceLines.length > 0 ? { ...report, serviceStatusNotes: serviceLines } : report);
  } else if (mode === 'pipe') {
    for (const line of renderTriagePipe(report)) console.log(line);
    for (const line of serviceLines) console.log(`service-status\t${line}`);
  } else {
    printBanner();
    // console.log, not printInfo — printInfo dims every line (chalk.dim),
    // which would gray out the explanation and next-step lines below.
    for (const line of renderTriageReport(report)) console.log(line);
    for (const line of serviceLines) console.log(line);
  }

  // Returned, not assigned — run.ts is the only place that writes
  // process.exitCode. `triage`'s observable contract is unchanged: 1 when
  // the verdict is local/network/mixed, as CLAUDE.md documents.
  return triageExitCode(report.verdict);
}
