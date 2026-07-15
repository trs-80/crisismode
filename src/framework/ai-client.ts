// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Single entry point for invoking the Anthropic Claude API.
 *
 * Every AI-powered path (diagnosis, explanation, summary, routing, synthesis,
 * ask REPL) previously hand-rolled the same block: an AbortController + timeout,
 * a dynamic `import('@anthropic-ai/sdk')`, `new Anthropic({ apiKey })`,
 * `messages.create(...)`, and text-block extraction. This module owns that
 * mechanism once so the call sites keep only their prompt construction and
 * response parsing.
 *
 * Deliberately narrow: no network-profile gating, no input sanitization, no
 * error-to-fallback translation. Those are caller policy and stay at the call
 * sites so each preserves its own observable behavior. `callClaude` throws on
 * timeout (AbortError) and on API failure; callers decide what that means.
 */

import { defaultAiModel } from './ai-model.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOKENS = 1024;

/** A single conversation turn, matching the Anthropic MessageParam shape we use. */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallClaudeOptions {
  /** System prompt. */
  system: string;
  /** Single user message. Ignored when `messages` is provided. */
  user?: string;
  /** Full conversation history. Overrides `user` when set (used by the ask REPL). */
  messages?: ClaudeMessage[];
  /** Max tokens for the response. Defaults to 1024. */
  maxTokens?: number;
  /** Timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Model to use. Defaults to defaultAiModel() (CRISISMODE_AI_MODEL override). */
  model?: string;
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY; throws if neither is set. */
  apiKey?: string;
}

/**
 * Call Claude and return the concatenated text of all text content blocks.
 *
 * The returned string is NOT trimmed — callers that need trimming apply it,
 * matching pre-consolidation behavior byte-for-byte.
 *
 * @throws if no API key is available, on timeout (AbortError), or on API error.
 */
export async function callClaude(opts: CallClaudeOptions): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'callClaude requires an Anthropic API key (set ANTHROPIC_API_KEY or pass opts.apiKey)',
    );
  }

  const model = opts.model ?? defaultAiModel();
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const messages: ClaudeMessage[] = opts.messages ?? [
    { role: 'user', content: opts.user ?? '' },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        // No sampling parameters: current Claude models reject non-default
        // temperature/top_p. Determinism-sensitive consumers (the bundle
        // judge matches canonical hypothesis phrasing) rely on prompt
        // wording instead.
        messages,
        system: opts.system,
      },
      { signal: controller.signal },
    );

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Strip a leading ```json (or plain ```) fence and a trailing ``` fence from
 * an AI response, then trim. Returns the text unchanged when no fence is
 * present. Consolidated from three inline copies (ai-diagnosis, ai-explainer,
 * evidence-bundle-respond).
 */
export function stripCodeFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}
