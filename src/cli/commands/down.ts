// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode down [<service>...]` — is it down for everyone, or just me?
 *
 * The ad-hoc, user-facing surface over the Task 3 service-status checker: a
 * quick "is $THING down" check for services that aren't part of a
 * `crisismode.yaml` target (Stripe, GitHub, Vercel, an LLM provider, ...).
 * Read-only (escalation level 2: Diagnose).
 *
 * Exit codes: 0 when nothing checked looks like a problem, 1 when at least
 * one service does (script-friendly), 2 when the command itself was called
 * wrong (unrecognized flag) — the only command in this CLI that does.
 */

import chalk from 'chalk';
import {
  checkServices,
  combineVerdict,
  resolveTarget,
  verdictDetail,
  type CheckerDeps,
  type ServiceTarget,
} from '../../framework/service-status/checker.js';
import { parseStatuspageSummary } from '../../framework/service-status/statuspage.js';
import { probeTcpBounded } from '../../framework/triage-probes.js';
import { defaultOfflineGate } from '../../framework/offline-gate.js';
import { getProviderSpec, type LlmProviderSpec } from '../../agent/llm-provider/provider-table.js';
import { loadConfigWithDetection, ConfigNotFoundError } from '../../config/loader.js';
import { getOutputMode, jsonOut, outputOptions, printBanner } from '../output.js';
import { healthStatusColor } from '../status-presentation.js';
import type { ServiceConfigEntry } from '../../config/schema.js';
import type {
  ProbeOutcome,
  ServiceStatusReport,
  ServiceVerdict,
  StatusAssessment,
  StatusIncident,
} from '../../framework/service-status/types.js';
import type { HealthStatus } from '../../types/health.js';

/**
 * Interactive ceiling for a command a human is waiting on, well below scan's
 * per-agent budget but generous enough for a slow status page — checkService
 * runs the status fetch and the reachability probe in parallel, so this is
 * the total wall-clock cost per service, not per-phase.
 */
export const DOWN_TIMEOUT_MS = 3500;

/** Exhaustive: adding a verdict must fail compilation here. */
const VERDICT_ICON: Record<ServiceVerdict, string> = {
  confirmed_incident: '🔴',
  degraded_upstream: '🟡',
  healthy: '✅',
  down_for_you: '🟠',
  healthy_unverified: '✅',
  unreachable_unverified: '❔',
  healthy_probe_only: '✅',
  unreachable_probe_only: '❔',
  offline_skipped: '·',
};

/**
 * Exhaustive: maps each verdict to the closest HealthStatus so this command
 * reuses status-presentation.ts's color map instead of inventing its own.
 */
const VERDICT_HEALTH_STATUS: Record<ServiceVerdict, HealthStatus> = {
  confirmed_incident: 'unhealthy',
  degraded_upstream: 'recovering',
  healthy: 'healthy',
  down_for_you: 'unhealthy',
  healthy_unverified: 'healthy',
  unreachable_unverified: 'unhealthy',
  healthy_probe_only: 'healthy',
  unreachable_probe_only: 'unhealthy',
  offline_skipped: 'unknown',
};

/**
 * Exhaustive: whether a verdict should make `crisismode down` exit 1.
 * `offline_skipped` never counts — the honesty rule is that skipping a check
 * because this machine looks offline is not evidence that the service is
 * down. `healthy*` verdicts never count. Everything else is a reason a
 * script watching this exit code should care.
 */
function isFailureVerdict(verdict: ServiceVerdict): boolean {
  switch (verdict) {
    case 'confirmed_incident':
    case 'degraded_upstream':
    case 'down_for_you':
    case 'unreachable_unverified':
    case 'unreachable_probe_only':
      return true;
    case 'healthy':
    case 'healthy_unverified':
    case 'healthy_probe_only':
    case 'offline_skipped':
      return false;
  }
}

/** 0 when nothing checked looks like a problem, 1 when at least one service does. */
export function downExitCode(reports: readonly ServiceStatusReport[]): 0 | 1 {
  return reports.some((r) => isFailureVerdict(r.verdict)) ? 1 : 0;
}

