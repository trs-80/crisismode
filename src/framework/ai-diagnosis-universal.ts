// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Universal AI diagnosis — takes natural language questions or
 * structured diagnostic data and produces plain-English guidance.
 *
 * Follows the pattern from ai-explainer.ts: technology-agnostic,
 * timeout-protected, graceful fallback.
 *
 * Safety:
 * - Bounded timeout via AbortController (see RESPONSE_TIMEOUT_MS)
 * - Input sanitization via framework AI toolkit
 * - Advisory only — never executes commands
 */

import { sanitizeInput } from './ai-diagnosis.js';
import { getNetworkProfile } from './network-profile.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { HealthAssessment } from '../types/health.js';
import type { SentryEnrichment } from '../integrations/sentry.js';
import { defaultAiModel } from './ai-model.js';
import { AiTimeoutError, callClaudeDetailed } from './ai-client.js';

const DEFAULT_MODEL = defaultAiModel();

/**
 * Response budget for `crisismode ask "<question>"`, this module's only caller.
 *
 * Measured against live claude-sonnet-5 on 2026-08-09 with max_tokens=8192, so
 * every figure is a natural response length rather than a clipped one. Three
 * request shapes this module actually assembles, 3 reps each, plus 3 extra reps
 * of the widest:
 *
 *   question only ("my postgres is slow")  1076-1151 tokens   10.1-11.7s
 *   structured health+diagnosis, no question 1202-1254 tokens 14.6-15.7s
 *   question+health+diagnosis+sentry (n=6) 1285-1891 tokens   15.4-23.4s
 *
 * So BOTH previous budgets were wrong, not just the token one. At 1024 tokens
 * even the simplest question — the single most common invocation of this CLI —
 * truncated on every call, confirmed by a forced-truncation run that came back
 * stop_reason=max_tokens and cut mid-word ("...or bl"). And 15s sat below the
 * measured 15.4-23.4s of the widest shape, so the richest requests aborted and
 * degraded to buildFallback().
 *
 * 4096 is 2.2x the measured 1891-token maximum. 45s is 1.9x the measured 23.4s
 * and matches the ~85 tokens/s observed here, so the deadline and the ceiling
 * are reachable together rather than one masking the other. It stays under the
 * 60s non-interactive bound in ai-client.ts on purpose: an operator typed this
 * command and is watching a terminal with no progress output.
 */
const RESPONSE_MAX_TOKENS = 4096;
const RESPONSE_TIMEOUT_MS = 45_000;

export interface UniversalDiagnosisRequest {
  /** Free-form question from the user. */
  question?: string;
  /** Structured diagnosis result from an agent. */
  diagnosis?: DiagnosisResult;
  /** Health assessment from an agent. */
  health?: HealthAssessment;
  /** Sentry error context to enrich diagnosis. */
  sentryContext?: SentryEnrichment;
}

export interface UniversalDiagnosisResult {
  response: string;
  source: 'ai' | 'fallback';
  /**
   * True when the model hit RESPONSE_MAX_TOKENS and `response` is a prefix of
   * the real answer rather than the whole thing.
   *
   * Required, not optional: a caller that renders `response` must not be able
   * to forget that it might be half an answer. Always false for fallbacks,
   * which are locally generated and complete by construction.
   */
  truncated: boolean;
}

const SYSTEM_PROMPT = `You are an infrastructure recovery specialist embedded in the CrisisMode CLI tool. Your job is to help operators understand what's wrong with their systems and what to do about it.

Guidelines:
- Be direct and actionable. Lead with the most important thing.
- If given diagnostic data, explain the root cause, urgency level, and recommended next steps.
- If given a natural language question, provide practical troubleshooting guidance.
- Include specific commands when helpful (e.g., SQL queries, docker commands, systemctl).
- Rate urgency: CRITICAL (act now), HIGH (fix soon), MEDIUM (schedule fix), LOW (monitor).
- Keep responses concise — operators are in a crisis, not reading documentation.
- If you're unsure, say so and suggest diagnostic steps to narrow down the issue.

Supported systems: PostgreSQL, Redis, etcd, Kafka, Kubernetes, Ceph, Flink.`;

/**
 * Run universal AI diagnosis.
 *
 * Accepts either a natural language question, structured diagnostic data,
 * or both. Returns plain-English guidance.
 */
