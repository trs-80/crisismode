// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Framework-level AI diagnosis toolkit.
 *
 * Provides a reusable AI diagnosis service that any agent can use.
 * Agent authors provide structured system state + a domain-specific prompt
 * template → the toolkit handles API calls, timeouts, input sanitization,
 * response parsing, and fallback.
 *
 * Safety:
 * - 60s timeout via AbortController to prevent blocking during a crisis
 * - Input sanitization (field length limits, control character stripping)
 * - AI findings are advisory only — never executable
 * - Raw evidence is always preserved alongside AI interpretation
 */

import type { DiagnosisResult, DiagnosisFinding } from '../types/diagnosis-result.js';
import { getNetworkProfile } from './network-profile.js';
import { defaultAiModel } from './ai-model.js';
import { AiTimeoutError, callClaude, stripCodeFence } from './ai-client.js';

/**
 * Response budget for every agent that calls the toolkit without its own config
 * (the pg-replication and kafka agents, and `bundle ingest`).
 *
 * These were 10s / 1024 tokens, which no current model could satisfy: a
 * complete diagnosis for the standard JSON schema (status, scenario,
 * confidence, a root-cause paragraph, findings with evidence, ordered
 * recommendations) runs past 1024 tokens, so the response arrived truncated
 * with stop_reason=max_tokens and `JSON.parse` threw "Unterminated string".
 * That made `aiDiagnose` return null on EVERY call and every agent degrade
 * silently to its rule-based fallback — the failure looked like "AI is
 * unavailable" rather than "the budget is too small". Measured against the
 * real pg-replication prompt: sonnet-5 needs ~28-40s, haiku-4.5 ~12-14s, and
 * both parse cleanly once the token ceiling is lifted.
 *
 * 60s matches the value `evidence-bundle-respond` already ships for the same
 * class of structured response. The token ceiling is set above it: nine live
 * sonnet-5 diagnoses of the pg prompt came back at 2259-3742 output tokens, so
 * 4096 leaves only ~9% headroom and one wordier finding list would truncate —
 * reintroducing exactly the silent fallback this constant exists to prevent.
 * An unused ceiling costs nothing (responses stop at end_turn), so the margin
 * is free.
 *
 * Only non-interactive paths reach these; interactive callers (ask, scan
 * summaries, symptom routing) set their own tighter bounds at the call site so
 * a human is never left hanging.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 6144;
const MAX_FIELD_LENGTH = 10_000;

export interface AiDiagnosisConfig {
  /** Anthropic API key. If omitted, reads from ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to defaultAiModel() (CRISISMODE_AI_MODEL override). */
  model?: string;
  /** Timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number;
  /** Max tokens for the response. Defaults to 6144. */
  maxTokens?: number;
}

export interface AiDiagnosisRequest {
  /** Domain-specific system prompt telling the AI how to analyze this technology. */
  systemPrompt: string;
  /** Structured system state formatted as a user message. */
  userMessage: string;
  /** Optional: parse the raw AI response into a DiagnosisResult. Default parser handles the standard JSON schema. */
  parseResponse?: (text: string) => DiagnosisResult;
}

interface AiRawResponse {
  status?: string;
  scenario?: string | null;
  confidence?: number;
  root_cause?: string;
  findings?: Array<{
    source?: string;
    observation?: string;
    severity?: string;
    evidence?: string;
  }>;
  recommendations?: string[];
}

/**
 * Sanitize input text to prevent prompt injection and control excessive length.
 * Strips control characters (except newlines/tabs) and truncates fields.
 */
export function sanitizeInput(text: string, maxLength: number = MAX_FIELD_LENGTH): string {
  // Strip control characters except \n, \r, \t
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength) + '\n... [truncated]';
  }
  return cleaned;
}

