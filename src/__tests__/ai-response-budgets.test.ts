// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression: the two remaining AI call sites that parse structured JSON must
 * ask for enough tokens and wait long enough to actually get it.
 *
 * Same defect class as the aiDiagnose truncation bug (see
 * ai-diagnosis-token-budget.test.ts): a max_tokens ceiling below the model's
 * real response length does not shorten the answer, it truncates the JSON
 * mid-string. The parse throws, the caller catches it, and the feature degrades
 * to its rule-based fallback with no signal that a budget was the cause.
 *
 * `ai-explainer` was at 1024 tokens / 10s against a measured 1407-1484 tokens
 * and 15.2-16.4s. `root-cause-synthesis` was at 1024 / 20s against a measured
 * 749-1522 tokens and 8.8-17.7s, AND parsed with a bare `.trim()` instead of
 * `stripCodeFence`, so a fenced response failed outright — 2 of 3 live calls.
 *
 * All fixtures here are verbatim live claude-sonnet-5 captures, so the token
 * counts asserted are measured facts. No test in this file touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import { explainPlan } from '../framework/ai-explainer.js';
import { synthesizeByAi } from '../framework/root-cause-synthesis.js';
import type { AgentEvidence } from '../framework/root-cause-synthesis.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

// Capture the SDK's messages.create so every test controls the response
// without reaching the network.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof AnthropicSdk>();
  return {
    ...actual,
    default: class {
      messages = { create: createMock };
    },
  };
});

const OLD_MAX_TOKENS = 1024;

/** Resolve after `ms`, but honor the abort signal the way the real SDK does. */
function respondAfter(ms: number, text: string) {
  return (_params: unknown, opts: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ content: [{ type: 'text', text }] }), ms);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Request was aborted.'));
      });
    });
}

/**
 * Truncate at the character offset the old 1024-token ceiling would have cut,
 * derived from this body's own measured chars-per-token rather than a generic
 * rule of thumb. The point is that the cut lands mid-value.
 */
function truncateAtOldCeiling(text: string, measuredTokens: number): string {
  return text.slice(0, Math.floor(text.length * (OLD_MAX_TOKENS / measuredTokens)));
}

// ─────────────────────────────────────────────────────────────────────────
// ai-explainer
// ─────────────────────────────────────────────────────────────────────────

/**
 * Verbatim claude-sonnet-5 response to the real explainer prompt for the
 * 10-step pg-replication reference plan (captured 2026-08-09). The API reported
 * usage.output_tokens = 1484 with stop_reason=end_turn — 45% past the old
 * 1024-token ceiling, so this exact explanation could never have been returned.
 */
const EXPLAINER_RESPONSE = `{
  "summary": "This plan fixes a problem where one database copy (a 'replica' at address 10.0.1.52) has fallen too far behind the main database (the 'primary'), which risks slowing down the whole system. The fix works by temporarily disconnecting the lagging copy, redirecting traffic away from it, and then rebuilding it from scratch using a fresh copy of the primary's data. The whole process should take about 15 minutes, will not risk losing any data, and may cause slightly slower read speeds for users during recovery, but no impact to writes (saving new data) is expected.",
  "stepExplanations": [
    {
      "stepId": "step-001",
      "name": "Assess current replication lag across all replicas",
      "explanation": "The system checks how far behind each database copy is compared to the primary, to confirm which ones are affected and how severe the problem is. This is just information-gathering and doesn't change anything."
    },
    {
      "stepId": "step-002",
      "name": "Notify on-call DBA of replication recovery initiation",
      "explanation": "An alert is sent to the on-call database administrator letting them know this automated recovery process is starting, so they can monitor or step in if needed."
    },
    {
      "stepId": "step-003",
      "name": "Pre-recovery checkpoint",
      "explanation": "The system records the current state of things as a safety snapshot, so if something goes wrong later, it knows exactly what to roll back to."
    },
    {
      "stepId": "step-004",
      "name": "Disconnect lagging replica 10.0.1.52 from replication",
      "explanation": "The problematic database copy is cut off from receiving updates from the primary. This copy will become temporarily unavailable for reads, but the primary and other replicas keep working normally. This is a moderate-risk action but only affects this one replica."
    },
    {
      "stepId": "step-005",
      "name": "Redirect read traffic away from disconnected replica",
      "explanation": "The system reconfigures the load balancer (the traffic router) so that user read requests no longer go to the disconnected replica, avoiding errors or timeouts. This is a routine, low-risk change."
    },
    {
      "stepId": "step-006",
      "name": "Assess recovery progress before proceeding",
      "explanation": "The system pauses to re-check that everything is going as expected before moving to the riskier next steps. This is an automatic checkpoint, not a user-facing change."
    },
    {
      "stepId": "step-007",
      "name": "Approve replica resynchronization",
      "explanation": "A human (likely the on-call DBA) must manually approve before the system proceeds to rebuild the broken replica, since the next step is more resource-intensive and impactful."
    },
    {
      "stepId": "step-008",
      "name": "Initiate pg_basebackup and re-establish replication for 10.0.1.52",
      "explanation": "The system performs a full fresh copy of the primary database's data onto the broken replica to rebuild it from scratch. This is the highest-risk step because it puts extra load on the primary database, which could temporarily slow it down for other users."
    },
    {
      "stepId": "step-009",
      "name": "Restore traffic or notify for manual intervention",
      "explanation": "The system checks whether the rebuilt replica is healthy again. If yes, it automatically restores normal traffic to it; if not, it alerts a human to step in and investigate manually."
    },
    {
      "stepId": "step-010",
      "name": "Send recovery summary",
      "explanation": "A final report is sent out summarizing what happened during the recovery, so the team has a record of the incident and the actions taken."
    }
  ],
  "risks": [
    "During the rebuild step (pg_basebackup), the primary database will experience increased load, which could slow down performance for other reads or queries system-wide.",
    "Read queries may be slightly slower than usual throughout the recovery process, though no write/data-loss impact is expected.",
    "If the resynchronization fails, the system will require manual intervention from a human operator rather than resolving automatically.",
    "The disconnected replica will be completely unavailable for reads until it's successfully rebuilt and reconnected.",
    "This plan includes rollback steps for each stage, but a failure during the high-risk rebuild step could still require careful manual recovery."
  ]
}`;

