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
 * - 10s timeout via AbortController to prevent blocking during a crisis
 * - Input sanitization (field length limits, control character stripping)
 * - AI findings are advisory only — never executable
 * - Raw evidence is always preserved alongside AI interpretation
 */

import type { DiagnosisResult, DiagnosisFinding } from '../types/diagnosis-result.js';
import { getNetworkProfile } from './network-profile.js';
import { defaultAiModel } from './ai-model.js';
import { callClaude, stripCodeFence } from './ai-client.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FIELD_LENGTH = 10_000;

export interface AiDiagnosisConfig {
  /** Anthropic API key. If omitted, reads from ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to defaultAiModel() (CRISISMODE_AI_MODEL override). */
  model?: string;
  /** Timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Max tokens for the response. Defaults to 1024. */
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
 * Default response parser for the standard AI diagnosis JSON schema.
 */
export function parseStandardDiagnosisResponse(text: string): DiagnosisResult {
  // Strip markdown code fences if present
  const jsonStr = stripCodeFence(text);
  const parsed: AiRawResponse = JSON.parse(jsonStr);

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
  const maxTokens = config.maxTokens ?? 1024;

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
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`AI call timed out after ${timeoutMs}ms`);
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
