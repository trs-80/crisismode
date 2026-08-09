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
 * sites so each preserves its own observable behavior. `callClaude` throws
 * `AiTimeoutError` on timeout and the underlying error on API failure; callers
 * decide what that means.
 */

import { defaultAiModel } from './ai-model.js';

/**
 * Fallback budgets for callers that don't set their own.
 *
 * Sized so a full structured response fits: the previous 1024-token ceiling
 * truncated every JSON diagnosis mid-string, and since a truncated response
 * cannot be parsed, the AI path failed closed to heuristics with no signal
 * beyond a parse error on stderr. 60s likewise leaves headroom for a
 * reasoning model — measured 28-40s for a full-length sonnet-5 diagnosis
 * against the 10s that was here before.
 *
 * Every production call site currently passes both explicitly (which is why
 * these values only ever applied to the two toolkit entry points in
 * ai-diagnosis.ts). New callers on an INTERACTIVE path should keep doing so
 * with a tighter `timeoutMs` — a human waiting at a prompt is better served
 * by a fast fallback than by a 60s hang.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Thrown when the request did not complete within `timeoutMs`.
 *
 * This exists because a timeout is not detectable from the thrown error alone.
 * The SDK wraps an aborted request in `APIUserAbortError`, whose `name` is the
 * inherited "Error" (the SDK never assigns `name`) and whose message is the
 * cause-free "Request was aborted." — indistinguishable from a caller-initiated
 * cancellation. Since `callClaude` owns the AbortController, it is the only
 * layer that knows an abort was its own deadline firing, so it converts that
 * into a typed error the call sites can report honestly.
 *
 * The message is the bare predicate ("timed out after 10000ms") so each call
 * site can prefix its own subject, e.g. `AI routing ${err.message}`.
 */
export class AiTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = 'AiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** A single conversation turn, matching the Anthropic MessageParam shape we use. */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Why the model stopped generating.
 *
 * Modelled as a union rather than a passed-through string so a call site that
 * compares against a typo (`'max-tokens'`) fails to compile instead of silently
 * never matching. `null` is what the SDK reports for a non-streaming response
 * with no stop reason.
 *
 * Only `'max_tokens'` currently matters to callers: it is the one value that
 * means the returned text is an incomplete prefix of the real answer.
 */
export type ClaudeStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | null;

export interface CallClaudeResult {
  /** Concatenated text of all text content blocks. NOT trimmed. */
  text: string;
  /** Why generation stopped. `'max_tokens'` means `text` is truncated. */
  stopReason: ClaudeStopReason;
}

export interface CallClaudeOptions {
  /** System prompt. */
  system: string;
  /** Single user message. Ignored when `messages` is provided. */
  user?: string;
  /** Full conversation history. Overrides `user` when set (used by the ask REPL). */
  messages?: ClaudeMessage[];
  /** Max tokens for the response. Defaults to 4096. */
  maxTokens?: number;
  /** Timeout in milliseconds. Defaults to 60000. */
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
 * Callers that render the text to a human should prefer
 * {@link callClaudeDetailed}: this signature discards `stop_reason`, so a
 * response truncated at `maxTokens` is indistinguishable from a complete one.
 *
 * @throws if no API key is available, {@link AiTimeoutError} on timeout, or the
 * underlying SDK error on API failure.
 */
export async function callClaude(opts: CallClaudeOptions): Promise<string> {
  return (await callClaudeDetailed(opts)).text;
}

/**
 * Same call as {@link callClaude}, but also reports why generation stopped.
 *
 * Exists because truncation is otherwise invisible. When the model hits
 * `maxTokens` the API still returns HTTP 200 with a well-formed partial
 * response, so a caller holding only the text cannot tell a complete answer
 * from a prefix of one. That is tolerable for callers that parse JSON (the
 * parse throws) but not for callers that print prose straight to an operator:
 * across 24 live forced-truncation trials, 2 of 20 truncated answers ended on a
 * period and read as finished, so no text heuristic can close the gap.
 *
 * @throws if no API key is available, {@link AiTimeoutError} on timeout, or the
 * underlying SDK error on API failure.
 */
export async function callClaudeDetailed(opts: CallClaudeOptions): Promise<CallClaudeResult> {
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

    return {
      text: response.content
        .filter((block) => block.type === 'text')
        .map((block) => ('text' in block ? block.text : ''))
        .join(''),
      stopReason: response.stop_reason,
    };
  } catch (err) {
    // The signal, not the error shape, is the reliable witness: the SDK's abort
    // error is named "Error" and says only "Request was aborted.". Nothing else
    // can abort this controller, so `aborted` means our deadline fired.
    if (controller.signal.aborted) {
      throw new AiTimeoutError(timeoutMs);
    }
    throw err;
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
