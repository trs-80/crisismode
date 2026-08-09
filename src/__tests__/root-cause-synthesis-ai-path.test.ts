// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `synthesizeByAi`'s gates, prompt assembly and response tolerance.
 *
 * `ai-response-budgets.test.ts` pins the budget and the code-fence handling —
 * the fence was the dominant live failure mode here, and stripping it is what
 * made 2 of 3 real calls usable. This file pins the surrounding behaviour: the
 * conditions under which no call is made at all, that every kind of evidence an
 * agent can carry actually reaches the prompt (evidence the model never sees
 * cannot be correlated), and that a partially shaped reply degrades into a
 * usable cluster list rather than an exception.
 *
 * Every path here ends in rule-based correlation on failure, so a regression is
 * invisible in output apart from `source` — which is why it is asserted
 * explicitly everywhere below. Hermetic: the SDK is mocked, the network profile
 * is written directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import type { NetworkProfile } from '@crisismode/agent-sdk';
import { synthesizeByAi, synthesizeByRules } from '../framework/root-cause-synthesis.js';
import type { AgentEvidence } from '../framework/root-cause-synthesis.js';
import { resetNetworkProfile, setNetworkProfile } from '../framework/network-profile.js';

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

function offlineProfile(): NetworkProfile {
  const checkedAt = '2026-08-09T12:00:00.000Z';
  return {
    internet: { status: 'unavailable', probes: [], checkedAt },
    hub: { status: 'unknown', probes: [], checkedAt },
    targets: { status: 'available', probes: [], checkedAt },
    dns: { available: false, latencyMs: 0 },
    mode: 'private_only',
    profiledAt: checkedAt,
  };
}

function twoAgents(): AgentEvidence[] {
  return ['postgresql', 'redis'].map((agentKind) => ({
    agentKind,
    targetName: `prod-${agentKind}`,
    signals: [
      {
        type: 'connection' as const,
        source: `${agentKind}_probe`,
        detail: 'refusing connections',
        severity: 'critical' as const,
      },
    ],
  }));
}

describe('synthesizeByAi — gates that skip the call entirely', () => {
  let originalApiKey: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('does not call the model for a single agent — there is nothing to correlate', async () => {
    const one = twoAgents().slice(0, 1);

    const result = await synthesizeByAi(one);

    expect(result.source).toBe('rules');
    expect(result.uncorrelated).toEqual(['postgresql']);
    expect(result.narrative).toContain('no cross-system correlation possible');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('does not call the model for empty evidence', async () => {
    const result = await synthesizeByAi([]);

    expect(result.source).toBe('rules');
    expect(result.narrative).toBe('No evidence provided for synthesis.');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to rules without an API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('rules');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to rules when the network profile reports no internet', async () => {
    setNetworkProfile(offlineProfile());

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('rules');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('falls back to rules and reports the reason on an API failure', async () => {
    createMock.mockRejectedValue(new Error('overloaded_error'));

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('rules');
    expect(errorSpy).toHaveBeenCalledWith('AI synthesis failed:', 'overloaded_error');
  });

  it('logs a non-Error rejection as-is', async () => {
    const thrown: unknown = 'socket hang up';
    createMock.mockRejectedValue(thrown);

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('rules');
    expect(errorSpy).toHaveBeenCalledWith('AI synthesis failed:', 'socket hang up');
  });
});

describe('synthesizeByAi — what the model is shown', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
  });

  afterEach(() => {
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  /**
   * Health signals, diagnosis findings and recurring patterns are the three
   * things an agent can contribute beyond raw signals. Evidence that never
   * reaches the prompt cannot be correlated, so a silent omission here would
   * degrade synthesis quality with no visible failure at all.
   */
  it('includes health signals, diagnosis findings and patterns in the prompt', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"clusters":[]}' }] });

    const evidence: AgentEvidence[] = [
      {
        agentKind: 'postgresql',
        targetName: 'prod-db',
        health: {
          status: 'unhealthy',
          confidence: 0.82,
          summary: 'Replication lag is growing',
          observedAt: '2026-08-09T12:00:00.000Z',
          signals: [
            {
              source: 'pg_stat_replication',
              status: 'critical',
              detail: 'replica 10.0.1.52 is 342s behind',
              observedAt: '2026-08-09T12:00:00.000Z',
            },
          ],
          recommendedActions: [],
        },
        diagnosis: {
          status: 'identified',
          scenario: 'replication_lag_cascade',
          confidence: 0.78,
          findings: [
            {
              source: 'pg_stat_replication',
              observation: 'All replicas share one sent_lsn',
              severity: 'warning',
              data: {},
            },
          ],
          diagnosticPlanNeeded: false,
        },
        patterns: [
          {
            pattern: 'degradation-cycle',
            occurrences: 4,
            firstSeen: '2026-08-09T11:00:00.000Z',
            lastSeen: '2026-08-09T12:00:00.000Z',
            description: 'lag climbs then partially recovers',
          },
        ],
      },
      {
        agentKind: 'redis',
        targetName: 'prod-cache',
        // No health, diagnosis or patterns — the builder must simply skip them.
        signals: [
          {
            type: 'latency',
            source: 'redis_probe',
            detail: 'p99 climbing',
            severity: 'warning',
          },
        ],
      },
    ];

    await synthesizeByAi(evidence);

    const [params] = createMock.mock.calls[0]!;
    const prompt = String(params.messages[0].content);

    expect(prompt).toContain('--- Agent: postgresql (target: prod-db) ---');
    expect(prompt).toContain('Health: unhealthy (82% confidence)');
    expect(prompt).toContain('Summary: Replication lag is growing');
    expect(prompt).toContain('Signal: [CRITICAL] pg_stat_replication: replica 10.0.1.52 is 342s behind');
    expect(prompt).toContain('Diagnosis: replication_lag_cascade (identified, 78%)');
    expect(prompt).toContain('Finding: [WARNING] All replicas share one sent_lsn');
    expect(prompt).toContain('Patterns: degradation-cycle (4x)');
    expect(prompt).toContain('--- Agent: redis (target: prod-cache) ---');
  });

  it('says "unknown" rather than "null" for a diagnosis with no scenario', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"clusters":[]}' }] });

    await synthesizeByAi([
      {
        agentKind: 'kafka',
        targetName: 'prod-kafka',
        diagnosis: {
          status: 'inconclusive',
          scenario: null,
          confidence: 0.2,
          findings: [],
          diagnosticPlanNeeded: true,
        },
      },
      { agentKind: 'flink', targetName: 'prod-flink' },
    ]);

    const [params] = createMock.mock.calls[0]!;
    expect(String(params.messages[0].content)).toContain('Diagnosis: unknown (inconclusive, 20%)');
  });
});