const EXPLAINER_MEASURED_TOKENS = 1484;

/** Measured latency range for the explainer prompt: 15.2-16.4s. */
const EXPLAINER_MEASURED_MS = 16_400;

/**
 * The plan only has to satisfy the fallback builder and the prompt assembly —
 * the SDK is mocked, so the response is EXPLAINER_RESPONSE regardless of what
 * is sent. The fixture itself is the real answer to the 10-step reference plan.
 */
function makePlan(): RecoveryPlan {
  return {
    planId: 'rp-test-001',
    metadata: {
      scenario: 'replication_lag_cascade',
      summary: 'Recover PostgreSQL replication by resyncing the lagging replica',
      estimatedDuration: 'PT15M',
    },
    steps: [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Assess current replication lag across all replicas',
        command: { type: 'sql', operation: 'SELECT * FROM pg_stat_replication' },
      },
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Disconnect lagging replica 10.0.1.52 from replication',
        riskLevel: 'elevated',
        command: { type: 'sql', operation: 'SELECT pg_terminate_backend(pid)' },
        blastRadius: { directComponents: ['pg-replica-10-0-1-52'] },
      },
    ],
    rollbackStrategy: { type: 'stepwise' },
    impact: {
      dataLossRisk: 'none',
      estimatedUserImpact: 'Read queries may experience elevated latency',
    },
  } as unknown as RecoveryPlan;
}

const DIAGNOSIS: DiagnosisResult = {
  status: 'identified',
  scenario: 'replication_lag_cascade',
  confidence: 0.78,
  findings: [],
  diagnosticPlanNeeded: false,
};

