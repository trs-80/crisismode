// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AI-powered diagnosis for PostgreSQL replication issues.
 *
 * Uses Claude to analyze raw system state and produce a structured
 * diagnosis with root cause analysis that goes beyond rule-based checks.
 *
 * Falls back to rule-based diagnosis if:
 * - ANTHROPIC_API_KEY is not set
 * - The API call fails
 * - The response can't be parsed
 */

import Anthropic from '@anthropic-ai/sdk';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ReplicaStatus, ReplicationSlot } from './backend.js';

const MODEL = 'claude-sonnet-4-20250514';

interface SystemState {
  replicas: ReplicaStatus[];
  slots: ReplicationSlot[];
  connectionCount: number;
  replicaViewLag?: number;
  isReplicaInRecovery?: boolean;
}

export async function aiDiagnose(state: SystemState): Promise<DiagnosisResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = new Anthropic();

  const systemPrompt = `You are a PostgreSQL database reliability expert integrated into an automated recovery framework. Your job is to analyze raw PostgreSQL system state and produce a structured diagnosis.

You will receive data from pg_stat_replication, pg_replication_slots, pg_stat_activity, and optionally the replica's self-reported state.

Respond with ONLY a JSON object matching this exact schema — no markdown, no explanation, no wrapping:

{
  "status": "identified" | "investigating" | "inconclusive",
  "scenario": "replication_lag_cascade" | "replication_slot_overflow" | "replica_divergence" | "wal_sender_timeout" | null,
  "confidence": <number between 0 and 1>,
  "root_cause": "<one paragraph explaining the most likely root cause>",
  "findings": [
    {
      "source": "<data source name>",
      "observation": "<what you observed>",
      "severity": "critical" | "warning" | "info",
      "evidence": "<specific data points that support this finding>"
    }
  ],
  "recommendations": ["<ordered list of recovery actions>"]
}

Guidelines:
- Look at the GAP between sent_lsn and replay_lsn — this shows how far behind a replica is
- If replay is frozen but sent is advancing, WAL replay may be paused (deliberate or I/O issue)
- If multiple replicas lag, suspect primary-side issue (high WAL generation, network)
- If one replica lags, suspect replica-side issue (disk, CPU, paused replay)
- Check slot wal_status: "lost" means the slot fell behind and WAL was recycled
- High connection counts + lagging replicas suggests read traffic is being redirected to primary
- Be specific about root cause — don't just restate the symptoms`;

  const userMessage = `Analyze this PostgreSQL system state:

## pg_stat_replication (primary view)
${JSON.stringify(state.replicas, null, 2)}

## pg_replication_slots
${JSON.stringify(state.slots, null, 2)}

## pg_stat_activity
Active connections: ${state.connectionCount}

## Replica self-reported state
${state.isReplicaInRecovery !== undefined ? `In recovery mode: ${state.isReplicaInRecovery}` : 'Not available'}
${state.replicaViewLag !== undefined ? `Self-reported lag: ${state.replicaViewLag}s` : 'Not available'}

Produce your diagnosis.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: userMessage }],
      system: systemPrompt,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      status: parsed.status ?? 'identified',
      scenario: parsed.scenario ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      findings: (parsed.findings ?? []).map((f: Record<string, unknown>) => ({
        source: String(f.source ?? 'ai_analysis'),
        observation: String(f.observation ?? ''),
        severity: String(f.severity ?? 'info') as 'critical' | 'warning' | 'info',
        data: { evidence: f.evidence, root_cause: parsed.root_cause, recommendations: parsed.recommendations },
      })),
      diagnosticPlanNeeded: parsed.status === 'investigating',
    };
  } catch (err) {
    console.error('AI diagnosis failed, will fall back to rule-based:', err instanceof Error ? err.message : err);
    return null;
  }
}
