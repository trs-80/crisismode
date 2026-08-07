// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The single place a RemediationGuide becomes text. Pure: no chalk, no
 * console, no output-mode awareness. `src/cli/output.ts` wraps these lines
 * with color and indentation for the terminal, and agents use
 * formatGuideForPlan() for suggestion-plan step text — so every surface shows
 * the same words in the same order.
 */

import type { RemediationGuide } from '../../types/remediation-guide.js';

export interface GuideRenderOptions {
  /** Collapse to a single title + URL line (mirrors the CLI's --terse). */
  terse?: boolean | undefined;
}

export function renderGuideLines(guide: RemediationGuide, opts: GuideRenderOptions = {}): string[] {
  if (opts.terse) {
    return [guide.url !== undefined
      ? `How to fix it: ${guide.title} — ${guide.url}`
      : `How to fix it: ${guide.title}`];
  }

  const lines: string[] = [`How to fix it: ${guide.title}`];
  if (guide.url !== undefined) lines.push(`  Open: ${guide.url}`);
  guide.consoleSteps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  if (guide.cliEquivalent !== undefined) lines.push(`  CLI: ${guide.cliEquivalent}`);
  lines.push(`  Expect: ${guide.expectedAfter}`);
  if (guide.caution !== undefined) lines.push(`  Caution: ${guide.caution}`);
  lines.push(`  (path verified ${guide.verifiedOn})`);
  return lines;
}

export function renderGuidesLines(
  guides: readonly RemediationGuide[],
  opts: GuideRenderOptions = {},
): string[] {
  const blocks = guides.map((g) => renderGuideLines(g, opts));
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) lines.push('');
    lines.push(...block);
  });
  return lines;
}

/** Pipe-mode reference token: `guide:<id>[,<id>...]`, or '' when there are none. */
export function guideReference(guides: readonly RemediationGuide[]): string {
  if (guides.length === 0) return '';
  return `guide:${guides.map((g) => g.id).join(',')}`;
}

/** Full guide as a single text block, for recovery-plan step detail. */
export function formatGuideForPlan(guide: RemediationGuide): string {
  return renderGuideLines(guide).join('\n');
}
