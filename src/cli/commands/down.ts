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
  resolveTarget,
  type CheckerDeps,
  type ServiceTarget,
} from '../../framework/service-status/checker.js';
import { getProviderSpec, type LlmProviderSpec } from '../../agent/llm-provider/provider-table.js';
import { resolveCatalogEntry } from '../../framework/service-status/catalog.js';
import { loadConfigWithDetection, ConfigNotFoundError, ConfigValidationError, HOSTNAME_PATTERN } from '../../config/loader.js';
import { getOutputMode, jsonOut, outputOptions, printBanner } from '../output.js';
import { healthStatusColor } from '../status-presentation.js';
import { ExitCode } from '../exit-codes.js';
import type { ServiceConfigEntry } from '../../config/schema.js';
import type { ServiceStatusReport, ServiceVerdict } from '../../framework/service-status/types.js';
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
 *
 * A second exhaustive `Record<ServiceVerdict, HealthStatus>` exists at
 * `src/agent/service-status/verdict-rank.ts` (`HEALTH_STATUS_BY_VERDICT`),
 * for the service-status agent's `assessHealth()`. The two intentionally
 * diverge on one row — `healthy_unverified` reads `'healthy'` here (this
 * command's exit code and color; Task 5's brief wants a green line for
 * "reachable but unverified") but `'recovering'` there (Task 6's brief pins
 * that a status page that couldn't be checked keeps the agent's health
 * assessment shy of a clean bill). Keep the two in sync deliberately, not by
 * accident, if you touch either.
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
 *
 * A narrower classifier, `isUnreachableVerdict` (`src/agent/service-status/
 * verdict-rank.ts`), answers a different question — "did this machine fail
 * to reach the service" — and is a strict subset of this one (it excludes
 * `confirmed_incident`/`degraded_upstream`, which are failures this command
 * cares about but the agent's reachability count does not). Kept separate on
 * purpose: collapsing them would blur "is this worth telling a script" and
 * "is this a reachability problem specifically."
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
 * Medium 4: a positional that resolves to neither a catalog id/alias nor a
 * statuspage-capable llm-provider id is treated as a raw domain and handed
 * straight to DNS — so a URL (`http://api.foo.com/path`) used to DNS-fail
 * into a "may be your network" reachability line instead of the spec'd
 * usage error (spec line 118: "2 usage errors (unknown flag, invalid
 * domain)"). The config path already enforces `HOSTNAME_PATTERN` at load
 * time via loader.ts's `validateServices`; this is the ad-hoc-arg
 * equivalent, checked before any network call.
 */
function isValidAdHocServiceId(id: string): boolean {
  if (statuspageProviderSpec(id) !== undefined) return true;
  if (resolveCatalogEntry(id) !== undefined) return true;
  return HOSTNAME_PATTERN.test(id);
}

/**
 * `down anthropic` / `down openai`: Task 2's catalog deliberately excludes
 * these ids (spec line 66's "exactly one owner per provider's status
 * endpoint" — the llm-provider agent already owns them), so falling through
 * to raw-domain handling would DNS-fail on a host literally named
 * "anthropic". This builds the `ServiceTarget` checker.ts's own
 * `checkService` needs, with a synthetic `entry` carrying the provider's
 * `apiHost`/`statusUrl` — `target.entry ?? resolveCatalogEntry(target.id)`
 * (checker.ts) uses it in place of a `SERVICE_CATALOG` lookup, so the real
 * `checkService`/`checkServices` run unmodified; no orchestration logic is
 * reimplemented here.
 */
function providerAsTarget(spec: LlmProviderSpec): ServiceTarget {
  return {
    id: spec.id,
    host: spec.apiHost,
    port: 443,
    entry: {
      id: spec.id,
      label: spec.label,
      probeHost: spec.apiHost,
      probePort: 443,
      statusUrl: spec.statusUrl!,
      statusFormat: 'statuspage_v2',
    },
  };
}

/** A statuspage_v2-shaped provider spec for `id`, or undefined if `id` isn't one. */
function statuspageProviderSpec(id: string): LlmProviderSpec | undefined {
  const spec = getProviderSpec(id.toLowerCase());
  return spec?.statusUrl !== undefined && spec.statusFormat === 'statuspage_v2' ? spec : undefined;
}

/**
 * Resolves every entry — llm-provider ids (anthropic, openai) to a synthetic
 * `entry`, everything else via the Task 3 checker's own `resolveTarget` —
 * then checks all of them in one `checkServices` call, so there is exactly
 * one concurrency-bounded check path regardless of where a target came from.
 */
async function checkAllServices(entries: readonly ServiceConfigEntry[], deps: CheckerDeps): Promise<ServiceStatusReport[]> {
  const targets: ServiceTarget[] = entries.map((entry) => {
    const spec = typeof entry === 'string' ? statuspageProviderSpec(entry) : undefined;
    return spec ? providerAsTarget(spec) : resolveTarget(entry);
  });
  return checkServices(targets, deps);
}

export interface RunDownCommandDeps extends CheckerDeps {
  /** Injectable for tests; defaults to config/loader.js's loadConfigWithDetection. */
  loadConfig?: typeof loadConfigWithDetection;
  /** Already extracted by index.ts's global `--config` parsing. */
  configPath?: string | undefined;
}

/**
 * `serviceIds` are positionals only — flags have already been parsed and
 * validated by `cli/args.ts`. This command used to be handed the raw argv
 * and re-parse it privately (`parseDownArgs`, deleted), because index.ts's
 * global `parseArgs({ strict: false })` silently accepted any unrecognized
 * flag. That workaround fixed one call site; `args.ts` now rejects unknown
 * flags — and a value-taking flag with a missing or flag-like value, which
 * is where `down --config` / `down --config --terse` were caught — for every
 * command, so `down`'s exit-2 contract is unchanged and no longer private.
 */
export async function runDownCommand(serviceIds: readonly string[], deps: RunDownCommandDeps = {}): Promise<ExitCode> {
  let entries: readonly ServiceConfigEntry[];
  if (serviceIds.length > 0) {
    const badArg = serviceIds.find((id) => !isValidAdHocServiceId(id));
    if (badArg !== undefined) {
      console.error(
        `crisismode down: invalid service argument '${badArg}' — expected a catalog id/alias or a bare domain ` +
        '(no scheme, path, or spaces).',
      );
      console.error('Usage: crisismode down [<service>...] [--config <path>] [--json] [--terse] [--no-color] [--verbose]');
      return ExitCode.USAGE;
    }
    entries = serviceIds;
  } else {
    const loadConfigFn = deps.loadConfig ?? loadConfigWithDetection;
    let configured: ServiceConfigEntry[] = [];
    try {
      const { config } = loadConfigFn(deps.configPath !== undefined ? { configPath: deps.configPath } : {});
      configured = config?.services ?? [];
    } catch (err) {
      // A config file that doesn't exist, or one that exists but is
      // invalid, is a user error — propagate it rather than falling through
      // to "no services configured" (mirrors resolveTriageTargets in
      // triage.ts for the not-found case).
      if (err instanceof ConfigNotFoundError || err instanceof ConfigValidationError) throw err;
    }
    if (configured.length === 0) {
      printDownUsage();
      return ExitCode.OK;
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

  return downExitCode(reports);
}
