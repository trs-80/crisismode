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
 *
 * ── THE CORRELATION RULE SET IS FROZEN ──
 *
 * `CORRELATION_RULES` is closed. Do not add a rule unless BOTH hold:
 *
 *   1. A new agent class ships, and
 *   2. it brings a concretely evidenced signal pairing — an incident actually
 *      observed, with the two signals named, not a plausible-sounding story.
 *
 * No speculative incident templates. Real incidents are combinatorial: each
 * rule multiplies the cross-rule interaction surface, and every bug in this
 * file so far (pairwise `requiredTypesByKind`, evidence-reference keying of
 * the signal maps, the third-target veto, the dead per-agent de-dup) came
 * from rules interacting, not from a rule being individually wrong.
 *
 * What a match means: these signals have co-occurred in this shape before.
 * That is an investigation hint, not a diagnosis, and output layers must
 * render it that way. `CorrelationCluster.confidence` is an ordering weight,
 * never odds. `CORRELATION_RULE_NAMES` is enforced by a test; CONTRIBUTING.md
 * carries the same policy for contributors.
 *
 * ── ADVISORY OVERLAYS ──
 *
 * `ADVISORY_RULE_NAMES` (currently just `observer-environment`) lists rules
 * that answer "is the problem this machine?" rather than "which system
 * broke?". They are exempt from the one-agent-one-cluster de-dup: they claim
 * no agents and co-exist with the specific cluster. Adding a rule to that set
 * is as much a policy decision as adding a rule at all — an overlay is never
 * suppressed by a stronger cluster, so it must be one an operator always
 * wants to see.
 */

