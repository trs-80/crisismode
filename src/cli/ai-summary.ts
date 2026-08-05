// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Plain-English AI summary — rewrites structured scan results into
 * 3-5 sentences a developer without infrastructure experience can understand.
 *
 * Follows the pattern from ai-diagnosis-universal.ts:
 * API key check -> network check -> Claude call -> graceful fallback.
 *
 * Safety:
 * - 8s timeout via AbortController
 * - Input sanitization via framework AI toolkit
 * - Advisory only — never executes commands
 */

import { sanitizeInput } from '../framework/ai-diagnosis.js';
import { getNetworkProfile } from '../framework/network-profile.js';
import type { IncidentSummary } from './incident-summary.js';
import type { RecentChange } from './output.js';
import type { VisibilityReport } from './visibility.js';
import { liveValidatedWatching, bestEffortWatching } from './visibility.js';
import { defaultAiModel } from '../framework/ai-model.js';
import { callClaude } from '../framework/ai-client.js';

const MODEL = defaultAiModel();
const TIMEOUT_MS = 8_000;
const MAX_TOKENS = 512;

const SYSTEM_PROMPT = 'You are a friendly infrastructure assistant. Rewrite the following scan summary into 3-5 sentences of plain English that a developer without infrastructure experience would understand. Include: what\'s wrong (or that everything is OK), what recently changed if anything, and what they should do next. Use the service/site names from the data. Be direct and helpful but not alarming. If action is needed, end with the specific command to run.';

export interface PlainEnglishSummary {
  text: string;
  source: 'ai' | 'fallback';
}

/**
 * Generate a plain-English summary of scan results.
 * Falls back to a simple structured sentence if AI is unavailable.
 */
export async function generatePlainEnglishSummary(
  summary: IncidentSummary,
  recentChanges: RecentChange[],
  visibility?: VisibilityReport,
): Promise<PlainEnglishSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildFallbackSummary(summary, visibility);
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return buildFallbackSummary(summary, visibility);
  }

  try {
    return await callAi(summary, recentChanges, apiKey, visibility);
  } catch (err) {
    console.error('AI summary failed:', err instanceof Error ? err.message : err);
    return buildFallbackSummary(summary, visibility);
  }
}

async function callAi(
  summary: IncidentSummary,
  recentChanges: RecentChange[],
  apiKey: string,
  visibility?: VisibilityReport,
): Promise<PlainEnglishSummary> {
  // Build a compact text serialization — keep it under 500 tokens
  const parts: string[] = [];
  parts.push(`Headline: ${summary.headline}`);
  parts.push(`Score: ${summary.score}/100`);

  if (summary.critical.length > 0) {
    const names = summary.critical.map((f) => f.service).join(', ');
    parts.push(`Critical (${summary.critical.length}): ${names}`);
  }
  if (summary.warning.length > 0) {
    const names = summary.warning.map((f) => f.service).join(', ');
    parts.push(`Warning (${summary.warning.length}): ${names}`);
  }
  if (summary.healthy.length > 0) {
    const names = summary.healthy.map((f) => f.service).join(', ');
    parts.push(`Healthy (${summary.healthy.length}): ${names}`);
  }

  if (summary.nextSteps.length > 0) {
    parts.push(`Next steps: ${summary.nextSteps.join('; ')}`);
  }

  if (recentChanges.length > 0) {
    const changeDescs = recentChanges.slice(0, 5).map((c) => c.description);
    parts.push(`Recent changes: ${changeDescs.join('; ')}`);
  }

  // The model is told which systems are actually validated, so it cannot
  // describe best-effort checks as if they were proven coverage.
  const visibilityText = visibility
    ? `\nVisibility: live-validated checks for ${liveValidatedWatching(visibility).map((e) => e.label).join(', ') || 'nothing'}. ` +
      `Best-effort checks (never validated against a real system — describe these findings as leads, not conclusions): ` +
      `${bestEffortWatching(visibility).map((e) => e.label).join(', ') || 'none'}. ` +
      `Known gaps: ${visibility.blocked.map((e) => e.detail).join('; ') || 'none'}.`
    : '';

  const userMessage = sanitizeInput(parts.join('\n') + visibilityText);

  const text = await callClaude({
    system: SYSTEM_PROMPT,
    user: userMessage,
    model: MODEL,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    apiKey,
  });

  return { text: text.trim(), source: 'ai' };
}

/**
 * Build a fallback summary from structured data without AI.
 *
 * The service count is a finding count (every probe that ran), not a coverage
 * claim. The coverage claim is a separate sentence that counts only
 * live-validated systems — best-effort systems are named, never folded in.
 */
export function buildFallbackSummary(
  summary: IncidentSummary,
  visibility?: VisibilityReport,
): PlainEnglishSummary {
  const total = summary.critical.length + summary.warning.length + summary.healthy.length;
  const parts: string[] = [];

  parts.push(`Scanned ${total} services.`);

  const coverage = visibility ? coverageSentence(visibility) : null;
  if (coverage) parts.push(coverage);

  if (summary.critical.length > 0) {
    const names = summary.critical.map((f) => f.service).join(', ');
    parts.push(`${summary.critical.length} need attention: ${names}.`);
  } else if (summary.warning.length > 0) {
    const names = summary.warning.map((f) => f.service).join(', ');
    parts.push(`${summary.warning.length} recovering: ${names}.`);
  } else {
    parts.push('All services are healthy.');
  }

  if (summary.nextSteps.length > 0) {
    parts.push(`Next: ${summary.nextSteps[0]}`);
  }

  return { text: parts.join(' '), source: 'fallback' };
}

/**
 * The coverage claim. Returns null when every watched system is
 * live-validated — the plain count is unambiguous then, and an extra
 * sentence would just be noise.
 */
function coverageSentence(visibility: VisibilityReport): string | null {
  const bestEffort = bestEffortWatching(visibility);
  if (bestEffort.length === 0) return null;
  const live = liveValidatedWatching(visibility);
  const labels = bestEffort.map((e) => e.label).join(', ');
  const verb = bestEffort.length === 1 ? 'is' : 'are';
  return `${live.length} of ${visibility.watching.length} watched systems have live-validated checks; ` +
    `${labels} ${verb} best-effort, so treat those findings as leads.`;
}