/**
 * Escape raw control characters that appear INSIDE JSON string literals.
 *
 * `sanitizeInput` strips control characters on the way to the model; this is the
 * missing counterpart on the way back. Models occasionally emit a literal
 * newline or tab inside a string value instead of `\n`/`\t`, which is illegal
 * JSON — observed live as "Bad control character in string literal in JSON at
 * position 1741" while recording the demo, which silently cost that run its AI
 * diagnosis. Repairing it is strictly better than discarding a whole diagnosis
 * over a quoting slip: only text that already failed to parse reaches this, and
 * if the repair does not help, the caller falls back exactly as it did before.
 *
 * Deliberately narrow — it tracks in-string state and rewrites nothing but
 * control characters, so structure and content are otherwise untouched.
 */
function escapeControlCharsInStrings(json: string): string {
  const ESCAPES: Record<string, string> = {
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\b': '\\b',
    '\f': '\\f',
  };

  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char.charCodeAt(0) < 0x20) {
      out += ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }

  return out;
}

/**
 * Default response parser for the standard AI diagnosis JSON schema.
 */
export function parseStandardDiagnosisResponse(text: string): DiagnosisResult {
  // Strip markdown code fences if present
  const jsonStr = stripCodeFence(text);
  let parsed: AiRawResponse;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    // Retry once with control characters escaped. A response that is truncated
    // or otherwise malformed still throws, and the caller still falls back.
    const repaired = escapeControlCharsInStrings(jsonStr);
    if (repaired === jsonStr) throw err;
    parsed = JSON.parse(repaired);
  }

  const findings: DiagnosisFinding[] = (parsed.findings ?? []).map((f) => ({
    source: String(f.source ?? 'ai_analysis'),
    observation: String(f.observation ?? ''),
    severity: (['critical', 'warning', 'info'].includes(String(f.severity))
      ? String(f.severity)
      : 'info') as 'critical' | 'warning' | 'info',
    data: {
      evidence: f.evidence,
      root_cause: parsed.root_cause,
      recommendations: parsed.recommendations,
    },
  }));

  return {
    status: (['identified', 'partial', 'inconclusive', 'unable'].includes(String(parsed.status))
      ? String(parsed.status)
      : 'identified') as DiagnosisResult['status'],
    scenario: parsed.scenario ?? null,
    confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    findings,
    diagnosticPlanNeeded: parsed.status === 'investigating',
  };
}

/**
 * Low-level AI call — returns the raw response text or null on failure.
 *
 * Centralizes API key check, network-profile gating, sanitization, abort
 * controller, error handling. Both `aiDiagnose` (DiagnosisResult parser)
 * and `evidence-bundle-respond` (brief parser) call through this.
 */
export async function aiCallText(
  systemPrompt: string,
  userMessage: string,
  config: AiDiagnosisConfig = {},
): Promise<string | null> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return null;
  }

  const model = config.model ?? defaultAiModel();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  const sanitizedSystem = sanitizeInput(systemPrompt, 5000);
  const sanitizedUser = sanitizeInput(userMessage, MAX_FIELD_LENGTH);

  try {
    return await callClaude({
      system: sanitizedSystem,
      user: sanitizedUser,
      model,
      maxTokens,
      timeoutMs,
      apiKey,
    });
  } catch (err) {
    if (err instanceof AiTimeoutError) {
      console.error(`AI call ${err.message}`);
    } else {
      console.error('AI call failed:', err instanceof Error ? err.message : err);
    }
    return null;
  }
}

/**
 * Run AI-powered diagnosis.
 *
 * Returns a DiagnosisResult if the AI call succeeds, or null if:
 * - No API key is available
 * - The API call fails or times out
 * - The response can't be parsed
 *
 * Agents should always have a rule-based fallback when this returns null.
 */
export async function aiDiagnose(
  request: AiDiagnosisRequest,
  config: AiDiagnosisConfig = {},
): Promise<DiagnosisResult | null> {
  const text = await aiCallText(request.systemPrompt, request.userMessage, config);
  if (text === null) {
    return null;
  }

  try {
    const parser = request.parseResponse ?? parseStandardDiagnosisResponse;
    return parser(text);
  } catch (err) {
    console.error(
      'AI diagnosis response could not be parsed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
