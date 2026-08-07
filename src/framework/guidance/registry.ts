// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static registry of remediation guides, indexed by the finding types they
 * answer. Pure data plus lookup — no I/O, no clock, no network. Validation
 * (unique ids, resolvable finding types, freshness) is enforced by tests, not
 * at runtime, so a malformed guide breaks the build rather than a recovery.
 */

import type { RemediationGuide } from '../../types/remediation-guide.js';
import { anthropicGuides } from './guides/anthropic.js';

export const REMEDIATION_GUIDES: readonly RemediationGuide[] = [
  ...anthropicGuides,
];

const BY_ID = new Map<string, RemediationGuide>(REMEDIATION_GUIDES.map((g) => [g.id, g]));

const BY_FINDING_TYPE = ((): Map<string, RemediationGuide[]> => {
  const index = new Map<string, RemediationGuide[]>();
  for (const guide of REMEDIATION_GUIDES) {
    for (const findingType of guide.applicableFindingTypes) {
      const bucket = index.get(findingType);
      if (bucket) bucket.push(guide);
      else index.set(findingType, [guide]);
    }
  }
  return index;
})();

/**
 * Which platforms' guides may attach.
 *
 * `platforms: undefined` — the caller does not know the platform (a plain
 * postgresql target could be Supabase, Neon, or self-hosted): attach every
 * match. `platforms: []` — the caller knows the platform and the registry has
 * no guides for it (Google, OpenRouter, Pinecone): attach nothing, rather than
 * handing the user another vendor's console steps.
 */
export interface GuidanceScope {
  platforms?: readonly string[] | undefined;
}

function inScope(guide: RemediationGuide, scope?: GuidanceScope): boolean {
  if (scope?.platforms === undefined) return true;
  return scope.platforms.includes(guide.platform);
}

/** Guides answering one finding type (readiness rule id or agent checkId). */
export function guidesForFindingType(findingType: string, scope?: GuidanceScope): RemediationGuide[] {
  return (BY_FINDING_TYPE.get(findingType) ?? []).filter((g) => inScope(g, scope));
}

/** Guides answering any of several finding types, deduped, registry order preserved. */
export function guidesForFindingTypes(
  findingTypes: readonly string[],
  scope?: GuidanceScope,
): RemediationGuide[] {
  const seen = new Set<string>();
  const matched: RemediationGuide[] = [];
  for (const findingType of findingTypes) {
    for (const guide of BY_FINDING_TYPE.get(findingType) ?? []) {
      if (seen.has(guide.id) || !inScope(guide, scope)) continue;
      seen.add(guide.id);
      matched.push(guide);
    }
  }
  return matched;
}

export function getGuideById(id: string): RemediationGuide | undefined {
  return BY_ID.get(id);
}

/**
 * Replace `<token>` placeholders with caller-supplied values, returning a new
 * guide. Guides are static data shared across targets, so the concrete
 * instance/security-group/port values are substituted at render time rather
 * than baked in. Unknown tokens are left visible on purpose — a literal
 * `<app-security-group-id>` is honest guidance; an empty string is not.
 */
export function applyGuideVariables(
  guide: RemediationGuide,
  vars: Record<string, string>,
): RemediationGuide {
  const substitute = (text: string): string => {
    let out = text;
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`<${key}>`).join(value);
    }
    return out;
  };

  return {
    ...guide,
    title: substitute(guide.title),
    consoleSteps: guide.consoleSteps.map(substitute),
    ...(guide.cliEquivalent !== undefined ? { cliEquivalent: substitute(guide.cliEquivalent) } : {}),
    expectedAfter: substitute(guide.expectedAfter),
    ...(guide.caution !== undefined ? { caution: substitute(guide.caution) } : {}),
  };
}