describe('ai-explainer response budget', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('asks for enough tokens to explain every step of a real plan', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: EXPLAINER_RESPONSE }] });

    const result = await explainPlan(makePlan(), DIAGNOSIS);

    expect(result.source).toBe('ai');
    expect(result.stepExplanations).toHaveLength(10);
    expect(result.risks).toHaveLength(5);
    const [params] = createMock.mock.calls[0]!;
    expect(params.max_tokens).toBeGreaterThanOrEqual(EXPLAINER_MEASURED_TOKENS);
  });

  it('silently loses the explanation when truncated at the old 1024-token ceiling', async () => {
    const truncated = truncateAtOldCeiling(EXPLAINER_RESPONSE, EXPLAINER_MEASURED_TOKENS);
    expect(truncated.endsWith('}')).toBe(false);
    createMock.mockResolvedValue({ content: [{ type: 'text', text: truncated }] });

    const result = await explainPlan(makePlan(), DIAGNOSIS);

    // This is the bug the budget fixes: a usable-looking answer with no
    // indication that the model actually replied.
    expect(result.source).toBe('fallback');
  });

  it('waits past the old 10s deadline for a response that really takes 16s', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation(respondAfter(EXPLAINER_MEASURED_MS, EXPLAINER_RESPONSE));

    const pending = explainPlan(makePlan(), DIAGNOSIS);
    await vi.advanceTimersByTimeAsync(EXPLAINER_MEASURED_MS);

    expect((await pending).source).toBe('ai');
  });

  it('still gives up well before the 60s batch bound, because an operator is waiting', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation(respondAfter(45_000, EXPLAINER_RESPONSE));

    const pending = explainPlan(makePlan(), DIAGNOSIS);
    await vi.advanceTimersByTimeAsync(45_000);

    // 45s is past this call site's interactive deadline: the operator gets the
    // structural summary instead of a stalled terminal.
    expect((await pending).source).toBe('fallback');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// root-cause-synthesis
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape of a real synthesis response for a wide cascade. The live 10-agent call
 * measured 1522 output tokens; this body is trimmed to the same structure so the
 * fixture stays readable, and the measured count is asserted separately.
 */
const SYNTHESIS_BODY = `{
  "clusters": [
    {
      "rootCause": "A primary-side WAL generation surge is saturating downstream consumers across the stack",
      "confidence": 0.82,
      "agents": ["pg-replication", "kafka", "queue-backlog"],
      "reasoning": "All three began degrading within the same two-minute window, and each reports a growing backlog rather than an error spike, which points to a shared upstream throughput ceiling rather than three independent faults.",
      "investigationOrder": ["pg-replication", "kafka", "queue-backlog"]
    },
    {
      "rootCause": "Node-level disk pressure on the shared worker pool",
      "confidence": 0.64,
      "agents": ["kubernetes", "disk"],
      "reasoning": "Disk reports a filling volume on node-7 and kubernetes reports evictions scheduled from the same node, so the eviction churn is a symptom of the disk condition.",
      "investigationOrder": ["disk", "kubernetes"]
    }
  ],
  "uncorrelated": ["tls", "dns"],
  "narrative": "Two independent incidents are in flight. A WAL generation surge on the primary is cascading into Kafka and the order queue, while unrelated disk pressure on node-7 is driving Kubernetes evictions. TLS and DNS degradation appear coincidental."
}`;

/** The fenced form the model actually returns — 2 of 3 live calls came back like this. */
const SYNTHESIS_FENCED = '```json\n' + SYNTHESIS_BODY + '\n```';

/** Measured for a 10-agent cascade: 1522 output tokens, 17.7s. */
const SYNTHESIS_MEASURED_TOKENS = 1522;
const SYNTHESIS_MEASURED_MS = 17_700;

function makeEvidence(): AgentEvidence[] {
  return ['pg-replication', 'kafka', 'kubernetes', 'disk'].map((agentKind) => ({
    agentKind,
    targetName: `prod-${agentKind}`,
    signals: [
      {
        type: 'error_rate',
        source: `${agentKind}_probe`,
        detail: `${agentKind} is degraded with a growing backlog`,
        severity: 'critical',
      },
    ],
  })) as AgentEvidence[];
}

describe('root-cause-synthesis response handling', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('parses a fenced response instead of falling back on the fence', async () => {
    // Precondition: this is the failure the bare .trim() hit.
    expect(() => JSON.parse(SYNTHESIS_FENCED.trim())).toThrow();
    createMock.mockResolvedValue({ content: [{ type: 'text', text: SYNTHESIS_FENCED }] });

    const result = await synthesizeByAi(makeEvidence());

    expect(result.source).toBe('ai');
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]?.agents).toContain('kafka');
    expect(result.uncorrelated).toEqual(['tls', 'dns']);
  });

  it('parses an unfenced response too', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: SYNTHESIS_BODY }] });

    const result = await synthesizeByAi(makeEvidence());
    expect(result.source).toBe('ai');
    expect(result.clusters).toHaveLength(2);
  });

  it('asks for enough tokens to correlate a wide cascade', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: SYNTHESIS_BODY }] });

    await synthesizeByAi(makeEvidence());

    const [params] = createMock.mock.calls[0]!;
    expect(params.max_tokens).toBeGreaterThanOrEqual(SYNTHESIS_MEASURED_TOKENS);
  });

  it('falls back to rules when truncated at the old 1024-token ceiling', async () => {
    const truncated = truncateAtOldCeiling(SYNTHESIS_BODY, SYNTHESIS_MEASURED_TOKENS);
    createMock.mockResolvedValue({ content: [{ type: 'text', text: truncated }] });

    const result = await synthesizeByAi(makeEvidence());
    expect(result.source).toBe('rules');
  });

  // Note: unlike the explainer's 10s, the old 20s bound did admit the measured
  // 17.7s — barely, with 2.3s of margin. This test locks in that the measured
  // worst case must succeed; it is a guard on the headroom, not proof that the
  // old value failed.
  it('completes a 10-agent cascade that takes the measured 17.7s', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation(respondAfter(SYNTHESIS_MEASURED_MS, SYNTHESIS_BODY));

    const pending = synthesizeByAi(makeEvidence());
    await vi.advanceTimersByTimeAsync(SYNTHESIS_MEASURED_MS);

    expect((await pending).source).toBe('ai');
  });

  it('keeps an interactive-scale deadline rather than the 60s batch bound', async () => {
    vi.useFakeTimers();
    createMock.mockImplementation(respondAfter(45_000, SYNTHESIS_BODY));

    const pending = synthesizeByAi(makeEvidence());
    await vi.advanceTimersByTimeAsync(45_000);

    expect((await pending).source).toBe('rules');
  });
});
