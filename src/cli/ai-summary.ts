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
import { defaultAiModel } from '../framework/ai-model.js';

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
): Promise<PlainEnglishSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildFallbackSummary(summary);
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return buildFallbackSummary(summary);
  }

  try {
    return await callAi(summary, recentChanges, apiKey);
  } catch (err) {
    console.error('AI summary failed:', err instanceof Error ? err.message : err);
    return buildFallbackSummary(summary);
  }
}

async function callAi(
  summary: IncidentSummary,
  recentChanges: RecentChange[],
  apiKey: string,
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

  const userMessage = sanitizeInput(parts.join('\n'));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: userMessage }],
        system: SYSTEM_PROMPT,
      },
      { signal: controller.signal },
    );

    clearTimeout(timeoutId);

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => 'text' in block ? block.text : '')
      .join('');

    return { text: text.trim(), source: 'ai' };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Build a fallback summary from structured data without AI.
 */
export function buildFallbackSummary(summary: IncidentSummary): PlainEnglishSummary {
  const total = summary.critical.length + summary.warning.length + summary.healthy.length;
  const parts: string[] = [];

  parts.push(`Scanned ${total} services.`);

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
