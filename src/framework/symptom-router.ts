// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Symptom-based agent selection — routes observed symptoms to the most
 * likely recovery scenario and agent.
 *
 * Two modes:
 * - Rule-based: deterministic, fast, no external calls. Scores signals
 *   against known patterns and ranks scenarios by confidence.
 * - AI-assisted: uses natural language descriptions to pick agents.
 *   Falls back to rule-based on failure.
 *
 * Eliminates the "which agent do I use?" question by letting operators
 * describe what's wrong instead of knowing which system is at fault.
 */

import { sanitizeInput } from './ai-diagnosis.js';
import type { StackProfile } from '../cli/autodiscovery.js';
import { PKG_TO_SERVICE, pkgsForService } from '../config/service-registry.js';

// ── Types ──

export interface SymptomSignal {
  type:
    | 'error_rate'
    | 'latency'
    | 'connection'
    | 'timeout'
    | 'queue_depth'
    | 'config_mismatch'
    | 'deploy_change'
    | 'resource_exhaustion'
    | 'custom';
  source: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  data?: Record<string, unknown>;
}

export interface RoutingResult {
  /** Ranked list of likely scenarios with confidence */
  scenarios: ScoredScenario[];
  /** Recommended agent kind to use */
  recommendedAgent: string | null;
  /** Plain-English explanation of what's likely happening */
  explanation: string;
  /** What signals led to this conclusion */
  evidence: string[];
}

export interface ScoredScenario {
  scenario: string;
  agentKind: string;
  confidence: number;
  reasoning: string;
}

// ── Rule definitions ──

interface RoutingRule {
  scenario: string;
  agentKind: string;
  /** Signal types that contribute to this scenario */
  signalTypes: SymptomSignal['type'][];
  /** Keywords in signal detail/source that boost this rule */
  keywords: string[];
  /** Stack dependencies that boost this rule */
  stackDeps?: string[];
  /** Stack services (by kind) that boost this rule */
  stackServices?: string[];
  /** Base weight for matching signals */
  baseWeight: number;
  /** Human-readable reasoning template */
  reasoning: string;
}

