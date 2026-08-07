// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Human walk-through support for remediation guides.
 *
 * Every RemediationGuide ships console steps that a human must verify
 * against the real provider console before its `verifiedOn` date can be
 * trusted (see CONTRIBUTING.md — the freshness test fails the build when a
 * guide goes unverified for 12 months). This module generates the
 * per-platform checklist a human walks through and applies the verdicts
 * they record back onto the guide source files.
 *
 * The CLI entry point is `scripts/guide-walkthrough.ts`
 * (`pnpm run guides:walkthrough` / `pnpm run guides:apply`).
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RemediationGuide } from '../../types/index.js';

/** Where guide source files live, for display in generated output. */
const GUIDES_DIR_LABEL = 'src/framework/guidance/guides';

/** Display names and login hints per platform, in walk order. */
export const PLATFORM_INFO: Record<string, { label: string; loginHint: string }> = {
  'anthropic-console': {
    label: 'Anthropic Console',
    loginHint: 'Sign in at https://console.anthropic.com with the account your app uses.',
  },
  'openai-platform': {
    label: 'OpenAI Platform',
    loginHint: 'Sign in at https://platform.openai.com with the account your app uses.',
  },
  supabase: {
    label: 'Supabase Dashboard',
    loginHint: 'Sign in at https://supabase.com/dashboard and open the project your app uses.',
  },
  neon: {
    label: 'Neon Console',
    loginHint:
      'Sign in at https://console.neon.tech (may redirect to neon.com) and open the project your app uses.',
  },
  'aws-rds': {
    label: 'AWS Console (RDS)',
    loginHint: 'Sign in at https://console.aws.amazon.com and switch to the region your resources live in.',
  },
};

/**
 * Transient observations for the next walk-through, surfaced with the
 * relevant platform section. Prune entries once a walk-through resolves them.
 */
const KNOWN_OBSERVATIONS: Record<string, string[]> = {
  'anthropic-console': [
    'Observed 2026-08-07: every console.anthropic.com URL redirects to platform.claude.com. ' +
      'While walking these guides, note whether the guide URLs and step wording should adopt the new domain. ' +
      'A working redirect still counts as DIFFERS — record it once per guide and move on; the fix is a URL edit, not a re-walk.',
  ],
  neon: [
    'Neon guide URLs point at neon.com while the console login hint points at console.neon.tech. ' +
      'Confirm which domain is current for your account, and record DIFFERS on any guide whose URL should change.',
  ],
};

const MINUTES_PER_GUIDE = 3;

export function walkthroughFilename(today: string): string {
  return `${today}-walkthrough.md`;
}

/**
 * Finds which guide source file (under `guidesDir`) declares each of the
 * given guide ids, by scanning file contents for `id: '<id>'`. Shared by the
 * generator (to show a guide's source file) and applyVerdicts (to know which
 * file to stamp, and to catch a guide that lives in no file at all).
 */
export function mapGuideIdsToFiles(guideIds: Iterable<string>, guidesDir: string): Map<string, string> {
  const remaining = new Set(guideIds);
  const map = new Map<string, string>();
  if (remaining.size === 0) return map;

  const files = readdirSync(guidesDir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    if (remaining.size === 0) break;
    const content = readFileSync(join(guidesDir, file), 'utf8');
    for (const id of remaining) {
      if (content.includes(`id: '${id}'`)) {
        map.set(id, file);
        remaining.delete(id);
      }
    }
  }
  return map;
}

