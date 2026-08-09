// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Two-fact service-status checker: what the provider's own status page says,
 * and whether this machine can reach the provider — kept separate all the
 * way to `checkService`'s return value, then combined into one plain-language
 * verdict by `combineVerdict`/`verdictDetail`. Never conflate the two facts
 * earlier than that: a status-page failure is not evidence of an outage, and
 * an unreachable probe on an otherwise-operational provider is evidence about
 * this machine, not about the provider.
 */

import { lookup } from 'node:dns/promises';
import { probeTcpBounded } from '../triage-probes.js';
import { defaultOfflineGate, type OfflineGate } from '../offline-gate.js';
import { parseStatuspageSummary } from './statuspage.js';
import { resolveCatalogEntry, resolveTarget } from './catalog.js';
import type {
  CatalogEntry,
  ProbeOutcome,
  ServiceStatusReport,
  ServiceTarget,
  ServiceVerdict,
  StatusAssessment,
  StatusIncident,
} from './types.js';

// Re-exported for existing callers (down.ts, agent/service-status/*) that
// already need this module's heavier runtime graph. Callers that only need
// name resolution — the config loader, cli/service-targets.ts — import
// straight from catalog.ts instead, so they don't pull in node:dns/promises
// and triage just to resolve a string.
export { resolveTarget };
export type { ServiceTarget };