import { sanitizeInput } from './ai-diagnosis.js';
import { getNetworkProfile } from './network-profile.js';
import type { RoutingResult, SymptomSignal } from './symptom-router.js';
import type { RecurringPattern, HealthSnapshot } from './watch-state.js';
import type { HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import { defaultAiModel } from './ai-model.js';
import { callClaude } from './ai-client.js';

// ── Types ──

export interface AgentEvidence {
  agentKind: string;
  targetName: string;
  health?: HealthAssessment;
  diagnosis?: DiagnosisResult;
  signals?: SymptomSignal[];
  patterns?: RecurringPattern[];
  snapshots?: HealthSnapshot[];
  /** Identifiers of the concrete entities (e.g. instance ids) this agent's evidence concerns. */
  entityIds?: string[];
}

export interface CorrelationCluster {
  /** Unique identifier for this cluster */
  id: string;
  /** Human-readable label for the shared root cause */
  rootCause: string;
  /**
   * Ordering weight for this cluster (0-1) — NOT a probability that the
   * pattern is the real cause. It ranks clusters against each other and
   * drives de-duplication; rendered output must never present it as odds.
   */
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
  /**
   * Per-agent-kind override: when an agent's kind has an entry here, that
   * agent matches ONLY if its signal types intersect this kind-specific
   * list, instead of the rule's general `sharedSignalTypes`. Agent kinds
   * without an entry keep matching via `sharedSignalTypes` as before.
   * Use this to disambiguate rules whose `sharedSignalTypes` overlap
   * enough that unrelated agent-kind combinations would otherwise both
   * satisfy the same rule (e.g. two rules both listing `'connection'`).
   */
  requiredTypesByKind?: Partial<Record<string, SymptomSignal['type'][]>>;
  /**
   * When true, the rule fires only when at least two matched agents report a
   * common entity id (`AgentEvidence.entityIds`). Agents with no entity ids
   * fail the requirement — the rule prefers silence over a guessed pairing
   * (the Arc 2 co-firing lesson: matching on signal type alone is not enough
   * to safely pair two agents' evidence about what may be different targets).
   */
  requireSharedEntityId?: boolean;
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
  {
    name: 'component-failure-cascade',
    agentKinds: ['postgresql', 'redis', 'kafka', 'etcd', 'application'],
    sharedSignalTypes: ['connection', 'resource_exhaustion'],
    sharedPatterns: [],
    rootCauseTemplate: 'A hard component failure appears to be cascading into dependent-service pressure across {agents} — investigate the unreachable component first',
    investigationOrder: ['etcd', 'postgresql', 'kafka', 'redis', 'application'],
    confidenceBoost: 0.25,
  },
  {
    name: 'observer-environment',
    agentKinds: ['dns', 'network', 'postgresql', 'redis', 'kafka', 'etcd', 'application'],
    sharedSignalTypes: ['connection', 'timeout'],
    sharedPatterns: [],
    rootCauseTemplate:
      'Local DNS/network problems on this host may explain simultaneous unreachability of {agents} — verify this machine\'s connectivity before acting on the services',
    investigationOrder: ['dns', 'network', 'etcd', 'postgresql', 'redis', 'kafka', 'application'],
    confidenceBoost: 0.3,
  },
  {
    name: 'rds-platform-degraded',
    agentKinds: ['aws-rds', 'postgresql', 'managed-database'],
    sharedSignalTypes: ['resource_exhaustion', 'connection', 'timeout'],
    // aws-rds only counts toward this rule when it shows genuine resource
    // exhaustion (storage/limits) — not merely a connection-path signal,
    // which belongs to rds-reachability instead.
    requiredTypesByKind: { 'aws-rds': ['resource_exhaustion'] },
    sharedPatterns: [],
    rootCauseTemplate: 'The AWS RDS platform under the database is degraded — fix the instance (storage/limits) before debugging the database itself',
    investigationOrder: ['aws-rds', 'postgresql', 'managed-database'],
    confidenceBoost: 0.3,
  },
  {
    name: 'rds-reachability',
    agentKinds: ['aws-rds', 'postgresql'],
    sharedSignalTypes: ['connection', 'timeout'],
    // aws-rds only counts toward this rule on a connection-path signal
    // (security groups, connection limits) — not resource exhaustion,
    // which belongs to rds-platform-degraded instead.
    requiredTypesByKind: { 'aws-rds': ['connection'] },
    sharedPatterns: [],
    rootCauseTemplate: 'AWS\'s control plane shows a connection-path problem (security groups or connection limits) — check reachability and limits before debugging the database itself',
    investigationOrder: ['aws-rds', 'postgresql'],
    confidenceBoost: 0.25,
  },
  {
    name: 'iac-out-of-band-change',
    agentKinds: ['iac-drift', 'aws-rds'],
    sharedSignalTypes: ['config_mismatch', 'resource_exhaustion', 'connection', 'timeout', 'error_rate'],
    // iac-drift counts only on an actual drift signal; aws-rds on any of its
    // platform signals. Same-entity matching below is what makes the pairing safe.
    requiredTypesByKind: { 'iac-drift': ['config_mismatch'] },
    requireSharedEntityId: true,
    sharedPatterns: [],
    rootCauseTemplate: 'The degraded RDS instance was changed outside Terraform — the out-of-band change is the likely cause; reconcile it (terraform plan first) before deeper platform debugging',
    investigationOrder: ['iac-drift', 'aws-rds'],
    confidenceBoost: 0.3,
  },
];

/**
 * The frozen roster, derived from the rules themselves so the two can never
 * disagree. A test pins this list — changing it is a deliberate act that
 * requires updating the freeze policy above and in CONTRIBUTING.md.
 */
export const CORRELATION_RULE_NAMES: readonly string[] = CORRELATION_RULES.map((r) => r.name);

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
        ? `Single agent (${evidence[0]!.agentKind}) — no cross-system correlation possible.`
        : 'No evidence provided for synthesis.',
      source: 'rules',
      synthesizedAt: new Date().toISOString(),
    };
  }

  // Clusters are built alongside the rule that produced them and the
  // specific evidence references that matched (clusterAgents), so the de-dup
  // pass below can re-render a cluster's text — and recompute claims like
  // temporal correlation — from the survivors' actual evidence if it loses
  // agents. Re-deriving those refs from `evidence` by agentKind instead would
  // reintroduce the kind-keyed lookup bug fixed elsewhere in this file (see
  // the header comment): two same-kind targets need distinct references.
  const built: Array<{ cluster: CorrelationCluster; rule: CorrelationRule; clusterAgents: AgentEvidence[] }> = [];

  // Collect all signal types and patterns per agent. Keyed by the
  // AgentEvidence object reference, not agentKind — two evidence items can
  // share a kind (e.g. two aws-rds targets), and keying by kind let a later
  // same-kind item silently overwrite an earlier one's entry, making
  // correlation order-dependent on the input array (see the reversed-order
  // regression test for iac-out-of-band-change).
  const agentSignalTypes = new Map<AgentEvidence, Set<SymptomSignal['type']>>();
  const agentPatterns = new Map<AgentEvidence, Set<string>>();

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
    agentSignalTypes.set(e, signalTypes);

    const patterns = new Set<string>();
    if (e.patterns) {
      for (const p of e.patterns) patterns.add(p.pattern);
    }
    agentPatterns.set(e, patterns);
  }

  // Try each correlation rule
  for (const rule of CORRELATION_RULES) {
    const matchingAgents = evidence.filter((e) => rule.agentKinds.includes(e.agentKind));
    if (matchingAgents.length < 2) continue;

    // Count how many agents share the rule's signal types
    let signalMatches = 0;
    let patternMatches = 0;
    const passedSignalAgents: AgentEvidence[] = [];

    for (const agent of matchingAgents) {
      const types = agentSignalTypes.get(agent);
      const requiredTypes = rule.requiredTypesByKind?.[agent.agentKind] ?? rule.sharedSignalTypes;
      if (types && requiredTypes.some((t) => types.has(t))) {
        signalMatches++;
        passedSignalAgents.push(agent);
      }
      const patterns = agentPatterns.get(agent);
      if (patterns && rule.sharedPatterns.some((p) => patterns.has(p))) {
        patternMatches++;
      }
    }

    // Need at least 2 agents sharing signals to form a cluster
    if (signalMatches < 2) continue;

    // Cluster membership is the agents the rule actually matched. An agent
    // whose kind merely appears in `rule.agentKinds`, but which reported none
    // of the rule's signal types, is not evidence for this pattern: naming it
    // in the cluster (and removing it from `uncorrelated`) asserts a link the
    // evidence does not support. The confidence arithmetic above is unchanged
    // — its denominator stays the full kind-matched set, so scoping the claim
    // never inflates the number attached to it.
    let clusterAgents = passedSignalAgents;

    if (rule.requireSharedEntityId) {
      // Pair only agents that themselves passed the per-agent signal check —
      // an evidence item that didn't match the rule's signal types shouldn't
      // be able to veto (or corroborate) a pairing between two agents that
      // did. Require the shared id to span at least two DISTINCT agent
      // kinds: two evidence items of the same kind sharing an id says
      // nothing about cross-system correlation, and a third same-kind
      // target with a different id must not be able to block the pairing
      // between the other two (the "third-target veto" bug).
      const idToAgents = new Map<string, AgentEvidence[]>();
      for (const agent of passedSignalAgents) {
        for (const id of agent.entityIds ?? []) {
          const group = idToAgents.get(id) ?? [];
          group.push(agent);
          idToAgents.set(id, group);
        }
      }
      const sharingAgents = new Set<AgentEvidence>();
      for (const group of idToAgents.values()) {
        if (new Set(group.map((a) => a.agentKind)).size >= 2) {
          for (const a of group) sharingAgents.add(a);
        }
      }
      if (sharingAgents.size === 0) continue;
      clusterAgents = passedSignalAgents.filter((a) => sharingAgents.has(a));
    }

    const agentNames = clusterAgents.map((a) => a.agentKind);
    const temporal = hasTemporalCorrelation(clusterAgents);

    let confidence = 0.3 + (signalMatches / matchingAgents.length) * 0.3;
    // Rules that declare no patterns can never corroborate via patternMatches —
    // their boost applies on signal agreement alone.
    if (patternMatches >= 2 || (rule.sharedPatterns.length === 0 && signalMatches >= 2)) {
      confidence += rule.confidenceBoost;
    }
    if (temporal) confidence += 0.15;
    confidence = Math.min(confidence, 1.0);
    confidence = Math.round(confidence * 100) / 100;

    built.push({
      cluster: {
        id: 'pending',
        rootCause: rule.rootCauseTemplate.replace('{agents}', agentNames.join(', ')),
        confidence,
        agents: agentNames,
        reasoning: `Rule "${rule.name}": ${signalMatches} agents share signal types [${rule.sharedSignalTypes.join(', ')}]${patternMatches > 0 ? `, ${patternMatches} share patterns` : ''}${temporal ? ', temporally correlated' : ''}`,
        temporalCorrelation: temporal,
        investigationOrder: rule.investigationOrder.filter((a) =>
          agentNames.includes(a),
        ),
      },
      rule,
      clusterAgents,
    });
  }

  /**
   * Advisory overlays are exempt from the winner-take-all pass below — see
   * the freeze-policy header. `observer-environment` answers a different
   * question than the specific rules ("is the problem this machine?" vs
   * "which system broke?"), so both answers are worth having at once. It
   * also declares no `sharedPatterns`, which means its 0.3 boost applies on
   * signal agreement alone: it scores 0.9 against any two agents reporting
   * connection/timeout, above every specific rule that lacks pattern
   * evidence. Letting it compete would make it the near-universal winner
   * and silence the specific answer.
   */
  const ADVISORY_RULE_NAMES = new Set(['observer-environment']);

  // De-duplicate the specific rules: an agent contributes to at most its
  // best-matching cluster. Rules overlap by design (two RDS rules can both
  // match one aws-rds target reporting two kinds of signal), and reporting
  // the same agents twice presents one incident as two. Strongest first —
  // ties keep rule declaration order, since the sort is stable — each agent
  // is claimed once, and a cluster left with fewer than two agents is
  // dropped: a "cluster" of one is not cross-system correlation. A cluster
  // that loses an agent gets its rootCause and investigationOrder
  // re-rendered so its text never names an agent it no longer contains.
  //
  // Claims are keyed by the AgentEvidence object reference, not agentKind —
  // two evidence items can share a kind (e.g. two distinct redis targets),
  // and a string-keyed Set collapsed both into one 'redis' entry. That let a
  // stronger cluster's claim on ONE same-kind target silently also strip an
  // unrelated same-kind target out of a later, weaker cluster it was never
  // part of (see the config-drift-cascade/streaming-backpressure regression
  // test). Filtering `clusterAgents` (the evidence array) instead of
  // `cluster.agents` (the derived kind-name array) fixes this regardless of
  // how many evidence items share a kind.
  built.sort((a, b) => b.cluster.confidence - a.cluster.confidence);

  const specific: CorrelationCluster[] = [];
  const advisory: CorrelationCluster[] = [];
  const claimed = new Set<AgentEvidence>();

  for (const { cluster, rule, clusterAgents } of built) {
    if (ADVISORY_RULE_NAMES.has(rule.name)) {
      advisory.push(cluster);
      continue;
    }
    const survivingAgents = clusterAgents.filter((a) => !claimed.has(a));
    if (survivingAgents.length < 2) continue;
    for (const a of survivingAgents) claimed.add(a);

    const agents = survivingAgents.map((a) => a.agentKind);

    // If this cluster lost agents during de-dup, recalculate reasoning and
    // temporal correlation so both reflect the actual survivors, not the
    // original (pre-trim) membership — a trimmed cluster must never claim
    // support its surviving evidence doesn't have.
    let reasoning = cluster.reasoning;
    let temporalCorrelation = cluster.temporalCorrelation;
    if (survivingAgents.length < clusterAgents.length) {
      // Every survivor came from `passedSignalAgents`, so it passed the
      // rule's per-agent signal check by construction — signalMatches is
      // just the survivor count, no re-checking needed.
      const signalMatches = survivingAgents.length;
      let patternMatches = 0;
      for (const agentEv of survivingAgents) {
        const patterns = agentPatterns.get(agentEv);
        if (patterns && rule.sharedPatterns.some((p) => patterns.has(p))) {
          patternMatches++;
        }
      }
      temporalCorrelation = hasTemporalCorrelation(survivingAgents);
      reasoning = `Rule "${rule.name}": ${signalMatches} agents share signal types [${rule.sharedSignalTypes.join(', ')}]${patternMatches > 0 ? `, ${patternMatches} share patterns` : ''}${temporalCorrelation ? ', temporally correlated' : ''}`;
    }

    specific.push({
      ...cluster,
      agents,
      rootCause: rule.rootCauseTemplate.replace('{agents}', agents.join(', ')),
      investigationOrder: rule.investigationOrder.filter((a) => agents.includes(a)),
      reasoning,
      temporalCorrelation,
    });
  }

  // Specific clusters first, so the narrative leads with what broke and the
  // advisory rides along behind it. Ids are assigned last, over the
  // combined list, so they stay contiguous.
  const clusters: CorrelationCluster[] = [...specific, ...advisory].map((cluster, i) => ({
    ...cluster,
    id: `cluster-${i}`,
  }));

  // An agent named in ANY surviving cluster — advisory included — is not
  // uncorrelated.
  const clusteredAgents = new Set(clusters.flatMap((c) => c.agents));

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

  const text = await callClaude({
    system: SYNTHESIS_SYSTEM_PROMPT,
    user: userMessage,
    model: defaultAiModel(),
    maxTokens: 1024,
    timeoutMs: 20_000,
    apiKey,
  });

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
        if (e.snapshots[i]!.status === 'unhealthy') {
          unhealthyTimes.push(new Date(e.snapshots[i]!.timestamp).getTime());
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
  return (sorted[sorted.length - 1]! - sorted[0]!) <= windowMs;
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
    // Investigation-path framing, not root-cause assertion: a rule match
    // means these signals have co-occurred in this shape before, nothing
    // more. The numeric confidence stays out of the prose — it orders
    // clusters, it does not measure how likely the pattern is.
    const top = clusters[0]!;
    parts.push(`Possible pattern match: ${top.rootCause}.`);
    parts.push(`Start by checking: ${top.investigationOrder.join(' → ')}.`);

    if (clusters.length > 1) {
      parts.push(`${clusters.length - 1} additional pattern match(es) detected.`);
    }
  }

  if (uncorrelated.length > 0) {
    parts.push(`No pattern matched for: ${uncorrelated.join(', ')}.`);
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