export function generateWalkthrough(guides: readonly RemediationGuide[], today: string, guidesDir: string): string {
  const byPlatform = new Map<string, RemediationGuide[]>();
  for (const guide of guides) {
    const list = byPlatform.get(guide.platform) ?? [];
    list.push(guide);
    byPlatform.set(guide.platform, list);
  }

  const guideFiles = mapGuideIdsToFiles(
    guides.map((g) => g.id),
    guidesDir,
  );

  const totalMinutes = guides.length * MINUTES_PER_GUIDE;
  const lines: string[] = [];

  lines.push(`# Remediation guide walk-through — ${today}`);
  lines.push('');
  lines.push('## What this is');
  lines.push('');
  lines.push(
    `CrisisMode ships ${guides.length} remediation guides that tell users exactly what to click in a provider console. ` +
      'This checklist verifies each guide against the real console, one platform at a time. ' +
      `Total effort is roughly ${totalMinutes} minutes, but you do not need to do it in one sitting — ` +
      'each platform section stands alone, and progress in this file is never lost.',
  );
  lines.push('');
  lines.push(
    'If a click-path has drifted, the person who finds out is a user in the middle of an incident, following ' +
      'directions that no longer match their screen — catching it here is the whole point. A test fails the ' +
      'build when any guide goes 12 months unverified, so this comes due whether or not you schedule it.',
  );
  lines.push('');
  lines.push('## How to work through it');
  lines.push('');
  lines.push('1. Pick any platform section below and sign in to that console (login hint at the top of the section).');
  lines.push(
    '2. For each guide: open the link, read the steps, and check they match what you actually see. ' +
      'You are checking the *directions*, not fixing anything — no console changes are needed, and nothing here ' +
      'mutates your account. Guides labeled **Reference doc:** link to documentation, not a live dashboard — open ' +
      'the console section the doc describes and confirm the steps still match what you see there, not just that ' +
      'the doc page loads.',
  );
  lines.push('3. Placeholders in `<angle-brackets>` are intentional — users see them too. Judge whether they are clear.');
  lines.push("4. Edit the guide's `**Verdict:**` line:");
  lines.push('   - `MATCHES` — the steps work as written.');
  lines.push('   - `DIFFERS` — something is off. Add a line starting with `**Notes:**` saying what you saw instead.');
  lines.push('     Small drift counts (renamed menu item, moved button) — that is exactly what this catches.');
  lines.push(
    "   - `BLOCKED` — don't have an account on a platform? Mark those guides BLOCKED with a one-line reason. " +
      'They stay unverified on purpose — that is a real gap in coverage, not your failure to finish. ' +
      'Add a line starting with `**Notes:**` with that reason.',
  );
  lines.push('   - Leave `PENDING` for anything you skipped. Skipping is fine; re-run `apply` any time.');
  lines.push('5. When you have done as much as you want, run:');
  lines.push('');
  lines.push('   ```bash');
  lines.push('   pnpm run guides:apply docs/guide-verification/' + walkthroughFilename(today));
  lines.push('   ```');
  lines.push('');
  lines.push('   Every guide marked MATCHES gets its `verifiedOn` date stamped automatically, and its line here');
  lines.push('   is rewritten to `STAMPED <date>` so re-running apply never re-stamps it. ');
  lines.push('   DIFFERS guides are listed for a follow-up edit — paste the notes to your AI assistant');
  lines.push('   or open an issue; do not stamp them until the guide text is fixed.');
  lines.push('');

  for (const [platform, platformGuides] of byPlatform) {
    const info = PLATFORM_INFO[platform] ?? { label: platform, loginHint: '' };
    const minutes = platformGuides.length * MINUTES_PER_GUIDE;
    lines.push('---');
    lines.push('');
    lines.push(`## ${info.label} — ${platformGuides.length} guide${platformGuides.length === 1 ? '' : 's'}, ~${minutes} min`);
    lines.push('');
    if (info.loginHint) {
      lines.push(`> ${info.loginHint}`);
      lines.push('');
    }
    for (const note of KNOWN_OBSERVATIONS[platform] ?? []) {
      lines.push(`> **Heads-up:** ${note}`);
      lines.push('');
    }

    platformGuides.forEach((guide, i) => {
      const file = guideFiles.get(guide.id);
      lines.push(`### ${i + 1}. ${guide.title}`);
      lines.push('');
      lines.push(
        `Guide id: \`${guide.id}\` · last verified ${guide.verifiedOn}` +
          (file ? ` · defined in \`${GUIDES_DIR_LABEL}/${file}\`` : ''),
      );
      lines.push('');
      if (guide.url) {
        const label = guide.url.includes('/docs/') ? 'Reference doc' : 'Open';
        lines.push(`**${label}:** ${guide.url}`);
        lines.push('');
      }
      lines.push('**Steps users are told to follow:**');
      lines.push('');
      guide.consoleSteps.forEach((step, n) => {
        lines.push(`${n + 1}. ${step}`);
      });
      lines.push('');
      lines.push(`**Users are told to expect:** ${guide.expectedAfter}`);
      lines.push('');
      if (guide.caution) {
        lines.push(`**Caution shown to users:** ${guide.caution}`);
        lines.push('');
      }
      if (guide.cliEquivalent) {
        lines.push(`**CLI alternative shown to users** (sanity-check the command reads right; no need to run it):`);
        lines.push('');
        lines.push('```bash');
        lines.push(guide.cliEquivalent);
        lines.push('```');
        lines.push('');
      }
      lines.push(`**Verdict:** PENDING <!-- guide:${guide.id} -->`);
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated from the live guide registry by `pnpm run guides:walkthrough`. Regenerate rather than hand-editing guide content here; only the Verdict and Notes lines are yours._');
  lines.push('');
  return lines.join('\n');
}

export interface GuideVerdict {
  guideId: string;
  verdict: 'MATCHES' | 'DIFFERS' | 'BLOCKED' | 'STAMPED' | 'PENDING';
  notes: string | undefined;
  /** ISO date (YYYY-MM-DD) this guide was stamped. Present only when verdict is STAMPED. */
  stampedOn?: string | undefined;
}

export interface ParsedVerdicts {
  verdicts: GuideVerdict[];
  /** Human-readable warnings for verdict tokens that could not be recognized, even after normalization. */
  warnings: string[];
}

/**
 * Collects the `**Notes:**` block following a verdict line: the marker
 * itself (optionally preceded by one blank line, and possibly indented) plus
 * every consecutive non-blank line after it that isn't a heading or a rule,
 * joined into one string. Returns undefined when there is no notes block.
 */
function collectNotes(lines: readonly string[], verdictIndex: number): string | undefined {
  let idx = verdictIndex + 1;
  if ((lines[idx] ?? '').trim() === '') idx++;
  const first = (lines[idx] ?? '').trim();
  const notesMatch = /^\*\*Notes:\*\*\s*(.*)$/.exec(first);
  if (!notesMatch) return undefined;

  const parts: string[] = [];
  if (notesMatch[1]!.trim().length > 0) parts.push(notesMatch[1]!.trim());
  idx++;
  while (idx < lines.length) {
    const trimmed = (lines[idx] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) break;
    parts.push(trimmed);
    idx++;
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function parseVerdicts(markdown: string): ParsedVerdicts {
  const verdicts: GuideVerdict[] = [];
  const warnings: string[] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^\*\*Verdict:\*\*\s*(.*?)\s*<!-- guide:([a-z0-9-]+) -->\s*$/.exec(line);
    if (!match) continue;

    const rawContent = match[1]!.trim();
    const guideId = match[2]!;
    const notes = collectNotes(lines, i);

    // Strip leading non-letters (emoji, punctuation) so "✅ MATCHES" reads as "MATCHES".
    const strippedLeading = rawContent.replace(/^[^A-Za-z]+/, '');

    const stampedMatch = /^STAMPED\s+(\d{4}-\d{2}-\d{2})\b/i.exec(strippedLeading);
    if (stampedMatch) {
      verdicts.push({ guideId, verdict: 'STAMPED', notes: undefined, stampedOn: stampedMatch[1] });
      continue;
    }

    const token = strippedLeading.replace(/[^A-Za-z]+$/, '').toUpperCase();
    if (token === 'MATCHES' || token === 'DIFFERS' || token === 'BLOCKED' || token === 'PENDING') {
      verdicts.push({ guideId, verdict: token, notes });
    } else {
      warnings.push(
        `Unrecognized verdict "${rawContent}" on ${guideId} — treated as PENDING. Use exactly MATCHES, DIFFERS, or BLOCKED.`,
      );
      verdicts.push({ guideId, verdict: 'PENDING', notes });
    }
  }

  return { verdicts, warnings };
}

export interface ApplyResult {
  stamped: string[];
  alreadyStamped: { guideId: string; date: string }[];
  differs: (GuideVerdict & { file: string | undefined })[];
  blocked: GuideVerdict[];
  pending: string[];
  unknown: string[];
}

/**
 * Stamp `verifiedOn: '<date>'` for each MATCHES guide, editing the guide
 * source file in place. The match is anchored on the guide's unique id and
 * replaces only the first verifiedOn between that id and the next guide id
 * (guide objects always declare id first and verifiedOn last).
 *
 * Does not touch the checklist file itself — callers that want the STAMPED
 * rewrite (see stampChecklistFile) apply it separately using result.stamped.
 */
export function applyVerdicts(
  verdicts: readonly GuideVerdict[],
  date: string,
  guidesDir: string,
  guideIds: ReadonlySet<string>,
): ApplyResult {
  const result: ApplyResult = {
    stamped: [],
    alreadyStamped: [],
    differs: [],
    blocked: [],
    pending: [],
    unknown: [],
  };

  const needsFile = verdicts
    .filter((v) => guideIds.has(v.guideId) && (v.verdict === 'MATCHES' || v.verdict === 'DIFFERS'))
    .map((v) => v.guideId);
  const fileMap = mapGuideIdsToFiles(needsFile, guidesDir);
  const fileCache = new Map<string, string>();

  for (const v of verdicts) {
    if (!guideIds.has(v.guideId)) {
      result.unknown.push(v.guideId);
      continue;
    }

    if (v.verdict === 'PENDING') {
      result.pending.push(v.guideId);
      continue;
    }
    if (v.verdict === 'BLOCKED') {
      result.blocked.push(v);
      continue;
    }
    if (v.verdict === 'STAMPED') {
      result.alreadyStamped.push({ guideId: v.guideId, date: v.stampedOn ?? date });
      continue;
    }
    if (v.verdict === 'DIFFERS') {
      result.differs.push({ ...v, file: fileMap.get(v.guideId) });
      continue;
    }

    // MATCHES
    const file = fileMap.get(v.guideId);
    if (!file) {
      throw new Error(`Guide '${v.guideId}' has verdict MATCHES but its source file could not be found under ${guidesDir}`);
    }
    const absPath = join(guidesDir, file);
    const content = fileCache.get(absPath) ?? readFileSync(absPath, 'utf8');
    const idIndex = content.indexOf(`id: '${v.guideId}'`);
    if (idIndex === -1) {
      throw new Error(`Guide '${v.guideId}' expected in ${file} but its id marker was not found`);
    }
    const nextIdIndex = content.indexOf("id: '", idIndex + 1);
    const scopeEnd = nextIdIndex === -1 ? content.length : nextIdIndex;
    const scope = content.slice(idIndex, scopeEnd);
    const updatedScope = scope.replace(/verifiedOn:\s*'[0-9]{4}-[0-9]{2}-[0-9]{2}'/, `verifiedOn: '${date}'`);
    if (updatedScope === scope) {
      throw new Error(`Guide '${v.guideId}' found in ${file} but no verifiedOn field to stamp`);
    }
    fileCache.set(absPath, content.slice(0, idIndex) + updatedScope + content.slice(scopeEnd));
    result.stamped.push(v.guideId);
  }

  for (const [file, content] of fileCache) {
    writeFileSync(file, content);
  }
  return result;
}

/**
 * Rewrites the checklist markdown in place: every verdict line for a
 * newly-stamped guide id becomes `**Verdict:** STAMPED <date> <!-- guide:id
 * -->`, so a subsequent apply parses it as STAMPED and reports it as
 * already-done rather than re-stamping it with a new date.
 */
export function stampChecklistFile(markdown: string, stampedGuideIds: readonly string[], date: string): string {
  if (stampedGuideIds.length === 0) return markdown;
  const stampedSet = new Set(stampedGuideIds);
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /^\*\*Verdict:\*\*\s*.*?\s*<!-- guide:([a-z0-9-]+) -->\s*$/.exec(line);
    if (!match) continue;
    const guideId = match[1]!;
    if (!stampedSet.has(guideId)) continue;
    lines[i] = `**Verdict:** STAMPED ${date} <!-- guide:${guideId} -->`;
  }
  return lines.join('\n');
}
