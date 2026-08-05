// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Agent maturity — the honesty layer's two-value view of a manifest's
 * `metadata.plugin.maturity`.
 *
 * CrisisMode registers many more agents than it has validated against real
 * infrastructure. Everything except an explicit `live_validated` manifest
 * value is reported to operators as best-effort: the checks exist and run,
 * but they have never been proven against a live system, so their findings
 * are leads rather than conclusions. Unknown and unregistered kinds get the
 * same treatment — the honest default is the pessimistic one.
 */

import type { AgentManifest } from '../types/manifest.js';

export type AgentMaturity = 'live_validated' | 'simulator_only';

/**
 * Minimal registration shape needed to derive maturity. Structural on
 * purpose: this module stays free of `src/config` imports so config can
 * depend on it and not the other way round.
 */
export interface MaturitySource {
  kind: string;
  manifest: AgentManifest;
}

/** One-line hint for the visibility report's best-effort bucket. */
export const BEST_EFFORT_GROUP_HINT =
  'checks exist but have never been validated against a real deployment; treat findings as leads, not conclusions.';

/** Suffix appended to a best-effort finding in human scan output. */
export const BEST_EFFORT_FINDING_SUFFIX =
  'best-effort: these checks have never been validated against real infrastructure — treat this as a lead, not a conclusion.';

/** Per-system hint, for surfaces that talk about one agent at a time (`agent info`). */
export function bestEffortHint(system: string): string {
  return `checks exist but have never been validated against a real ${system}; treat findings as leads, not conclusions.`;
}

/**
 * Collapse a manifest's five-value plugin maturity to the two values the
 * honesty layer reports. Optional chaining is deliberate: manifests loaded
 * from plugin JSON at runtime are not compile-time checked.
 */
export function agentMaturity(manifest: AgentManifest): AgentMaturity {
  return manifest.metadata.plugin?.maturity === 'live_validated' ? 'live_validated' : 'simulator_only';
}

/**
 * Build the kind → maturity map. A kind counts as live-validated only when
 * EVERY agent registered for it says so — with several agents per kind, the
 * one that actually runs is not known here, so claim the weaker of the two.
 */
export function buildMaturityByKind(sources: MaturitySource[]): Map<string, AgentMaturity> {
  const byKind = new Map<string, AgentMaturity>();
  for (const source of sources) {
    if (byKind.get(source.kind) === 'simulator_only') continue;
    byKind.set(source.kind, agentMaturity(source.manifest));
  }
  return byKind;
}
