// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Turns `crisismode.yaml`'s `services:` list into `service-status` targets —
 * shared by scan's inline target assembly (`runScan`) and watch's
 * `loadConfigWithLocalTargets`, so both commands see the same third-party
 * dependencies. `TargetConfig`/`ResolvedTarget` (config/schema.ts) only have
 * typed per-kind fields, and `resolveTarget()` (config/resolve.ts) copies
 * them field-by-field — an untracked field would silently vanish there — so
 * each configured service is synthesized as a plain `service-status` target
 * with a mandatory `primary` host/port instead of a new schema field.
 * `primary` is mandatory on purpose: config/live-registration.ts treats a
 * missing `primary` (or `primary.host === 'simulator'`) as a simulator
 * target, and config/resolve.ts's `target.primary ?? { host: 'aws', port: 0 }`
 * fallback would otherwise silently stamp a bogus host.
 */

import { resolveTarget } from '../framework/service-status/checker.js';
import type { SiteConfig, TargetConfig } from '../config/schema.js';

export function serviceTargetsFromConfig(config: SiteConfig): TargetConfig[] {
  return (config.services ?? []).map((entry) => {
    const resolved = resolveTarget(entry);
    const host = resolved.entry?.probeHost ?? resolved.host ?? resolved.id;
    const port = resolved.entry?.probePort ?? resolved.port ?? 443;
    return {
      name: resolved.id,
      kind: 'service-status',
      primary: { host, port },
    };
  });
}

/**
 * The single `service-status` watching-entry detail scan shows. Task 6's
 * visibility report has no per-target granularity (`buildVisibilityReport`
 * pushes one watching entry per agent *kind*, src/cli/visibility.ts:60-77),
 * so every configured service collapses into one line — this enumerates them
 * instead of losing the detail entirely. Raw domains (no catalog entry) are
 * annotated "(reachability only)": there is no status page to check for
 * them, so the honesty contract only covers whether this machine can reach
 * them.
 */
export function serviceStatusWatchingDetail(config: SiteConfig): string {
  const entries = config.services ?? [];
  const parts = entries.map((entry) => {
    const resolved = resolveTarget(entry);
    return resolved.entry ? resolved.id : `${resolved.id} (reachability only)`;
  });
  return `watching ${parts.join(', ')}`;
}
