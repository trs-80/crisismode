// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Single source of truth for combining the `ServiceVerdict`s across the
 * services one agent instance checks (in practice exactly one — see
 * registration.ts): which verdict is worst, which failure scenario name it
 * maps to, and which HealthStatus it maps to. Shared by the simulator and
 * live client's `evaluateCheck()` (`service_verdict` / `unreachable_service_count`)
 * and by the agent's `assessHealth()`/`diagnose()` — defined once so the
 * ranking used to answer "is this bad" cannot drift between those call sites.
 */

import type { HealthStatus } from '../../types/health.js';
import type { ServiceStatusReport, ServiceVerdict } from '../../framework/service-status/types.js';

/** Worst-first rank. Higher = worse. */
const VERDICT_RANK: Record<ServiceVerdict, number> = {
  confirmed_incident: 5,
  degraded_upstream: 4,
  down_for_you: 3,
  unreachable_unverified: 3,
  unreachable_probe_only: 3,
  healthy_unverified: 1,
  healthy: 0,
  healthy_probe_only: 0,
  // Never actually the worst in practice: the agent's OfflineGate
  // short-circuit (agent.ts) returns before the backend is ever called while
  // offline, so no report reaching this function can carry this verdict.
  // Ranked below 'healthy' defensively rather than omitted, so the map stays
  // exhaustive against the ServiceVerdict union.
  offline_skipped: -1,
};

/** The worst (highest-ranked) verdict across every report. `healthy` when `reports` is empty. */
export function worstVerdict(reports: readonly ServiceStatusReport[]): ServiceVerdict {
  let worst: ServiceVerdict = 'healthy';
  for (const report of reports) {
    if (VERDICT_RANK[report.verdict] > VERDICT_RANK[worst]) worst = report.verdict;
  }
  return worst;
}

/** Verdicts where this machine could not reach the service, whether or not the provider confirmed an incident. */
export function isUnreachableVerdict(verdict: ServiceVerdict): boolean {
  return verdict === 'down_for_you' || verdict === 'unreachable_unverified' || verdict === 'unreachable_probe_only';
}

/**
 * assessHealth's HealthStatus for the worst verdict across configured
 * services: healthy -> healthy; degraded_upstream/healthy_unverified ->
 * recovering; confirmed_incident/down_for_you/unreachable-family -> unhealthy.
 * `healthy_probe_only` groups with healthy (reachable is all that was ever
 * checkable — there is no status source to be uncertain about);
 * `unreachable_probe_only` groups with the unreachable family.
 */
export const HEALTH_STATUS_BY_VERDICT: Record<ServiceVerdict, HealthStatus> = {
  healthy: 'healthy',
  healthy_probe_only: 'healthy',
  degraded_upstream: 'recovering',
  healthy_unverified: 'recovering',
  confirmed_incident: 'unhealthy',
  down_for_you: 'unhealthy',
  unreachable_unverified: 'unhealthy',
  unreachable_probe_only: 'unhealthy',
  // Never reached — see the comment on VERDICT_RANK.
  offline_skipped: 'unknown',
};

export type ServiceStatusScenario =
  | 'dependency_incident'
  | 'dependency_degraded'
  | 'dependency_unreachable';

/**
 * diagnose()'s failure scenario for the worst verdict across configured
 * services (ordering: incident > degraded > unreachable > healthy). `null`
 * means nothing actionable was found (the worst verdict is a healthy
 * variant) — diagnose() reports that as a null scenario, and plan() defaults
 * a null scenario to 'no_finding', exactly as the llm-provider and
 * vector-store agents do.
 */
export const SCENARIO_BY_VERDICT: Record<ServiceVerdict, ServiceStatusScenario | null> = {
  confirmed_incident: 'dependency_incident',
  degraded_upstream: 'dependency_degraded',
  down_for_you: 'dependency_unreachable',
  unreachable_unverified: 'dependency_unreachable',
  unreachable_probe_only: 'dependency_unreachable',
  healthy: null,
  healthy_unverified: null,
  healthy_probe_only: null,
  offline_skipped: null,
};