export async function universalAiDiagnosis(
  request: UniversalDiagnosisRequest,
): Promise<UniversalDiagnosisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildFallback(request);
  }

  // Skip AI call if network profile says no internet
  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return buildFallback(request);
  }

  try {
    return await callAi(request, apiKey);
  } catch (err) {
    if (err instanceof AiTimeoutError) {
      console.error(`AI diagnosis ${err.message}`);
    } else {
      console.error('AI diagnosis failed:', err instanceof Error ? err.message : err);
    }
    return buildFallback(request);
  }
}

async function callAi(
  request: UniversalDiagnosisRequest,
  apiKey: string,
): Promise<UniversalDiagnosisResult> {
  const parts: string[] = [];

  if (request.question) {
    parts.push(`User question: ${request.question}`);
  }

  if (request.health) {
    parts.push(`\nHealth Assessment:\n- Status: ${request.health.status}\n- Confidence: ${(request.health.confidence * 100).toFixed(0)}%\n- Summary: ${request.health.summary}\n- Signals:\n${request.health.signals.map((s) => `  [${s.status.toUpperCase()}] ${s.source}: ${s.detail}`).join('\n')}`);
  }

  if (request.diagnosis) {
    parts.push(`\nDiagnosis:\n- Status: ${request.diagnosis.status}\n- Scenario: ${request.diagnosis.scenario}\n- Confidence: ${(request.diagnosis.confidence * 100).toFixed(0)}%\n- Findings:\n${request.diagnosis.findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.source}: ${f.observation}`).join('\n')}`);
  }

  if (request.sentryContext) {
    parts.push(`\nSentry Error Context:\n${request.sentryContext.summary}`);
    if (request.sentryContext.recentErrors.length > 0) {
      parts.push('Recent Errors:');
      for (const err of request.sentryContext.recentErrors.slice(0, 10)) {
        parts.push(`  [${err.count}x] ${err.title} (last: ${err.lastSeen})`);
      }
    }
    if (request.sentryContext.errorSpike) {
      parts.push(`Error Spike: ${request.sentryContext.errorSpike.spikeMultiplier}x above baseline (${request.sentryContext.errorSpike.currentRate.toFixed(1)} errors/hour)`);
    }
  }

  const userMessage = sanitizeInput(parts.join('\n\n'));

  const { text, stopReason } = await callClaudeDetailed({
    system: SYSTEM_PROMPT,
    user: userMessage,
    model: DEFAULT_MODEL,
    maxTokens: RESPONSE_MAX_TOKENS,
    timeoutMs: RESPONSE_TIMEOUT_MS,
    apiKey,
  });

  // Report truncation from stop_reason rather than inferring it from the text.
  // A cut answer frequently reads as a finished one: in 24 live trials, 2 of 20
  // truncated responses ended on a period, so "does it end mid-sentence?" would
  // present a partial diagnosis as complete roughly 1 time in 10.
  return { response: text.trim(), source: 'ai', truncated: stopReason === 'max_tokens' };
}

function buildFallback(request: UniversalDiagnosisRequest): UniversalDiagnosisResult {
  const parts: string[] = [];

  if (request.question) {
    parts.push(`To answer "${request.question}", set ANTHROPIC_API_KEY for AI-powered diagnosis.`);
    parts.push('');
    parts.push('In the meantime, try these commands:');
    parts.push('  crisismode diagnose    # run automated health checks');
    parts.push('  crisismode status      # quick service status probe');
  }

  if (request.health) {
    parts.push(`System is ${request.health.status} (${(request.health.confidence * 100).toFixed(0)}% confidence).`);
    parts.push(request.health.summary);
    if (request.health.recommendedActions.length > 0) {
      parts.push('');
      parts.push('Recommended actions:');
      for (const action of request.health.recommendedActions) {
        parts.push(`  - ${action}`);
      }
    }
  }

  if (request.diagnosis) {
    parts.push(`Diagnosis: ${request.diagnosis.scenario ?? 'unknown'} (${request.diagnosis.status})`);
    for (const f of request.diagnosis.findings) {
      parts.push(`  [${f.severity.toUpperCase()}] ${f.observation}`);
    }
  }

  if (request.sentryContext && request.sentryContext.recentErrors.length > 0) {
    parts.push('');
    parts.push(`Sentry: ${request.sentryContext.summary}`);
  }

  return {
    response: parts.join('\n') || 'Set ANTHROPIC_API_KEY for AI-powered diagnosis, or run `crisismode diagnose` for automated checks.',
    source: 'fallback',
    truncated: false,
  };
}
