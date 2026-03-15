// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AI Plan Explainer — generates plain-English summaries of recovery plans.
 *
 * Technology-agnostic: takes any RecoveryPlan + DiagnosisResult and produces
 * a human-readable explanation. Falls back gracefully when no API key is set.
 *
 * Safety:
 * - 10s timeout via AbortController
 * - Input sanitization via framework AI toolkit
 * - Advisory only — the explanation never modifies the plan
 */

import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import { sanitizeInput } from './ai-diagnosis.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PlanExplanation {
  /** One-paragraph summary of what the plan does and why. */
  summary: string;
  /** Per-step plain-English explanations. */
  stepExplanations: StepExplanation[];
  /** Key risks the operator should be aware of. */
  risks: string[];
  /** Whether this explanation was AI-generated or a basic fallback. */
  source: 'ai' | 'fallback';
}

export interface StepExplanation {
  stepId: string;
  name: string;
  explanation: string;
}

/**
 * Generate a plain-English explanation of a recovery plan.
 *
 * Uses AI when ANTHROPIC_API_KEY is available, falls back to a basic
 * structural summary otherwise.
 */
export async function explainPlan(
  plan: RecoveryPlan,
  diagnosis: DiagnosisResult,
): Promise<PlanExplanation> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildFallbackExplanation(plan, diagnosis);
  }

  try {
    return await generateAiExplanation(plan, diagnosis, apiKey);
  } catch (err) {
    console.error('AI plan explanation failed, using fallback:', err instanceof Error ? err.message : err);
    return buildFallbackExplanation(plan, diagnosis);
  }
}

async function generateAiExplanation(
  plan: RecoveryPlan,
  diagnosis: DiagnosisResult,
  apiKey: string,
): Promise<PlanExplanation> {
  const systemPrompt = `You are explaining a crisis recovery plan to an operator who may not be an expert in the target technology. Your job is to make each step understandable in plain English, highlighting what will happen, what might break, and why it matters.

Respond with ONLY a JSON object matching this schema — no markdown, no wrapping:

{
  "summary": "<one paragraph: what the plan does, why it's needed, and the expected outcome>",
  "stepExplanations": [
    {
      "stepId": "<step ID>",
      "name": "<step name>",
      "explanation": "<plain-English explanation of what this step does and its impact>"
    }
  ],
  "risks": ["<key risks the operator should know about>"]
}

Guidelines:
- Use simple language — avoid jargon where possible, explain technical terms when unavoidable
- For each step, explain WHAT happens and WHO/WHAT is affected
- Highlight any steps that cause downtime or data impact
- Be specific about durations and blast radius when the plan provides them
- Keep explanations concise — one or two sentences per step`;

  const planSummary = {
    scenario: plan.metadata.scenario,
    summary: plan.metadata.summary,
    estimatedDuration: plan.metadata.estimatedDuration,
    rollback: plan.rollbackStrategy,
    impact: plan.impact,
    steps: plan.steps.map((s) => ({
      stepId: s.stepId,
      type: s.type,
      name: s.name,
      ...(s.type === 'system_action' ? {
        riskLevel: s.riskLevel,
        blastRadius: s.blastRadius,
        command: `${s.command.type} ${s.command.operation || ''}`.trim(),
      } : {}),
    })),
  };

  const userMessage = sanitizeInput(`Explain this recovery plan to an operator:

## Diagnosis
Scenario: ${diagnosis.scenario}
Status: ${diagnosis.status}
Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%

## Plan
${JSON.stringify(planSummary, null, 2)}`);

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
        system: systemPrompt,
      },
      { signal: controller.signal },
    );

    clearTimeout(timeoutId);

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => 'text' in block ? block.text : '')
      .join('');

    const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      summary: String(parsed.summary ?? plan.metadata.summary),
      stepExplanations: Array.isArray(parsed.stepExplanations)
        ? parsed.stepExplanations.map((se: Record<string, unknown>) => ({
            stepId: String(se.stepId ?? ''),
            name: String(se.name ?? ''),
            explanation: String(se.explanation ?? ''),
          }))
        : plan.steps.map((s) => ({ stepId: s.stepId, name: s.name, explanation: '' })),
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      source: 'ai' as const,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Build a basic structural explanation without AI.
 */
function buildFallbackExplanation(
  plan: RecoveryPlan,
  diagnosis: DiagnosisResult,
): PlanExplanation {
  const stepExplanations: StepExplanation[] = plan.steps.map((s) => {
    let explanation: string;
    switch (s.type) {
      case 'diagnosis_action':
        explanation = `Gather diagnostic data: ${s.name}`;
        break;
      case 'human_notification':
        explanation = `Notify stakeholders: ${s.message.summary}`;
        break;
      case 'checkpoint':
        explanation = `Capture system state before proceeding (${s.stateCaptures.length} capture(s))`;
        break;
      case 'system_action':
        explanation = `Execute ${s.riskLevel}-risk action: ${s.name}. Affects: ${s.blastRadius.directComponents.join(', ')}`;
        break;
      case 'human_approval':
        explanation = `Pause for operator approval: ${s.presentation.summary}`;
        break;
      case 'replanning_checkpoint':
        explanation = `Agent evaluates whether the plan needs revision based on current state`;
        break;
      case 'conditional':
        explanation = `Branch based on condition: ${s.condition.description}`;
        break;
    }
    return { stepId: s.stepId, name: s.name, explanation };
  });

  const elevatedSteps = plan.steps.filter(
    (s) => s.type === 'system_action' && ['elevated', 'high', 'critical'].includes(s.riskLevel),
  );

  const risks: string[] = [];
  if (plan.impact.dataLossRisk !== 'none') {
    risks.push(`Data loss risk: ${plan.impact.dataLossRisk}`);
  }
  if (elevatedSteps.length > 0) {
    risks.push(`${elevatedSteps.length} step(s) at elevated risk or higher`);
  }
  risks.push(`User impact: ${plan.impact.estimatedUserImpact}`);

  return {
    summary: `Recovery plan for ${diagnosis.scenario ?? 'unknown scenario'}: ${plan.metadata.summary}. Estimated duration: ${plan.metadata.estimatedDuration}. Rollback strategy: ${plan.rollbackStrategy.type}.`,
    stepExplanations,
    risks,
    source: 'fallback',
  };
}