const ROUTING_RULES: RoutingRule[] = [
  {
    scenario: 'replication-lag',
    agentKind: 'postgresql',
    signalTypes: ['latency', 'timeout'],
    keywords: ['replication', 'replica', 'lag', 'standby', 'wal', 'postgres', 'pg'],
    stackDeps: pkgsForService('postgresql'),
    stackServices: ['postgresql'],
    baseWeight: 0.6,
    reasoning: 'Replication lag or replica timeout signals with PostgreSQL in the stack',
  },
  {
    scenario: 'database-connection-exhaustion',
    agentKind: 'postgresql',
    signalTypes: ['connection', 'timeout', 'error_rate'],
    keywords: ['connection', 'pool', 'exhaust', 'max_connections', 'too many', 'database', 'postgres', 'pg'],
    stackDeps: pkgsForService('postgresql'),
    stackServices: ['postgresql'],
    baseWeight: 0.5,
    reasoning: 'Connection exhaustion signals with database dependencies detected',
  },
  {
    scenario: 'redis-memory-pressure',
    agentKind: 'redis',
    signalTypes: ['resource_exhaustion', 'error_rate', 'latency'],
    keywords: ['memory', 'redis', 'eviction', 'oom', 'maxmemory', 'cache'],
    stackDeps: pkgsForService('redis'),
    stackServices: ['redis'],
    baseWeight: 0.6,
    reasoning: 'Memory pressure or resource exhaustion signals with Redis in the stack',
  },
  {
    scenario: 'queue-backlog',
    agentKind: 'redis',
    signalTypes: ['queue_depth', 'latency', 'timeout'],
    keywords: ['queue', 'backlog', 'worker', 'stuck', 'bull', 'job', 'delayed'],
    stackDeps: pkgsForService('redis'),
    stackServices: ['redis'],
    baseWeight: 0.5,
    reasoning: 'Growing queue depth or stuck workers with queue dependencies in stack',
  },
  {
    scenario: 'kafka-consumer-lag',
    agentKind: 'kafka',
    signalTypes: ['queue_depth', 'latency', 'timeout'],
    keywords: ['kafka', 'consumer', 'lag', 'partition', 'offset', 'broker', 'topic'],
    stackDeps: pkgsForService('kafka'),
    stackServices: ['kafka'],
    baseWeight: 0.6,
    reasoning: 'Consumer lag or partition signals with Kafka in the stack',
  },
  {
    scenario: 'etcd-consensus-loss',
    agentKind: 'etcd',
    signalTypes: ['connection', 'timeout', 'error_rate'],
    keywords: ['etcd', 'consensus', 'leader', 'quorum', 'raft', 'election'],
    stackDeps: pkgsForService('etcd'),
    stackServices: ['etcd'],
    baseWeight: 0.6,
    reasoning: 'Consensus or leader election failures with etcd in the stack',
  },
  {
    scenario: 'kubernetes-pod-crash-loop',
    agentKind: 'kubernetes',
    signalTypes: ['error_rate', 'resource_exhaustion'],
    keywords: ['kubernetes', 'k8s', 'pod', 'crash', 'restart', 'oom', 'container', 'crashloopbackoff'],
    stackDeps: pkgsForService('kubernetes'),
    baseWeight: 0.5,
    reasoning: 'Pod crash or resource exhaustion signals in a Kubernetes environment',
  },
  {
    scenario: 'ceph-storage-degraded',
    agentKind: 'ceph',
    signalTypes: ['error_rate', 'resource_exhaustion', 'latency'],
    keywords: ['ceph', 'osd', 'storage', 'pg', 'placement', 'degraded', 'unfound'],
    baseWeight: 0.5,
    reasoning: 'Storage degradation signals consistent with Ceph cluster issues',
  },
  {
    scenario: 'flink-checkpoint-failure',
    agentKind: 'flink',
    signalTypes: ['error_rate', 'timeout', 'latency'],
    keywords: ['flink', 'checkpoint', 'backpressure', 'stream', 'pipeline', 'watermark'],
    baseWeight: 0.5,
    reasoning: 'Checkpoint failures or backpressure signals in a Flink streaming pipeline',
  },
  {
    scenario: 'deploy-rollback',
    agentKind: 'application',
    signalTypes: ['error_rate', 'deploy_change'],
    keywords: ['deploy', 'release', 'rollback', 'regression', 'version', 'new version'],
    baseWeight: 0.4,
    reasoning: 'High error rate correlated with a recent deployment change',
  },
  {
    scenario: 'config-drift',
    agentKind: 'application-config',
    signalTypes: ['config_mismatch', 'deploy_change', 'error_rate'],
    keywords: ['config', 'configuration', 'env', 'environment', 'mismatch', 'drift', 'secret'],
    baseWeight: 0.4,
    reasoning: 'Configuration mismatch signals, possibly after a deployment',
  },
  {
    scenario: 'ai-provider-failover',
    agentKind: 'ai-provider',
    signalTypes: ['timeout', 'error_rate', 'connection'],
    keywords: ['openai', 'anthropic', 'ai', 'llm', 'api', 'rate limit', '429', 'provider'],
    baseWeight: 0.4,
    reasoning: 'Timeout or error signals from AI provider endpoints',
  },
];

// ── Rule-based routing ──

/**
 * Route symptom signals to the most likely recovery scenario and agent.
 *
 * Uses a deterministic rule-based scoring system. Each rule is scored by:
 * 1. How many signal types match the rule
 * 2. How many keywords from signal details match
 * 3. Whether the stack profile confirms the relevant service/dependency
 * 4. Severity weighting (critical > warning > info)
 *
 * Results are ranked by confidence, highest first.
 */
export function routeBySymptoms(
  signals: SymptomSignal[],
  stackProfile?: StackProfile,
): RoutingResult {
  if (signals.length === 0) {
    return {
      scenarios: [],
      recommendedAgent: null,
      explanation: 'No symptom signals provided. Run autodiscovery or describe the problem.',
      evidence: [],
    };
  }

  const evidence: string[] = [];
  const scored: ScoredScenario[] = [];

  for (const rule of ROUTING_RULES) {
    let score = 0;
    const matchReasons: string[] = [];

    // Score by matching signal types
    for (const signal of signals) {
      if (rule.signalTypes.includes(signal.type)) {
        const severityWeight = signal.severity === 'critical' ? 1.0
          : signal.severity === 'warning' ? 0.6
          : 0.3;
        score += rule.baseWeight * severityWeight;
        matchReasons.push(`${signal.type}:${signal.severity} from ${signal.source}`);
      }

      // Score by keyword match in detail and source
      const text = `${signal.detail} ${signal.source}`.toLowerCase();
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          score += 0.15;
          if (!matchReasons.includes(`keyword:${keyword}`)) {
            matchReasons.push(`keyword:${keyword}`);
          }
        }
      }
    }

    // Boost from stack profile
    if (stackProfile) {
      // Matching detected services
      if (rule.stackServices) {
        const detectedKinds = stackProfile.services
          .filter((s) => s.detected)
          .map((s) => s.kind);
        for (const kind of rule.stackServices) {
          if (detectedKinds.includes(kind)) {
            score += 0.2;
            matchReasons.push(`service:${kind} detected`);
          }
        }
      }

      // Matching package dependencies
      if (rule.stackDeps) {
        for (const dep of rule.stackDeps) {
          if (stackProfile.appStack.dependencies.includes(dep)) {
            score += 0.1;
            matchReasons.push(`dep:${dep}`);
            break; // One dep match is enough
          }
        }
      }

      // Matching env hints
      const presentHints = stackProfile.envHints
        .filter((h) => h.present)
        .map((h) => h.inferredService);
      if (rule.stackServices) {
        for (const kind of rule.stackServices) {
          if (presentHints.includes(kind)) {
            score += 0.1;
            matchReasons.push(`env hint -> ${kind}`);
          }
        }
      }
    }

    if (score > 0) {
      // Normalize confidence to 0-1 range
      const confidence = Math.min(score, 1.0);
      scored.push({
        scenario: rule.scenario,
        agentKind: rule.agentKind,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: rule.reasoning,
      });
    }
  }

  // Sort by confidence descending
  scored.sort((a, b) => b.confidence - a.confidence);

  // Collect evidence
  for (const signal of signals) {
    evidence.push(`[${signal.severity.toUpperCase()}] ${signal.source}: ${signal.detail}`);
  }

  const top = scored[0];
  const explanation = top
    ? `Most likely scenario: ${top.scenario} (${(top.confidence * 100).toFixed(0)}% confidence). ${top.reasoning}.`
    : 'Could not match symptoms to a known scenario. Consider running full diagnostics.';

  return {
    scenarios: scored,
    recommendedAgent: top?.agentKind ?? null,
    explanation,
    evidence,
  };
}

