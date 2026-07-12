// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Environment guard — distinguishes "the service is broken" from "the
 * machine running crisismode is broken" before an unreachable verdict
 * ships to the operator.
 *
 * Consumes the NetworkProfile captured at startup and post-processes
 * DiagnosisResults that blame a target for being unreachable:
 *   1. Target hostname fails DNS resolution -> reclassify as
 *      'target_unresolvable' (DNS/config problem, service state unknown).
 *   2. Startup TCP probe reached the target -> connection failure is
 *      service-level; verdict stands.
 *   3. Observer's own DNS/internet is degraded -> downgrade confidence
 *      and prepend an environment_check finding so the operator checks
 *      their own machine first.
 */

import type { DiagnosisResult, NetworkProfile } from '../types/index.js';

const NAME_RESOLUTION_ERRORS = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i;
const UNREACHABLE_SCENARIOS = /unreachable|connection_refused|connection_failure/i;

export interface EnvironmentVerdict {
  /** true when the observer's own environment is a plausible cause */
  suspect: boolean;
  /** plain-English reasons, safe to show operators verbatim */
  reasons: string[];
}

export function assessEnvironment(profile: NetworkProfile | null): EnvironmentVerdict {
  if (!profile) return { suspect: false, reasons: [] };
  const reasons: string[] = [];
  if (!profile.dns.available) {
    reasons.push('This machine cannot resolve DNS names (resolver probe failed at startup).');
  }
  if (profile.internet.status === 'unavailable') {
    reasons.push('This machine cannot reach the internet (all egress probes failed).');
  }
  if (profile.mode === 'isolated') {
    reasons.push('The network profile classified this host as isolated (no working network).');
  }
  return { suspect: reasons.length > 0, reasons };
}

export function applyEnvironmentGuard(
  diagnosis: DiagnosisResult,
  profile: NetworkProfile | null,
  targetName?: string,
): DiagnosisResult {
  if (!UNREACHABLE_SCENARIOS.test(diagnosis.scenario ?? '')) return diagnosis;

  const label = targetName ?? 'the target';

  // Case 1: hostname does not resolve — DNS/config problem, not proof the
  // service is down. Any finding may carry the resolution error, not just
  // the first — agents can emit multiple findings and ordering is not
  // contractual.
  const errorText = diagnosis.findings
    .map((f) => String(f.data?.error ?? ''))
    .find((text) => NAME_RESOLUTION_ERRORS.test(text));
  if (errorText !== undefined) {
    return {
      ...diagnosis,
      status: 'partial',
      scenario: 'target_unresolvable',
      confidence: Math.min(diagnosis.confidence, 0.6),
      findings: [
        {
          source: 'environment_check',
          observation:
            `The hostname for ${label} does not resolve (DNS lookup failed). ` +
            'The service itself may be healthy — this points to a DNS or configuration ' +
            'problem on this machine, not the service.',
          severity: 'warning',
          data: { error: errorText, redHerring: true },
        },
        ...diagnosis.findings,
      ],
      diagnosticPlanNeeded: true,
    };
  }

  // Case 2: startup TCP probe reached this target — failure is service-level.
  const targetProbe = profile?.targets.probes.find((p) => p.target === targetName);
  if (targetProbe?.reachable) return diagnosis;

  // Case 3: observer environment degraded — downgrade and re-attribute.
  const env = assessEnvironment(profile);
  if (!env.suspect) return diagnosis;

  return {
    ...diagnosis,
    status: 'partial',
    confidence: Math.min(diagnosis.confidence, 0.5),
    findings: [
      {
        source: 'environment_check',
        observation:
          `${label} is unreachable, but this machine's own connectivity is degraded: ` +
          `${env.reasons.join(' ')} Verify local network and DNS before acting on ` +
          `${label} — the service may be healthy.`,
        severity: 'warning',
        data: { reasons: env.reasons, redHerring: true },
      },
      ...diagnosis.findings,
    ],
    diagnosticPlanNeeded: true,
  };
}
