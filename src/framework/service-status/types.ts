// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/** One unresolved incident from a provider's status page. */
export interface StatusIncident {
  title: string;
  impact: string;
  url?: string;
}

/** What the provider's own status source reports. NEVER conflated with reachability. */
export type StatusAssessment =
  | 'incident_reported'
  | 'degraded_reported'
  | 'operational'
  | 'status_unavailable'
  | 'no_status_source';

/** Parsed Statuspage-v2 summary. */
export interface StatusPageAssessment {
  assessment: Exclude<StatusAssessment, 'status_unavailable' | 'no_status_source'>;
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
