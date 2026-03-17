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
 * - 15s timeout via AbortController
 * - Input sanitization via framework AI toolkit
 * - Advisory only — never executes commands
 */

import { sanitizeInput } from './ai-diagnosis.js';
import { getNetworkProfile } from './network-profile.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { HealthAssessment } from '../types/health.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface UniversalDiagnosisRequest {
  /** Free-form question from the user. */
  question?: string;
  /** Structured diagnosis result from an agent. */
  diagnosis?: DiagnosisResult;
  /** Health assessment from an agent. */
  health?: HealthAssessment;
}

export interface UniversalDiagnosisResult {
  response: string;
  source: 'ai' | 'fallback';
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
    console.error('AI diagnosis failed:', err instanceof Error ? err.message : err);
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

  const userMessage = sanitizeInput(parts.join('\n\n'));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
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

    return { response: text.trim(), source: 'ai' };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
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

  return {
    response: parts.join('\n') || 'Set ANTHROPIC_API_KEY for AI-powered diagnosis, or run `crisismode diagnose` for automated checks.',
    source: 'fallback',
  };
}
