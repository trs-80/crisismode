// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Attach matching guides to findings. Structural generics keep this module
 * free of imports from src/cli/ and src/readiness/ — the guidance layer is a
 * leaf, and callers keep their own types.
 */

import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { RemediationGuide } from '../../types/remediation-guide.js';
import { applyGuideVariables, guidesForFindingTypes, type GuidanceScope } from './registry.js';

export interface ScanFindingLike {
  checkId?: string | undefined;
  /** Substitutions for this finding's own checkId's matched guide(s) — see HealthSignal.guideVars. */
  guideVars?: Record<string, string> | undefined;
  signals?: ReadonlyArray<{ checkId?: string | undefined; guideVars?: Record<string, string> | undefined }> | undefined;
  /** Platforms this finding's target may show guides for — see platformsForTarget(). */
  guidancePlatforms?: readonly string[] | undefined;
  guides?: RemediationGuide[] | undefined;
}

export interface RuleFindingLike {
  ruleId: string;
  guides?: RemediationGuide[] | undefined;
}

/** Attached findings are returned as an intersection so callers can read `.guides` off an inline literal. */
type WithGuides<T> = T & { guides?: RemediationGuide[] | undefined };

/**
 * Resolve guides for one checkId and apply that source's own guideVars, so a
 * guide's `<token>` placeholders never reach the caller unresolved. Each
 * (checkId, vars) pair is resolved independently — the finding's own checkId
 * carries the finding's guideVars, and each signal's checkId carries that
 * signal's own guideVars, since two signals on one finding can name the same
 * checkId for different targets with different substitutions.
 */
function resolveGuides(
  checkId: string,
  vars: Record<string, string> | undefined,
  scope: GuidanceScope | undefined,
): RemediationGuide[] {
  const guides = guidesForFindingTypes([checkId], scope);
  return vars === undefined ? guides : guides.map((g) => applyGuideVariables(g, vars));
}

/**
 * A scan finding covers a whole target, so its guidance anchors can come from
 * the finding's own checkId or from any of its signals' checkIds. The
 * platform scope rides on the finding itself (populated in scan.ts, where the
 * target is in hand) so this stays callable from the output layer. Variables
 * are resolved per-source (finding-level vs. each signal's own guideVars)
 * before the results are merged, deduping by guide id so a checkId shared by
 * the finding and one of its signals doesn't attach twice.
 */
export function attachGuidesToScanFinding<T extends ScanFindingLike>(finding: T): WithGuides<T> {
  const scope: GuidanceScope = { platforms: finding.guidancePlatforms };
  const seen = new Set<string>();
  const guides: RemediationGuide[] = [];
  const collect = (checkId: string | undefined, vars: Record<string, string> | undefined): void => {
    if (checkId === undefined) return;
    for (const guide of resolveGuides(checkId, vars, scope)) {
      if (seen.has(guide.id)) continue;
      seen.add(guide.id);
      guides.push(guide);
    }
  };
  collect(finding.checkId, finding.guideVars);
  for (const signal of finding.signals ?? []) collect(signal.checkId, signal.guideVars);
  return guides.length > 0 ? { ...finding, guides } : finding;
}

export function attachGuidesByRuleId<T extends RuleFindingLike>(
  finding: T,
  scope?: GuidanceScope,
): WithGuides<T> {
  const guides = guidesForFindingTypes([finding.ruleId], scope);
  return guides.length > 0 ? { ...finding, guides } : finding;
}

export function attachGuidesToDiagnosis(
  diagnosis: DiagnosisResult,
  scope?: GuidanceScope,
): DiagnosisResult {
  return {
    ...diagnosis,
    findings: diagnosis.findings.map((finding) => {
      if (finding.checkId === undefined) return finding;
      const guides = resolveGuides(finding.checkId, finding.guideVars, scope);
      return guides.length > 0 ? { ...finding, guides } : finding;
    }),
  };
}