export function renderDownReportLines(report: ServiceStatusReport): string[] {
  const icon = VERDICT_ICON[report.verdict];
  const color = healthStatusColor(VERDICT_HEALTH_STATUS[report.verdict]);
  const lines: string[] = [`  ${icon} ${color(report.label)} ${chalk.dim(`(${report.verdict})`)}`];
  if (!outputOptions.terse) {
    // Verbatim from the checker — verdictDetail is the single place this
    // wording is written, shared with the (Task 6) scan agent.
    lines.push(`      ${report.detail}`);
    if (report.verdict === 'down_for_you') {
      lines.push('      Run `crisismode triage` to check whether this is your machine or network.');
    }
  }
  for (const incident of report.incidents) {
    lines.push(`        - ${incident.title}`);
  }
  return lines;
}

export function renderDownHuman(reports: readonly ServiceStatusReport[]): string[] {
  return reports.flatMap((r) => renderDownReportLines(r));
}

/** Tab-separated `id verdict statusAssessment probe detail`, no ANSI. */
export function renderDownPipeLine(report: ServiceStatusReport): string {
  const detail = report.detail.replace(/[\t\n\r]+/g, ' ');
  return `${report.id}\t${report.verdict}\t${report.statusAssessment}\t${report.probe}\t${detail}`;
}

function printDownUsage(): void {
  const mode = getOutputMode();
  const message =
    'No services configured to check. Usage: crisismode down <service> [<service>...] ' +
    '— or add a "services:" list to crisismode.yaml.';
  if (mode === 'machine') {
    jsonOut('down', { services: [], message });
    return;
  }
  printBanner();
  console.log('  No services configured to check.');
  console.log('');
  console.log('  Usage: crisismode down <service> [<service>...]');
  console.log('  Or add a "services:" list to crisismode.yaml, e.g.:');
  console.log('    services:');
  console.log('      - stripe');
  console.log('      - github');
  console.log('');
}

/**
 * Flags this command recognizes on its own raw args (not the global
 * parser's `values`) — `--config` is a known two-token flag here so its
 * value isn't mistaken for a service id or an unrecognized flag; the actual
 * path comes from `deps.configPath`, already extracted by index.ts's global
 * parser, so there is exactly one place that turns `--config <path>` into a
 * string.
 */
const KNOWN_DOWN_FLAGS = new Set(['--json', '--terse', '--no-color', '--verbose', '-h', '--help']);

interface ParsedDownArgs {
  serviceIds: string[];
}

/**
 * index.ts's global `parseArgs({ strict: false })` silently accepts any
 * `--flag` it doesn't recognize into `values` — it never throws, so nothing
 * in this CLI has ever exited 2 before. `down` is the first command to
 * validate its own flags: this scans the raw args index.ts hands it (before
 * that lossy global parse) for a `-`/`--` token outside the known set.
 */
export function parseDownArgs(args: readonly string[]): ParsedDownArgs | { unknownFlag: string } {
  const serviceIds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config') {
      i++; // skip its value
      continue;
    }
    if (arg.startsWith('--config=')) continue;
    if (KNOWN_DOWN_FLAGS.has(arg)) continue;
    if (arg.startsWith('-')) return { unknownFlag: arg };
    serviceIds.push(arg);
  }
  return { serviceIds };
}

/**
 * `not_checked` only exists on the offline-gate short-circuit path — see
 * checker.ts's identically-named local type for the reasoning. Duplicated
 * here (not exported from checker.ts) because it's purely a parameter-type
 * narrowing, not shared behavior.
 */
type CheckedAssessment = Exclude<StatusAssessment, 'not_checked'>;