// ── Signal collection from stack profile ──

/**
 * Generate basic symptom signals from autodiscovery results.
 *
 * For example, if DATABASE_URL is set but the database port is not
 * reachable, emit a connection signal. If an env hint is missing
 * for a detected dependency, emit a config_mismatch signal.
 */
export async function collectSignalsFromStack(
  profile: StackProfile,
): Promise<SymptomSignal[]> {
  const signals: SymptomSignal[] = [];

  // Check for services expected by env vars but not reachable
  for (const hint of profile.envHints) {
    if (!hint.present || !hint.inferredService) continue;

    const service = profile.services.find(
      (s) => s.kind === hint.inferredService,
    );
    if (service && !service.detected) {
      signals.push({
        type: 'connection',
        source: `autodiscovery:${hint.name}`,
        detail: `${hint.name} is set but ${hint.inferredService} is not reachable on ${service.host}:${service.port}`,
        severity: 'critical',
      });
    }
  }

  // Check for deps without matching env configuration
  for (const dep of profile.appStack.dependencies) {
    const expectedService = PKG_TO_SERVICE[dep];
    if (!expectedService) continue;

    const hasEnvHint = profile.envHints.some(
      (h) => h.present && h.inferredService === expectedService,
    );
    const serviceDetected = profile.services.some(
      (s) => s.kind === expectedService && s.detected,
    );

    if (!hasEnvHint && !serviceDetected) {
      signals.push({
        type: 'config_mismatch',
        source: `autodiscovery:${dep}`,
        detail: `Dependency "${dep}" found but no ${expectedService} connection URL or running service detected`,
        severity: 'warning',
      });
    }
  }

  // Check for AI providers with SDK but no API key
  for (const provider of profile.aiProviders) {
    if (!provider.configured) {
      signals.push({
        type: 'config_mismatch',
        source: `autodiscovery:${provider.provider}`,
        detail: `${provider.provider} SDK installed but ${provider.envVar} is not set`,
        severity: 'info',
      });
    }
  }

  return signals;
}

// ── AI-assisted routing ──

const ROUTING_SYSTEM_PROMPT = `You are a symptom router for CrisisMode, an infrastructure recovery framework. Given a natural language description of a problem, determine which recovery agent should handle it.

Available agent kinds and their scenarios:
- postgresql: replication lag, connection exhaustion, vacuum issues, WAL problems
- redis: memory pressure, cache eviction, queue backlogs (BullMQ/Bull)
- etcd: consensus loss, leader election, quorum problems
- kafka: consumer lag, partition issues, broker failures
- kubernetes: pod crashes, resource exhaustion, node problems
- ceph: OSD failures, storage degradation, placement group issues
- flink: checkpoint failures, backpressure, pipeline stalls
- application: deploy rollbacks, regression detection
- application-config: configuration drift, missing env vars
- ai-provider: API timeouts, rate limits, provider failovers

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "scenarios": [
    { "scenario": "scenario-name", "agentKind": "kind", "confidence": 0.0-1.0, "reasoning": "brief explanation" }
  ],
  "explanation": "one sentence summary"
}

Order scenarios by confidence (highest first). Include 1-3 scenarios max.`;