export interface CheckerDeps {
  fetchImpl?: typeof fetch;
  probeImpl?: (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;
  offlineGate?: OfflineGate;
  /** Default 1500ms — status-page fetch deadline. */
  statusTimeoutMs?: number;
  /**
   * Default 1500ms — a TOTAL deadline across dns.lookup() + the TCP connect,
   * not 1500ms each (1500+1500 would blow scan's 2000ms per-agent budget).
   */
  probeTimeoutMs?: number;
}

/** Services checked at once per `checkServices` call. */
export const CHECK_CONCURRENCY = 5;

const DEFAULT_STATUS_TIMEOUT_MS = 1500;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** Floor for the TCP-connect phase once dns.lookup() has eaten into the total budget. */
const MIN_PROBE_REMAINING_MS = 50;

/**
 * `not_checked` only ever exists on the OfflineGate short-circuit path in
 * `checkService`, which returns before `combineVerdict` is called at all —
 * neither `fetchStatus` nor anything else that feeds `combineVerdict` can
 * produce it. Excluding it from `combineVerdict`'s parameter type (rather
 * than adding a row for it) makes that impossible-by-construction: passing
 * `not_checked` to `combineVerdict` is a compile error, not a runtime row
 * that would have to lie about what verdict "not checked" collapses to.
 */
type CheckedStatusAssessment = Exclude<StatusAssessment, 'not_checked'>;

/**
 * The 9-row verdict table (spec's honesty contract) plus the OfflineGate's
 * distinct `offline_skipped` state, which bypasses this function entirely
 * (see `checkService`). `probe !== 'reachable'` is treated uniformly as
 * "failed" — `dns_failed` and `connect_failed` carry the same verdict weight
 * everywhere in the table.
 */
export function combineVerdict(status: CheckedStatusAssessment, probe: ProbeOutcome): ServiceVerdict {
  const failed = probe !== 'reachable';
  switch (status) {
    case 'incident_reported':
      return 'confirmed_incident';
    case 'degraded_reported':
      return failed ? 'confirmed_incident' : 'degraded_upstream';
    case 'operational':
      return failed ? 'down_for_you' : 'healthy';
    case 'status_unavailable':
      return failed ? 'unreachable_unverified' : 'healthy_unverified';
    case 'no_status_source':
      return failed ? 'unreachable_probe_only' : 'healthy_probe_only';
  }
}

/**
 * Plain-language wording for each verdict, written once so `crisismode down`
 * and the service-status agent never re-invent it. Honesty rules baked in:
 * `status_unavailable`-derived verdicts never say "down for everyone" or
 * otherwise assert an outage, `down_for_you` hedges toward the user's own
 * network rather than asserting certainty, and every probe-only verdict
 * (raw domain, no catalog entry) is labeled "reachability only".
 *
 * `confirmed_incident` is reached by two different table rows
 * (`combineVerdict`): `incident_reported` always, and `degraded_reported` +
 * a failed probe. Only the first is an actual provider-confirmed incident —
 * the second is a provider reporting *degraded* performance plus one
 * machine's failed probe, which is neither "confirmed" nor "everyone".
 * Branch on `statusAssessment` so the wording never claims more than the
 * two source facts actually support.
 */
export function verdictDetail(
  report: Pick<ServiceStatusReport, 'verdict' | 'label' | 'incidents' | 'source' | 'statusAssessment'>,
): string {
  const { verdict, label, statusAssessment } = report;
  switch (verdict) {
    case 'confirmed_incident':
      return statusAssessment === 'degraded_reported'
        ? `${label}'s status page reports degradation and this machine can't reach them — likely a problem on their side.`
        : `${label} is down for everyone — they've confirmed an incident.`;
    case 'degraded_upstream':
      return `${label} is degraded on their side.`;
    case 'healthy':
      return `${label} is healthy and reachable.`;
    case 'down_for_you':
      return `${label} says all clear, but this machine can't reach them — likely your network, DNS, or config.`;
    case 'healthy_unverified':
      return `${label} is reachable; their status page couldn't be checked.`;
    case 'unreachable_unverified':
      return `Can't reach ${label} or its status page — can't tell whose problem it is.`;
    case 'healthy_probe_only':
      return `${label} is reachable; no known status page — reachability only.`;
    case 'unreachable_probe_only':
      return `Can't reach ${label}; no known status page — reachability only, so this may be your network.`;
    case 'offline_skipped':
      return `Skipped — this machine or its network looks offline, so ${label} is not being blamed.`;
  }
}

/**
 * dns.lookup() has no native timeout and delegates to the OS resolver — a
 * black-holed nameserver can block for the system resolver's timeout and
 * retry count, commonly several seconds and up to tens of seconds, blowing
 * the documented total probe budget (CheckerDeps.probeTimeoutMs) by an order
 * of magnitude. Racing a timer against it restores the deadline CONTRACT for
 * the caller — it does not cancel the underlying call. dns.lookup() runs on
 * libuv's threadpool (4 threads by default); a genuinely hung resolver still
 * occupies that thread until the OS eventually gives up, so enough
 * concurrent slow lookups (CHECK_CONCURRENCY is 5) can still saturate the
 * threadpool even though every individual `defaultProbe` call returns on
 * time. A bounded pool size or a resolver with a real cancel path would
 * close that residual gap; out of scope here. A timed-out lookup is reported
 * as `dns_failed`, matching combineVerdict's uniform treatment of
 * `dns_failed`/`connect_failed`.
 */
async function lookupBounded(host: string, timeoutMs: number, lookupImpl: typeof lookup): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('dns lookup timed out')), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([lookupImpl(host), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * DNS resolve, then a bounded plain TCP connect (no TLS handshake — cert
 * problems are the tls agent's job) — the single socket-probe
 * implementation, shared with network-profile.ts and triage.
 * `lookupImpl` defaults to the real `dns.lookup`; the parameter exists so
 * tests can inject a lookup that never resolves and assert the DNS phase is
 * actually bounded, without waiting on a real OS resolver timeout.
 */
export async function defaultProbe(
  host: string,
  port: number,
  timeoutMs: number,
  lookupImpl: typeof lookup = lookup,
): Promise<ProbeOutcome> {
  const start = performance.now();
  try {
    await lookupBounded(host, timeoutMs, lookupImpl);
  } catch {
    return 'dns_failed';
  }
  const elapsed = performance.now() - start;
  const remainingMs = Math.max(MIN_PROBE_REMAINING_MS, timeoutMs - elapsed);
  const result = await probeTcpBounded(host, port, host, remainingMs);
  return result.reachable ? 'reachable' : 'connect_failed';
}

/** Fetches and classifies the status page. No catalog entry -> `no_status_source` without ever calling fetchImpl. */
async function fetchStatus(
  entry: CatalogEntry | undefined,
  fetchImpl: typeof fetch,
  statusTimeoutMs: number,
): Promise<{ assessment: CheckedStatusAssessment; incidents: StatusIncident[] }> {
  if (!entry) return { assessment: 'no_status_source', incidents: [] };
  try {
    const response = await fetchImpl(entry.statusUrl, {
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
 * Check one service: OfflineGate first (short-circuits everything, per the
 * spec's honesty rule 3), then the status fetch and the reachability probe
 * run together via `Promise.allSettled` — neither can throw out of this
 * function, and a rejection on either side degrades to the same "couldn't
 * tell" assessment the fetch/probe would themselves report on failure.
 */
export async function checkService(
  target: ServiceTarget,
  deps: CheckerDeps = {},
): Promise<ServiceStatusReport> {
  const start = performance.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probeImpl = deps.probeImpl ?? defaultProbe;
  const offlineGate = deps.offlineGate ?? defaultOfflineGate;
  const statusTimeoutMs = deps.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const entry = target.entry ?? resolveCatalogEntry(target.id);
  const host = entry?.probeHost ?? target.host ?? target.id;
  const port = entry?.probePort ?? target.port ?? 443;
  const label = entry?.label ?? target.id;
  const source: 'catalog' | 'domain' = entry ? 'catalog' : 'domain';

  // The doc comment above promises neither leg of this function can throw.
  // defaultOfflineGate already catches internally, but CheckerDeps.offlineGate
  // is a public injection point — an injected gate that rejects must not
  // propagate out of checkService, or (inside checkServices) it fails the
  // whole Promise.all and discards every report already computed for the
  // other targets. Treat a gate failure the same way defaultOfflineGate
  // does: fall through to the normal checks.
  let offline: Awaited<ReturnType<OfflineGate>> = null;
  try {
    offline = await offlineGate();
  } catch {
    // A rejected gate call never completes its assignment above, so
    // `offline` is already `null` here — this branch exists only to
    // document that a gate failure is deliberately swallowed, not left to
    // propagate.
  }
  if (offline) {
    return finishReport({
      id: target.id,
      label,
      source,
      host,
      port,
      // Neither fact was checked at all — distinct from 'status_unavailable',
      // which means a fetch was attempted and failed. Never fed into
      // combineVerdict (see CheckedStatusAssessment); the verdict field is
      // what actually carries the offline meaning to callers.
      statusAssessment: 'not_checked',
      incidents: [],
      probe: 'skipped',
      verdict: 'offline_skipped',
      start,
    });
  }

  const [statusSettled, probeSettled] = await Promise.allSettled([
    fetchStatus(entry, fetchImpl, statusTimeoutMs),
    probeImpl(host, port, probeTimeoutMs),
  ]);

  const statusAssessment: CheckedStatusAssessment =
    statusSettled.status === 'fulfilled' ? statusSettled.value.assessment : 'status_unavailable';
  const incidents: StatusIncident[] = statusSettled.status === 'fulfilled' ? statusSettled.value.incidents : [];
  const probe: ProbeOutcome = probeSettled.status === 'fulfilled' ? probeSettled.value : 'connect_failed';
  const verdict = combineVerdict(statusAssessment, probe);

  return finishReport({ id: target.id, label, source, host, port, statusAssessment, incidents, probe, verdict, start });
}

function finishReport(args: {
  id: string;
  label: string;
  source: 'catalog' | 'domain';
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
    detail: verdictDetail({
      verdict: rest.verdict,
      label: rest.label,
      incidents: rest.incidents,
      source: rest.source,
      statusAssessment: rest.statusAssessment,
    }),
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
  };
}

/**
 * Check every target through a small worker pool bounded by
 * CHECK_CONCURRENCY, preserving input order in the result.
 */
export async function checkServices(
  targets: ServiceTarget[],
  deps: CheckerDeps = {},
): Promise<ServiceStatusReport[]> {
  const results: ServiceStatusReport[] = new Array(targets.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.length) {
      const index = next++;
      results[index] = await checkService(targets[index]!, deps);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, worker));
  return results;
}
