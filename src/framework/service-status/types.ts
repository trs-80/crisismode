// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/** One unresolved incident from a provider's status page. */
export interface StatusIncident {
  title: string;
  impact: string;
  url?: string;
}

/**
 * What the provider's own status source reports. NEVER conflated with
 * reachability. `not_checked` is distinct from `status_unavailable`: the
 * latter means a fetch was attempted and failed (their status page is
 * flaky), the former means no fetch was attempted at all (OfflineGate
 * short-circuited before either fact was gathered) — machine-readable
 * consumers (`crisismode down --json`) need to tell those apart.
 */
export type StatusAssessment =
  | 'incident_reported'
  | 'degraded_reported'
  | 'operational'
  | 'status_unavailable'
  | 'no_status_source'
  | 'not_checked';

/** Parsed Statuspage-v2 summary. */
export interface StatusPageAssessment {
  assessment: Exclude<StatusAssessment, 'status_unavailable' | 'no_status_source' | 'not_checked'>;
  incidents: StatusIncident[];
  /** Statuspage overall indicator ('none' | 'minor' | 'major' | 'critical'), or 'unknown'. */
  indicator: string;
}

/** Reachability of the service from this machine. */
export type ProbeOutcome = 'reachable' | 'dns_failed' | 'connect_failed';

/** Combined plain-language verdict (spec's 9-row table + offline gate). */
export type ServiceVerdict =
  | 'confirmed_incident'
  | 'degraded_upstream'
  | 'healthy'
  | 'down_for_you'
  | 'healthy_unverified'
  | 'unreachable_unverified'
  | 'healthy_probe_only'
  | 'unreachable_probe_only'
  | 'offline_skipped';

/** A service in the curated catalog, with known probe host and status endpoint. */
export interface CatalogEntry {
  id: string;
  label: string;
  probeHost: string;
  probePort: number;
  statusUrl: string;
  statusFormat: 'statuspage_v2';
}

/**
 * A raw config entry (catalog id/alias, or an explicit host) resolved into
 * something `checkService`/`checkServices` (checker.ts) can check. Lives
 * here rather than in checker.ts so `resolveTarget()` (catalog.ts) can
 * return it without importing checker.ts's runtime dependencies
 * (node:dns/promises, triage) — every command loads the config layer at
 * startup, and those deps have no business being on that path.
 */
export interface ServiceTarget {
  id: string;
  host?: string;
  port?: number;
  /**
   * Pre-resolved catalog entry, bypassing `resolveCatalogEntry(id)`. Set by
   * `resolveTarget()` on a catalog hit (skipping a redundant second lookup)
   * and by callers with a status source that isn't in `SERVICE_CATALOG`
   * (e.g. `crisismode down`'s llm-provider routing).
   */
  entry?: CatalogEntry;
}

export interface ServiceStatusReport {
  /** Catalog id, or the raw domain for unknown services. */
  id: string;
  label: string;
  source: 'catalog' | 'domain';
  host: string;
  port: number;
  statusAssessment: StatusAssessment;
  incidents: StatusIncident[];
  probe: ProbeOutcome | 'skipped';
  verdict: ServiceVerdict;
  /** Plain-language one-liner, spec wording. */
  detail: string;
  checkedAt: string;
  durationMs: number;
}