describe('synthesizeByAi — tolerating a partially shaped reply', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
  });

  afterEach(() => {
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('defaults uncorrelated and narrative when the model omits them', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{"clusters":[]}' }] });

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('ai');
    expect(result.clusters).toEqual([]);
    expect(result.uncorrelated).toEqual([]);
    expect(result.narrative).toBe('AI synthesis completed.');
  });

  /**
   * An empty object is valid JSON, so it is reported as an AI answer. "The
   * model found no correlation" is a legitimate result and must not be turned
   * into a crash by a missing key.
   */
  it('treats a reply with no clusters key as "no correlation found"', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });

    const result = await synthesizeByAi(twoAgents());

    expect(result.source).toBe('ai');
    expect(result.clusters).toEqual([]);
    expect(result.narrative).toBe('AI synthesis completed.');
  });

  it('reuses the agent list as the investigation order when none is given', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            clusters: [
              {
                rootCause: 'shared upstream throughput ceiling',
                confidence: 0.7,
                agents: ['postgresql', 'redis'],
                reasoning: 'both degraded in the same window',
              },
            ],
          }),
        },
      ],
    });

    const result = await synthesizeByAi(twoAgents());

    expect(result.clusters[0]?.investigationOrder).toEqual(['postgresql', 'redis']);
    // The AI path claims no temporal analysis — it has no snapshot timeline.
    expect(result.clusters[0]?.temporalCorrelation).toBe(false);
    expect(result.clusters[0]?.id).toBe('cluster-0');
  });

  /**
   * The model is asked for 0.0-1.0 and does not always comply. Confidence is an
   * ordering weight, so an out-of-range value would sort a cluster above every
   * legitimate one — clamping keeps the ranking meaningful.
   */
  it('clamps and rounds a confidence the model returned out of range', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            clusters: [
              { rootCause: 'too sure', confidence: 9, agents: ['a'], reasoning: 'r' },
              { rootCause: 'negative', confidence: -2, agents: ['b'], reasoning: 'r' },
              { rootCause: 'noisy', confidence: 0.6789, agents: ['c'], reasoning: 'r' },
            ],
          }),
        },
      ],
    });

    const result = await synthesizeByAi(twoAgents());

    expect(result.clusters.map((c) => c.confidence)).toEqual([1, 0, 0.68]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rule-based paths the AI gates fall back to
// ─────────────────────────────────────────────────────────────────────────

describe('synthesizeByRules — health signals as a correlation input', () => {
  /**
   * An agent that reports only a health assessment (no SymptomSignals) still
   * has to be correlatable: a `warning` health signal is read as latency and a
   * `critical` one as an error rate. This is how `scan` evidence reaches the
   * correlator, since scan produces assessments rather than symptom streams.
   */
  it('reads a warning health signal as latency', () => {
    const result = synthesizeByRules([
      makeHealthOnlyEvidence('kafka', 'warning'),
      makeHealthOnlyEvidence('flink', 'warning'),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.agents).toEqual(['kafka', 'flink']);
    expect(result.clusters[0]?.reasoning).toContain('streaming-backpressure');
  });

  it('reads a critical health signal as an error rate', () => {
    const result = synthesizeByRules([
      makeHealthOnlyEvidence('application', 'critical'),
      makeHealthOnlyEvidence('postgresql', 'critical'),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.reasoning).toContain('deploy-cascade');
  });
});

function makeHealthOnlyEvidence(
  agentKind: string,
  signalStatus: 'warning' | 'critical',
): AgentEvidence {
  return {
    agentKind,
    targetName: `prod-${agentKind}`,
    health: {
      // `recovering`, not `unhealthy`: this test is about signal-type mapping,
      // and an unhealthy assessment would also add a temporal-correlation boost.
      status: 'recovering',
      confidence: 0.6,
      summary: `${agentKind} is degraded`,
      observedAt: '2026-08-09T12:00:00.000Z',
      signals: [
        {
          source: `${agentKind}_probe`,
          status: signalStatus,
          detail: 'degraded',
          observedAt: '2026-08-09T12:00:00.000Z',
        },
      ],
      recommendedActions: [],
    },
  };
}

describe('synthesizeByRules — a trimmed cluster re-states only what survives', () => {
  /**
   * De-dup can strip agents out of a weaker cluster after a stronger one claims
   * them. When that happens the cluster's `reasoning` is re-rendered, and the
   * pattern count in it has to be recomputed from the survivors — the original
   * count was over the pre-trim membership, so reusing it would have the cluster
   * cite corroboration from evidence it no longer contains.
   *
   * Setup: `network-partition` scores 0.9 (four agents on connection signals,
   * two of them flapping) and claims etcd/postgresql/kafka/ceph.
   * `database-backpressure` scores 0.85 and matched postgresql, kafka and both
   * redis targets, so it is left holding only the two redis targets — which are
   * exactly the two carrying its `degradation-cycle` pattern.
   */
  it('recounts shared patterns over the surviving agents only', () => {
    const connection = (source: string) => [
      {
        type: 'connection' as const,
        source,
        detail: 'connection refused',
        severity: 'critical' as const,
      },
    ];
    const pattern = (name: string) => [
      {
        pattern: name,
        occurrences: 3,
        firstSeen: '2026-08-09T11:00:00.000Z',
        lastSeen: '2026-08-09T12:00:00.000Z',
        description: name,
      },
    ];

    const result = synthesizeByRules([
      { agentKind: 'etcd', targetName: 'etcd-1', signals: connection('etcd_probe'), patterns: pattern('flapping') },
      { agentKind: 'ceph', targetName: 'ceph-1', signals: connection('ceph_probe'), patterns: pattern('flapping') },
      { agentKind: 'postgresql', targetName: 'prod-db', signals: connection('pg_probe') },
      { agentKind: 'kafka', targetName: 'prod-kafka', signals: connection('kafka_probe') },
      { agentKind: 'redis', targetName: 'cache-a', signals: connection('redis_probe'), patterns: pattern('degradation-cycle') },
      { agentKind: 'redis', targetName: 'cache-b', signals: connection('redis_probe'), patterns: pattern('degradation-cycle') },
    ]);

    const partition = result.clusters.find((c) => c.reasoning.includes('network-partition'));
    expect(partition?.agents).toEqual(['etcd', 'ceph', 'postgresql', 'kafka']);

    const backpressure = result.clusters.find((c) => c.reasoning.includes('database-backpressure'));
    // Trimmed down to the two redis targets the stronger cluster did not claim.
    expect(backpressure?.agents).toEqual(['redis', 'redis']);
    expect(backpressure?.reasoning).toContain('2 agents share signal types');
    expect(backpressure?.reasoning).toContain('2 share patterns');
    // And its prose no longer names an agent it lost.
    expect(backpressure?.investigationOrder).toEqual(['redis']);
  });
});

describe('synthesizeByRules — same-entity requirement', () => {
  /**
   * `iac-out-of-band-change` is the one rule that requires a shared entity id.
   * Evidence that carries no ids at all must not satisfy it: pairing an
   * arbitrary drift report with an arbitrary RDS instance would assert a
   * causal link between two things that may not even be the same resource.
   */
  it('does not fire when neither agent declares an entity id', () => {
    const result = synthesizeByRules([
      {
        agentKind: 'iac-drift',
        targetName: 'terraform-prod',
        signals: [
          {
            type: 'config_mismatch',
            source: 'terraform_plan',
            detail: 'instance class changed outside Terraform',
            severity: 'warning',
          },
        ],
      },
      {
        agentKind: 'aws-rds',
        targetName: 'prod-db',
        signals: [
          {
            type: 'connection',
            source: 'rds_describe',
            detail: 'connection limit reached',
            severity: 'critical',
          },
        ],
      },
    ]);

    expect(result.clusters.map((c) => c.reasoning).join(' ')).not.toContain(
      'iac-out-of-band-change',
    );
  });
});
