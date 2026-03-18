// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Root cause synthesis — correlates signals across multiple agents and systems
 * to identify shared root causes that no single agent would detect alone.
 *
 * For example: a deploy causes both database connection exhaustion AND Redis
 * memory pressure → synthesiser links both to the deploy event rather than
 * treating them as independent incidents.
 *
 * Two modes:
 * - Rule-based correlation: fast, deterministic, no external calls
 * - AI-assisted synthesis: uses Claude to reason across multi-system evidence
 */

import { sanitizeInput } from './ai-diagnosis.js';
import { getNetworkProfile } from './network-profile.js';
import type { RoutingResult, ScoredScenario, SymptomSignal } from './symptom-router.js';
import type { RecurringPattern, HealthSnapshot } from './watch-state.js';
import type { HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

// ── Types ──

export interface AgentEvidence {
  agentKind: string;
  targetName: string;
  health?: HealthAssessment;
  diagnosis?: DiagnosisResult;
  signals?: SymptomSignal[];
  patterns?: RecurringPattern[];
  snapshots?: HealthSnapshot[];
}

export interface CorrelationCluster {
  /** Unique identifier for this cluster */
  id: string;
  /** Human-readable label for the shared root cause */
  rootCause: string;
  /** Confidence that these agents share a common root cause (0-1) */
  confidence: number;
  /** Which agents are involved */
  agents: string[];
  /** What correlation rule or AI reasoning linked them */
  reasoning: string;
  /** Temporal correlation: did they degrade at roughly the same time? */
  temporalCorrelation: boolean;
  /** Suggested investigation order (most likely cause first) */
  investigationOrder: string[];
}

export interface SynthesisResult {
  /** Correlated clusters of related failures */
  clusters: CorrelationCluster[];
  /** Standalone agents with no cross-system correlation */
  uncorrelated: string[];
  /** Overall narrative explaining the incident */
  narrative: string;
  /** Source of synthesis: rule-based or AI */
  source: 'rules' | 'ai' | 'fallback';
  /** Timestamp of synthesis */
  synthesizedAt: string;
}

// ── Correlation rules ──

interface CorrelationRule {
  name: string;
  /** Which agent kinds this rule links together */
  agentKinds: string[];
  /** Shared signal types that trigger this correlation */
  sharedSignalTypes: SymptomSignal['type'][];
  /** Shared patterns that trigger this correlation */
  sharedPatterns: string[];
  /** Root cause template */
  rootCauseTemplate: string;
  /** Investigation order (first = most likely upstream cause) */
  investigationOrder: string[];
  /** Base confidence boost when this rule fires */
  confidenceBoost: number;
}

const CORRELATION_RULES: CorrelationRule[] = [
  {
    name: 'deploy-cascade',
    agentKinds: ['application', 'postgresql', 'redis', 'kafka', 'application-config'],
    sharedSignalTypes: ['deploy_change', 'error_rate'],
    sharedPatterns: ['flapping'],
    rootCauseTemplate: 'Recent deployment triggered cascading failures across {agents}',
    investigationOrder: ['application', 'application-config', 'postgresql', 'redis', 'kafka'],
    confidenceBoost: 0.3,
  },
  {
    name: 'database-backpressure',
    agentKinds: ['postgresql', 'redis', 'kafka'],
    sharedSignalTypes: ['latency', 'timeout', 'connection'],
    sharedPatterns: ['degradation-cycle'],
    rootCauseTemplate: 'Database backpressure propagating through caching and messaging layers',
    investigationOrder: ['postgresql', 'redis', 'kafka'],
    confidenceBoost: 0.25,
  },
  {
    name: 'resource-exhaustion-cascade',
    agentKinds: ['kubernetes', 'postgresql', 'redis', 'ceph'],
    sharedSignalTypes: ['resource_exhaustion'],
    sharedPatterns: ['persistent-unhealthy'],
    rootCauseTemplate: 'Resource exhaustion in infrastructure layer affecting dependent services',
    investigationOrder: ['kubernetes', 'ceph', 'postgresql', 'redis'],
    confidenceBoost: 0.25,
  },
  {
    name: 'network-partition',
    agentKinds: ['etcd', 'kafka', 'postgresql', 'ceph'],
    sharedSignalTypes: ['connection', 'timeout'],
    sharedPatterns: ['flapping'],
    rootCauseTemplate: 'Network connectivity issues causing simultaneous failures across distributed systems',
    investigationOrder: ['etcd', 'kafka', 'postgresql', 'ceph'],
    confidenceBoost: 0.3,
  },
  {
    name: 'config-drift-cascade',
    agentKinds: ['application-config', 'postgresql', 'redis', 'ai-provider'],
    sharedSignalTypes: ['config_mismatch', 'connection'],
    sharedPatterns: [],
    rootCauseTemplate: 'Configuration drift causing connection failures to backing services',
    investigationOrder: ['application-config', 'ai-provider', 'postgresql', 'redis'],
    confidenceBoost: 0.2,
  },
  {
    name: 'streaming-backpressure',
    agentKinds: ['kafka', 'flink', 'redis'],
    sharedSignalTypes: ['queue_depth', 'latency', 'timeout'],
    sharedPatterns: ['degradation-cycle'],
    rootCauseTemplate: 'Streaming pipeline backpressure from {agents} — data processing bottleneck',
    investigationOrder: ['flink', 'kafka', 'redis'],
    confidenceBoost: 0.25,
  },
];

// ── Rule-based correlation ──

/**
 * Correlate multi-agent evidence using deterministic rules.
 *
 * Groups agents into clusters when they share signal types, patterns,
 * or temporal degradation windows.
 */
export function synthesizeByRules(evidence: AgentEvidence[]): SynthesisResult {
  if (evidence.length <= 1) {
    return {
      clusters: [],
      uncorrelated: evidence.map((e) => e.agentKind),
      narrative: evidence.length === 1
        ? `Single agent (${evidence[0].agentKind}) — no cross-system correlation possible.`
        : 'No evidence provided for synthesis.',
      source: 'rules',
      synthesizedAt: new Date().toISOString(),
    };
  }

  const clusters: CorrelationCluster[] = [];
  const clusteredAgents = new Set<string>();
  let clusterIdx = 0;

  // Collect all signal types and patterns per agent
  const agentSignalTypes = new Map<string, Set<SymptomSignal['type']>>();
  const agentPatterns = new Map<string, Set<string>>();

  for (const e of evidence) {
    const signalTypes = new Set<SymptomSignal['type']>();
    if (e.signals) {
      for (const s of e.signals) signalTypes.add(s.type);
    }
    if (e.health) {
      for (const s of e.health.signals) {
        if (s.status === 'critical') signalTypes.add('error_rate');
        if (s.status === 'warning') signalTypes.add('latency');
      }
    }
    agentSignalTypes.set(e.agentKind, signalTypes);

    const patterns = new Set<string>();
    if (e.patterns) {
      for (const p of e.patterns) patterns.add(p.pattern);
    }
    agentPatterns.set(e.agentKind, patterns);
  }

  // Try each correlation rule
  for (const rule of CORRELATION_RULES) {
    const matchingAgents = evidence.filter((e) => rule.agentKinds.includes(e.agentKind));
    if (matchingAgents.length < 2) continue;

    // Count how many agents share the rule's signal types
    let signalMatches = 0;
    let patternMatches = 0;

    for (const agent of matchingAgents) {
      const types = agentSignalTypes.get(agent.agentKind);
      if (types && rule.sharedSignalTypes.some((t) => types.has(t))) {
        signalMatches++;
      }
      const patterns = agentPatterns.get(agent.agentKind);
      if (patterns && rule.sharedPatterns.some((p) => patterns.has(p))) {
        patternMatches++;
      }
    }

    // Need at least 2 agents sharing signals to form a cluster
    if (signalMatches < 2) continue;

    const agentNames = matchingAgents.map((a) => a.agentKind);
    const temporal = hasTemporalCorrelation(matchingAgents);

    let confidence = 0.3 + (signalMatches / matchingAgents.length) * 0.3;
    if (patternMatches >= 2) confidence += rule.confidenceBoost;
    if (temporal) confidence += 0.15;
    confidence = Math.min(confidence, 1.0);
    confidence = Math.round(confidence * 100) / 100;

    const rootCause = rule.rootCauseTemplate.replace(
      '{agents}',
      agentNames.join(', '),
    );

    const investigationOrder = rule.investigationOrder.filter((a) =>
      agentNames.includes(a),
    );

    clusters.push({
      id: `cluster-${clusterIdx++}`,
      rootCause,
      confidence,
      agents: agentNames,
      reasoning: `Rule "${rule.name}": ${signalMatches} agents share signal types [${rule.sharedSignalTypes.join(', ')}]${patternMatches > 0 ? `, ${patternMatches} share patterns` : ''}${temporal ? ', temporally correlated' : ''}`,
      temporalCorrelation: temporal,
      investigationOrder,
    });

    for (const name of agentNames) clusteredAgents.add(name);
  }

  // De-duplicate: if an agent appears in multiple clusters, keep highest confidence
  const bestClusterPerAgent = new Map<string, number>();
  for (let i = 0; i < clusters.length; i++) {
    for (const agent of clusters[i].agents) {
      const existing = bestClusterPerAgent.get(agent);
      if (existing === undefined || clusters[i].confidence > clusters[existing].confidence) {
        bestClusterPerAgent.set(agent, i);
      }
    }
  }

  // Sort by confidence descending
  clusters.sort((a, b) => b.confidence - a.confidence);

  const uncorrelated = evidence
    .map((e) => e.agentKind)
    .filter((a) => !clusteredAgents.has(a));

  const narrative = buildNarrative(clusters, uncorrelated);

  return {
    clusters,
    uncorrelated,
    narrative,
    source: 'rules',
    synthesizedAt: new Date().toISOString(),
  };
}

// ── AI-assisted synthesis ──

const SYNTHESIS_SYSTEM_PROMPT = `You are a root cause analyst for CrisisMode, an infrastructure recovery framework. You receive evidence from multiple recovery agents that are simultaneously detecting problems.

Your job is to identify shared root causes — failures in one system that cascade to others. For example:
- A bad deploy causes both database connection spikes AND cache misses
- A network partition affects etcd consensus AND Kafka replication
- Resource exhaustion on Kubernetes nodes affects all hosted services

Respond with ONLY a JSON object (no markdown):
{
  "clusters": [
    {
      "rootCause": "one-sentence description of the shared root cause",
      "confidence": 0.0-1.0,
      "agents": ["agent-kind-1", "agent-kind-2"],
      "reasoning": "why you believe these are linked",
      "investigationOrder": ["start-here", "then-check-this"]
    }
  ],
  "uncorrelated": ["agent-kinds-that-seem-independent"],
  "narrative": "2-3 sentence overall incident summary"
}`;

/**
 * Use AI to synthesize root causes from multi-agent evidence.
 * Falls back to rule-based correlation on failure.
 */
export async function synthesizeByAi(evidence: AgentEvidence[]): Promise<SynthesisResult> {
  if (evidence.length <= 1) {
    return synthesizeByRules(evidence);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return synthesizeByRules(evidence);
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    return synthesizeByRules(evidence);
  }

  try {
    return await callSynthesisAi(evidence, apiKey);
  } catch (err) {
    console.error('AI synthesis failed:', err instanceof Error ? err.message : err);
    return synthesizeByRules(evidence);
  }
}

async function callSynthesisAi(
  evidence: AgentEvidence[],
  apiKey: string,
): Promise<SynthesisResult> {
  const parts: string[] = ['Multi-agent evidence for root cause analysis:\n'];

  for (const e of evidence) {
    parts.push(`--- Agent: ${e.agentKind} (target: ${e.targetName}) ---`);
    if (e.health) {
      parts.push(`  Health: ${e.health.status} (${(e.health.confidence * 100).toFixed(0)}% confidence)`);
      parts.push(`  Summary: ${e.health.summary}`);
      for (const s of e.health.signals) {
        parts.push(`  Signal: [${s.status.toUpperCase()}] ${s.source}: ${s.detail}`);
      }
    }
    if (e.diagnosis) {
      parts.push(`  Diagnosis: ${e.diagnosis.scenario ?? 'unknown'} (${e.diagnosis.status}, ${(e.diagnosis.confidence * 100).toFixed(0)}%)`);
      for (const f of e.diagnosis.findings) {
        parts.push(`  Finding: [${f.severity.toUpperCase()}] ${f.observation}`);
      }
    }
    if (e.patterns && e.patterns.length > 0) {
      parts.push(`  Patterns: ${e.patterns.map((p) => `${p.pattern} (${p.occurrences}x)`).join(', ')}`);
    }
    parts.push('');
  }

  const userMessage = sanitizeInput(parts.join('\n'));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: userMessage }],
        system: SYNTHESIS_SYSTEM_PROMPT,
      },
      { signal: controller.signal },
    );

    clearTimeout(timeoutId);

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('');

    const parsed = JSON.parse(text.trim()) as {
      clusters?: Array<{
        rootCause: string;
        confidence: number;
        agents: string[];
        reasoning: string;
        investigationOrder?: string[];
      }>;
      uncorrelated?: string[];
      narrative?: string;
    };

    const clusters: CorrelationCluster[] = (parsed.clusters ?? []).map((c, i) => ({
      id: `cluster-${i}`,
      rootCause: c.rootCause,
      confidence: Math.round(Math.min(Math.max(c.confidence, 0), 1) * 100) / 100,
      agents: c.agents,
      reasoning: c.reasoning,
      temporalCorrelation: false,
      investigationOrder: c.investigationOrder ?? c.agents,
    }));

    return {
      clusters,
      uncorrelated: parsed.uncorrelated ?? [],
      narrative: parsed.narrative ?? 'AI synthesis completed.',
      source: 'ai',
      synthesizedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ── Helpers ──

/**
 * Detect temporal correlation: did multiple agents degrade within a similar time window?
 * Uses the most recent unhealthy snapshot timestamps; considers agents correlated
 * if they went unhealthy within 5 minutes of each other.
 */
function hasTemporalCorrelation(evidence: AgentEvidence[]): boolean {
  const unhealthyTimes: number[] = [];

  for (const e of evidence) {
    if (e.snapshots) {
      // Find the most recent transition to unhealthy
      for (let i = e.snapshots.length - 1; i >= 0; i--) {
        if (e.snapshots[i].status === 'unhealthy') {
          unhealthyTimes.push(new Date(e.snapshots[i].timestamp).getTime());
          break;
        }
      }
    } else if (e.health && e.health.status === 'unhealthy') {
      unhealthyTimes.push(new Date(e.health.observedAt).getTime());
    }
  }

  if (unhealthyTimes.length < 2) return false;

  const sorted = unhealthyTimes.sort((a, b) => a - b);
  const windowMs = 5 * 60 * 1000; // 5 minutes
  return (sorted[sorted.length - 1] - sorted[0]) <= windowMs;
}

function buildNarrative(
  clusters: CorrelationCluster[],
  uncorrelated: string[],
): string {
  if (clusters.length === 0 && uncorrelated.length === 0) {
    return 'No evidence to synthesize.';
  }

  const parts: string[] = [];

  if (clusters.length > 0) {
    const top = clusters[0];
    parts.push(`Primary root cause (${(top.confidence * 100).toFixed(0)}% confidence): ${top.rootCause}.`);
    parts.push(`Investigate in this order: ${top.investigationOrder.join(' → ')}.`);

    if (clusters.length > 1) {
      parts.push(`${clusters.length - 1} additional correlated failure cluster(s) detected.`);
    }
  }

  if (uncorrelated.length > 0) {
    parts.push(`Independent issues in: ${uncorrelated.join(', ')}.`);
  }

  return parts.join(' ');
}

/**
 * Convenience: synthesize from routing results instead of raw evidence.
 * Useful when you have multiple routing results from different symptom streams.
 */
export function synthesizeFromRoutingResults(
  results: RoutingResult[],
): SynthesisResult {
  const evidence: AgentEvidence[] = [];

  for (const result of results) {
    for (const scenario of result.scenarios) {
      if (scenario.confidence >= 0.3) {
        evidence.push({
          agentKind: scenario.agentKind,
          targetName: scenario.scenario,
          signals: result.evidence.map((e) => ({
            type: 'custom' as const,
            source: 'routing',
            detail: e,
            severity: 'warning' as const,
          })),
        });
      }
    }
  }

  return synthesizeByRules(evidence);
}