/**
 * Use AI to route a natural language problem description to the right agent.
 *
 * Falls back to rule-based routing if AI is unavailable or fails.
 */
export async function routeByAi(
  question: string,
  stackProfile?: StackProfile,
): Promise<RoutingResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return buildAiFallback(question, stackProfile);
  }

  try {
    return await callRoutingAi(question, stackProfile, apiKey);
  } catch (err) {
    console.error('AI routing failed:', err instanceof Error ? err.message : err);
    return buildAiFallback(question, stackProfile);
  }
}

async function callRoutingAi(
  question: string,
  stackProfile: StackProfile | undefined,
  apiKey: string,
): Promise<RoutingResult> {
  const parts: string[] = [`Problem description: ${question}`];

  if (stackProfile) {
    const detectedServices = stackProfile.services
      .filter((s) => s.detected)
      .map((s) => s.kind);
    if (detectedServices.length > 0) {
      parts.push(`Detected services: ${detectedServices.join(', ')}`);
    }
    if (stackProfile.appStack.dependencies.length > 0) {
      parts.push(`Dependencies: ${stackProfile.appStack.dependencies.join(', ')}`);
    }
    if (stackProfile.appStack.framework) {
      parts.push(`Framework: ${stackProfile.appStack.framework}`);
    }
  }

  const userMessage = sanitizeInput(parts.join('\n'));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        messages: [{ role: 'user', content: userMessage }],
        system: ROUTING_SYSTEM_PROMPT,
      },
      { signal: controller.signal },
    );

    clearTimeout(timeoutId);

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('');

    const parsed = JSON.parse(text.trim()) as {
      scenarios?: Array<{ scenario: string; agentKind: string; confidence: number; reasoning: string }>;
      explanation?: string;
    };

    const scenarios: ScoredScenario[] = (parsed.scenarios ?? []).map((s) => ({
      scenario: s.scenario,
      agentKind: s.agentKind,
      confidence: Math.round(Math.min(Math.max(s.confidence, 0), 1) * 100) / 100,
      reasoning: s.reasoning,
    }));

    return {
      scenarios,
      recommendedAgent: scenarios[0]?.agentKind ?? null,
      explanation: parsed.explanation ?? 'AI routing completed.',
      evidence: [`user question: "${question}"`],
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function buildAiFallback(
  question: string,
  stackProfile?: StackProfile,
): RoutingResult {
  // Convert the question into synthetic signals and use rule-based routing
  const signals = questionToSignals(question);

  if (signals.length > 0) {
    const result = routeBySymptoms(signals, stackProfile);
    result.evidence.unshift(`(rule-based fallback for: "${question}")`);
    return result;
  }

  return {
    scenarios: [],
    recommendedAgent: null,
    explanation: `Could not route "${question}" to an agent. Set ANTHROPIC_API_KEY for AI-powered routing, or run \`crisismode diagnose\`.`,
    evidence: [`user question: "${question}"`],
  };
}

/**
 * Convert a natural language question into synthetic signals
 * by scanning for known keywords.
 */
function questionToSignals(question: string): SymptomSignal[] {
  const text = question.toLowerCase();
  const signals: SymptomSignal[] = [];

  const keywordSignals: Array<{
    keywords: string[];
    type: SymptomSignal['type'];
    source: string;
  }> = [
    { keywords: ['error', 'errors', '500', '503', 'failing', 'crash'], type: 'error_rate', source: 'question' },
    { keywords: ['slow', 'latency', 'lag', 'delay', 'high response'], type: 'latency', source: 'question' },
    { keywords: ['connection', 'refused', 'unreachable', 'cannot connect'], type: 'connection', source: 'question' },
    { keywords: ['timeout', 'timed out', 'hanging'], type: 'timeout', source: 'question' },
    { keywords: ['queue', 'backlog', 'jobs stuck', 'workers'], type: 'queue_depth', source: 'question' },
    { keywords: ['config', 'configuration', 'env var', 'mismatch'], type: 'config_mismatch', source: 'question' },
    { keywords: ['deploy', 'deployed', 'release', 'rollback', 'new version'], type: 'deploy_change', source: 'question' },
    { keywords: ['memory', 'oom', 'disk', 'cpu', 'resource', 'exhausted'], type: 'resource_exhaustion', source: 'question' },
  ];

  for (const mapping of keywordSignals) {
    for (const keyword of mapping.keywords) {
      if (text.includes(keyword)) {
        signals.push({
          type: mapping.type,
          source: mapping.source,
          detail: question,
          severity: 'warning',
        });
        break; // One match per signal type is enough
      }
    }
  }

  return signals;
}