/** DNS resolve, then a bounded TCP+TLS connect — mirrors checker.ts's private defaultProbe. */
async function defaultProviderProbe(host: string, port: number, timeoutMs: number): Promise<ProbeOutcome> {
  const { lookup } = await import('node:dns/promises');
  const start = performance.now();
  try {
    await lookup(host);
  } catch {
    return 'dns_failed';
  }
  const elapsed = performance.now() - start;
  const remainingMs = Math.max(50, timeoutMs - elapsed);
  const result = await probeTcpBounded(host, port, host, remainingMs);
  return result.reachable ? 'reachable' : 'connect_failed';
}

async function fetchProviderStatus(
  spec: LlmProviderSpec,
  fetchImpl: typeof fetch,
  statusTimeoutMs: number,
): Promise<{ assessment: CheckedAssessment; incidents: StatusIncident[] }> {
  try {
    const response = await fetchImpl(spec.statusUrl!, {
      signal: AbortSignal.timeout(statusTimeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { assessment: 'status_unavailable', incidents: [] };
    const body: unknown = await response.json();
    const parsed = parseStatuspageSummary(body);
    if (!parsed) return { assessment: 'status_unavailable', incidents: [] };
    return { assessment: parsed.assessment, incidents: parsed.incidents };
  } catch {
    return { assessment: 'status_unavailable', incidents: [] };
  }
}

/**
 * `down anthropic` / `down openai`: Task 2's catalog deliberately excludes
 * these ids (spec line 66's "exactly one owner per provider's status
 * endpoint" — the llm-provider agent already owns them), so falling through
 * to raw-domain handling would DNS-fail on a host literally named
 * "anthropic". This resolves the id through llm-provider's provider table
 * instead and reuses the Task 1 Statuspage parser against that provider's
 * own `statusUrl`, mirroring checker.ts's checkService for everything except
 * where the catalog entry comes from.
 */
async function checkProviderService(spec: LlmProviderSpec, deps: CheckerDeps): Promise<ServiceStatusReport> {
  const start = performance.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probeImpl = deps.probeImpl ?? defaultProviderProbe;
  const offlineGate = deps.offlineGate ?? defaultOfflineGate;
  const statusTimeoutMs = deps.statusTimeoutMs ?? DOWN_TIMEOUT_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DOWN_TIMEOUT_MS;

  const host = spec.apiHost;
  const port = 443;
  const label = spec.label;

  const offline = await offlineGate();
  if (offline) {
    return finishProviderReport({
      id: spec.id,
      label,
      host,
      port,
      statusAssessment: 'not_checked',
      incidents: [],
      probe: 'skipped',
      verdict: 'offline_skipped',
      start,
    });
  }

  const [statusSettled, probeSettled] = await Promise.allSettled([
    fetchProviderStatus(spec, fetchImpl, statusTimeoutMs),
    probeImpl(host, port, probeTimeoutMs),
  ]);

  const statusAssessment: CheckedAssessment =
    statusSettled.status === 'fulfilled' ? statusSettled.value.assessment : 'status_unavailable';
  const incidents: StatusIncident[] = statusSettled.status === 'fulfilled' ? statusSettled.value.incidents : [];
  const probe: ProbeOutcome = probeSettled.status === 'fulfilled' ? probeSettled.value : 'connect_failed';
  const verdict = combineVerdict(statusAssessment, probe);

  return finishProviderReport({ id: spec.id, label, host, port, statusAssessment, incidents, probe, verdict, start });
}

function finishProviderReport(args: {
  id: string;
  label: string;
  host: string;
  port: number;
  statusAssessment: StatusAssessment;
  incidents: StatusIncident[];
  probe: ProbeOutcome | 'skipped';
  verdict: ServiceVerdict;
  start: number;
}): ServiceStatusReport {
  const { start, ...rest } = args;
  return {
    ...rest,
    // Has a known status source, same as a curated catalog entry — just
    // sourced from llm-provider's table instead of service-status/catalog.ts.
    source: 'catalog',
    detail: verdictDetail({ verdict: rest.verdict, label: rest.label, incidents: rest.incidents, source: 'catalog' }),
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
  };
}

/** A statuspage_v2-shaped provider spec for `id`, or undefined if `id` isn't one. */
function statuspageProviderSpec(id: string): LlmProviderSpec | undefined {
  const spec = getProviderSpec(id.toLowerCase());
  return spec?.statusUrl !== undefined && spec.statusFormat === 'statuspage_v2' ? spec : undefined;
}

/**
 * Checks every entry, routing llm-provider ids (anthropic, openai) through
 * `checkProviderService` and everything else through the Task 3 checker's
 * own concurrency-bounded `checkServices`, then reassembles both groups in
 * the caller's original order.
 */
async function checkAllServices(entries: readonly ServiceConfigEntry[], deps: CheckerDeps): Promise<ServiceStatusReport[]> {
  const results: ServiceStatusReport[] = new Array(entries.length);
  const catalogTargets: Array<{ index: number; target: ServiceTarget }> = [];
  const providerChecks: Array<{ index: number; spec: LlmProviderSpec }> = [];

  entries.forEach((entry, index) => {
    const spec = typeof entry === 'string' ? statuspageProviderSpec(entry) : undefined;
    if (spec) {
      providerChecks.push({ index, spec });
    } else {
      catalogTargets.push({ index, target: resolveTarget(entry) });
    }
  });

  if (catalogTargets.length > 0) {
    const reports = await checkServices(catalogTargets.map((t) => t.target), deps);
    catalogTargets.forEach((t, i) => {
      results[t.index] = reports[i]!;
    });
  }

  const providerReports = await Promise.all(providerChecks.map((p) => checkProviderService(p.spec, deps)));
  providerChecks.forEach((p, i) => {
    results[p.index] = providerReports[i]!;
  });

  return results;
}

export interface RunDownCommandDeps extends CheckerDeps {
  /** Injectable for tests; defaults to config/loader.js's loadConfigWithDetection. */
  loadConfig?: typeof loadConfigWithDetection;
  /** Already extracted by index.ts's global `--config` parsing. */
  configPath?: string | undefined;
}

export async function runDownCommand(args: readonly string[], deps: RunDownCommandDeps = {}): Promise<number> {
  const parsed = parseDownArgs(args);
  if ('unknownFlag' in parsed) {
    console.error(`crisismode down: unrecognized option '${parsed.unknownFlag}'`);
    console.error('Usage: crisismode down [<service>...] [--config <path>] [--json] [--terse] [--no-color] [--verbose]');
    process.exitCode = 2;
    return 2;
  }

  let entries: readonly ServiceConfigEntry[];
  if (parsed.serviceIds.length > 0) {
    entries = parsed.serviceIds;
  } else {
    const loadConfigFn = deps.loadConfig ?? loadConfigWithDetection;
    let configured: ServiceConfigEntry[] = [];
    try {
      const { config } = loadConfigFn(deps.configPath !== undefined ? { configPath: deps.configPath } : {});
      configured = config?.services ?? [];
    } catch (err) {
      // An explicitly named config file that doesn't exist is a user error —
      // propagate it (mirrors resolveTriageTargets in triage.ts).
      if (err instanceof ConfigNotFoundError) throw err;
    }
    if (configured.length === 0) {
      printDownUsage();
      process.exitCode = 0;
      return 0;
    }
    entries = configured;
  }

  const checkerDeps: CheckerDeps = {
    ...deps,
    statusTimeoutMs: deps.statusTimeoutMs ?? DOWN_TIMEOUT_MS,
    probeTimeoutMs: deps.probeTimeoutMs ?? DOWN_TIMEOUT_MS,
  };
  const reports = await checkAllServices(entries, checkerDeps);

  const mode = getOutputMode();
  if (mode === 'machine') {
    for (const report of reports) jsonOut('down', report);
  } else if (mode === 'pipe') {
    for (const report of reports) console.log(renderDownPipeLine(report));
  } else {
    printBanner();
    for (const line of renderDownHuman(reports)) console.log(line);
  }

  const code = downExitCode(reports);
  process.exitCode = code;
  return code;
}
