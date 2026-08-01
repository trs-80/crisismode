// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Visibility report: what CrisisMode is watching, what it found but cannot
 * check yet, and what is invisible by design. Static, offline honesty layer —
 * every blocked entry carries an actionable hint.
 */

import type { StackProfile } from './autodiscovery.js';

export interface VisibilityEntry {
  label: string;
  detail: string;
  hint?: string;
}

export interface VisibilityReport {
  watching: VisibilityEntry[];
  blocked: VisibilityEntry[];
  invisible: VisibilityEntry[];
}

/** Agent kinds that check this machine rather than a remote service. */
const LOCAL_KINDS = new Set(['dns', 'disk']);

const CONFIG_SOURCE_DETAIL: Record<string, string> = {
  file: 'configured in crisismode.yaml',
  'env-fallback': 'configured via legacy environment variables',
  none: 'detected automatically',
};

export function buildVisibilityReport(
  profile: StackProfile,
  ranKinds: string[],
  configSource: string,
): VisibilityReport {
  const watching: VisibilityEntry[] = [];
  const blocked: VisibilityEntry[] = [];
  const invisible: VisibilityEntry[] = [];

  const presentHints = profile.envHints.filter((h) => h.present);
  const ran = new Set(ranKinds);

  for (const kind of ranKinds) {
    if (LOCAL_KINDS.has(kind)) {
      watching.push({ label: kind, detail: 'local checks on this machine' });
      continue;
    }
    const hint = presentHints.find((h) => h.inferredService === kind);
    if (hint) {
      watching.push({ label: kind, detail: `via ${hint.name}` });
      continue;
    }
    const derivedTarget = profile.derivedTargets.find((t) => t.kind === kind);
    const derivedNote = derivedTarget ? profile.derivedNotes[derivedTarget.name] : undefined;
    watching.push({
      label: kind,
      detail: derivedNote ?? (CONFIG_SOURCE_DETAIL[configSource] ?? 'configured'),
    });
  }

  // Service hints whose service has no running agent — visible gap.
  for (const h of presentHints) {
    if (!h.inferredService || ran.has(h.inferredService)) continue;
    blocked.push({
      label: h.inferredService,
      detail: `found ${h.name}, but CrisisMode has no ${h.inferredService} checks yet`,
      hint: 'This service is detected but not monitored — treat its health as unknown during incidents.',
    });
  }

  // Cloud credentials with no control-plane support yet.
  if (presentHints.some((h) => h.kind === 'aws_credentials' || h.kind === 'aws_profile')) {
    blocked.push({
      label: 'AWS control plane',
      detail: 'AWS credentials detected — control-plane checks (RDS, ElastiCache instance health) are not supported yet',
      hint: 'AWS-hosted services CrisisMode can reach directly (e.g. RDS Postgres via DATABASE_URL) are still checked.',
    });
  }

  // Inherent limits — only worth stating when remote services are in play.
  if (ranKinds.some((k) => !LOCAL_KINDS.has(k))) {
    invisible.push({
      label: 'remote host internals',
      detail: 'disk, memory, and processes on remote or managed hosts cannot be seen from outside — that is true of any external tool. Run a CrisisMode spoke on the host to see them.',
    });
  }

  return { watching, blocked, invisible };
}
