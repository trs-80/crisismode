// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode scan` — zero-config health scan.
 *
 * Runs autodiscovery → parallel health checks → scored summary.
 * Produces a system health score (0-100) with per-service status.
 * Each finding gets a unique ID and copy-pasteable next command.
 *
 * This is the default command when `crisismode` is run with no arguments.
 */

import { assembleContext } from '../../framework/context.js';
import { AgentRegistry } from '../../config/agent-registry.js';
import { loadConfigWithDetection } from '../../config/loader.js';
import { detectServices } from '../detect.js';
import { discoverStack, printOnboardingMessage } from '../autodiscovery.js';
import { discoverCheckPlugins } from '../../framework/check-discovery.js';
import { dispatchPluginExecution, exitStatusToHealth } from '../../framework/check-plugin.js';
import {
  printBanner, printScanSummary, printNextAction,
  printInfo, printDetection, printError, getOutputMode,
  printPlainEnglishSummary, printSynthesis,
} from '../output.js';
import {
  buildIncidentSummary, formatIncidentSummaryText,
} from '../incident-summary.js';
import { generatePlainEnglishSummary } from '../ai-summary.js';
import { mergeLocalTargets, unconfiguredAgentHints } from '../local-agents.js';
import { synthesizeByRules } from '../../framework/root-cause-synthesis.js';
import type { AgentEvidence } from '../../framework/root-cause-synthesis.js';
import { healthToSignals } from '../../framework/health-to-signals.js';
import type { ScanFinding, ScanResult, RecentChange } from '../output.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { HealthAssessment } from '../../types/health.js';
import type { AgentInstance } from '../../config/agent-registration.js';
import type { CheckRequest, CheckHealthResult } from '../../framework/check-plugin.js';
import type { DiscoveredPlugin } from '../../framework/check-discovery.js';

export interface ScanOptions {
  configPath?: string;
  category?: string[];
  verbose?: boolean;
}

/** Per-agent timeout for health checks during scan (ms). */
const AGENT_TIMEOUT_MS = 2000;

/** Prefix map: agent kind → finding ID prefix. */
const KIND_PREFIX: Record<string, string> = {
  postgresql: 'PG',
  redis: 'REDIS',
  etcd: 'ETCD',
  kafka: 'KAFKA',
  kubernetes: 'K8S',
  ceph: 'CEPH',
  flink: 'FLINK',
  application: 'DEPLOY',
  'ai-provider': 'AI',
  'managed-database': 'DBMIG',
  'message-queue': 'QUEUE',
  'application-config': 'CFG',
  dns: 'DNS',
  tls: 'TLS',
  disk: 'DISK',
  backup: 'BKUP',
  'aws-s3': 'S3',
  'aws-dynamodb': 'DYNAMO',
  'aws-rds': 'RDS',
  plugin: 'PLUG',
};

function findingId(kind: string, index: number): string {
  const prefix = KIND_PREFIX[kind] ?? kind.toUpperCase().slice(0, 5);
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

export async function runScan(opts: ScanOptions): Promise<ScanResult> {
  const startTime = Date.now();
  printBanner();

  // Phase 1: Discovery
  printInfo('Scanning for services...');
  const [stackProfile, configDetection] = await Promise.all([
    discoverStack(),
    loadConfigWithDetectionSafe(opts.configPath),
  ]);

  const configResult = configDetection.config;
  const configSource = configDetection.source;

  // Merge detected services with config targets
  const detectedServices = stackProfile.services.filter((s) => s.detected);
  printDetection(stackProfile.services);

  // Build a config — either from file or from detected services
  let config = configResult;
  if (!config && detectedServices.length > 0) {
    config = buildConfigFromDetection(detectedServices);
  }

  // Always inject local health agents (DNS, disk) — they work without config
  if (config) {
    config = { ...config, targets: mergeLocalTargets(config.targets) };
  } else {
    config = buildConfigFromDetection([]);
    config = { ...config, targets: mergeLocalTargets(config.targets) };
  }

  // Merge derived targets from connection string env vars
  if (stackProfile.derivedTargets.length > 0) {
    const existingKinds = new Set(config.targets.map((t) => t.kind));
    const newTargets = stackProfile.derivedTargets.filter((t) => !existingKinds.has(t.kind));
    if (newTargets.length > 0) {
      config = { ...config, targets: [...config.targets, ...newTargets] };
    }
  }

  // Auto-configure Vercel when platform detected and project.json + token available
  if (
    stackProfile.platform.platform === 'vercel' &&
    stackProfile.vercelProject &&
    process.env['VERCEL_TOKEN']
  ) {
    process.env['VERCEL_PROJECT_ID'] = stackProfile.vercelProject.projectId;
    const hasAppTarget = config.targets.some((t) => t.kind === 'application');
    if (!hasAppTarget) {
      config = {
        ...config,
        targets: [
          ...config.targets,
          {
            name: `vercel-${stackProfile.vercelProject.projectId}`,
            kind: 'application',
            primary: { host: 'api.vercel.com', port: 443 },
          },
        ],
      };
    }
  }

  // First-run onboarding message
  if (configSource !== 'file') {
    printOnboardingMessage(stackProfile, configSource);
  }

  // Apply category filter if provided
  let targets = config.targets;
  if (opts.category && opts.category.length > 0) {
    const categories = new Set(opts.category);
    targets = targets.filter((t) => categories.has(t.kind));
    if (targets.length === 0) {
      printInfo(`No targets match categories: ${opts.category.join(', ')}`);
    }
  }

  // Plugin discovery (parallel with phase 2 setup)
  const pluginDiscovery = discoverCheckPlugins();

  // Phase 2: Parallel health checks
  printInfo(`Running health checks on ${targets.length} target(s)...`);
  console.log('');

  const registry = new AgentRegistry({ ...config, targets });
  const findings: ScanFinding[] = [];
  let findingCounter = 0;
  let pluginFindingCounter = 0;

  // Run health checks in parallel with per-agent timeout
  const healthPromises = targets.map(async (target): Promise<{ finding: Omit<ScanFinding, 'id'>; kind: string; health: HealthAssessment | null }> => {
    let instance: AgentInstance | undefined;
    try {
      instance = await registry.createForTarget(target.name);
      const { agent, backend } = instance;

      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'cli-scan',
        payload: {
          alertname: `${target.kind}ScanCheck`,
          instance: `${target.name}`,
          severity: 'info',
        },
        receivedAt: new Date().toISOString(),
      };

      const context = assembleContext(trigger, agent.manifest);

      // Race health check against timeout
      const health = await Promise.race([
        agent.assessHealth(context),
        timeoutPromise<HealthAssessment>(AGENT_TIMEOUT_MS, {
          status: 'unknown',
          confidence: 0,
          summary: 'Health check timed out',
          observedAt: new Date().toISOString(),
          signals: [],
          recommendedActions: ['Check connectivity to the service'],
        }),
      ]);

      await backend.close();

      return {
        kind: target.kind,
        health,
        finding: {
          service: `${target.kind} (${target.name})`,
          status: health.status,
          summary: health.summary,
          confidence: health.confidence,
          escalationLevel: health.status === 'healthy' ? 1 : 2,
          signals: health.signals.map((s) => ({ status: s.status, detail: s.detail })),
        },
      };
    } catch (err) {
      if (instance) {
        await instance.backend.close().catch(() => {});
      }
      return {
        kind: target.kind,
        health: null,
        finding: {
          service: `${target.kind} (${target.name})`,
          status: 'unknown',
          summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0,
          escalationLevel: 2,
          signals: [],
        },
      };
    }
  });

  // Await plugin discovery alongside built-in health checks
  const [agentResults, discoveryResult] = await Promise.all([
    Promise.all(healthPromises),
    pluginDiscovery,
  ]);

  // Push agent findings in target order (not completion order)
  for (const { finding, kind } of agentResults) {
    findings.push({ id: findingId(kind, findingCounter++), ...finding });
  }

  // Cross-system root-cause correlation — only meaningful with 2+ degraded targets
  const evidence: AgentEvidence[] = agentResults
    .filter((r) => r.health && r.health.status !== 'healthy' && r.health.status !== 'unknown')
    .map((r) => ({
      agentKind: r.kind,
      targetName: r.finding.service,
      health: r.health!,
      signals: healthToSignals(r.health!),
    }));
  if (evidence.length >= 2) {
    printSynthesis(synthesizeByRules(evidence));
  }

  // Phase 2b: External check plugin health checks
  const healthPlugins = discoveryResult.plugins.filter(
    (p) => p.manifest.verbs.includes('health'),
  );

  if (healthPlugins.length > 0) {
    printInfo(`Found ${healthPlugins.length} external check plugin(s)`);

    const pluginPromises = healthPlugins.map(async (plugin: DiscoveredPlugin): Promise<Omit<ScanFinding, 'id'>> => {
      try {
        const request: CheckRequest = {
          verb: 'health',
          target: {
            name: 'plugin-check',
            kind: plugin.manifest.targetKinds[0] ?? 'generic',
          },
        };

        const execOpts = { timeoutMs: plugin.manifest.timeoutMs ?? 10_000, cwd: plugin.pluginDir };
        const execResult = await dispatchPluginExecution(plugin, 'health', execOpts, request);

        const healthResult = execResult.result as CheckHealthResult | null;
        const rawStatus = healthResult?.status ?? exitStatusToHealth(execResult.exitStatus);
        const status = normalizePluginStatus(rawStatus);
        const summary = healthResult?.summary ?? `Plugin exited with status: ${execResult.exitStatus}`;
        const confidence = healthResult?.confidence ?? (status === 'unknown' ? 0 : 0.5);
        const signals = (healthResult?.signals ?? []).map((s) => ({
          status: s.status,
          detail: s.detail,
        }));

        return {
          service: `plugin (${plugin.manifest.name})`,
          status,
          summary,
          confidence,
          escalationLevel: status === 'healthy' ? 1 : 2,
          signals,
        };
      } catch (err) {
        return {
          service: `plugin (${plugin.manifest.name})`,
          status: 'unknown',
          summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0,
          escalationLevel: 2,
          signals: [],
        };
      }
    });

    // Await all in parallel, then push in discovery order so IDs are deterministic
    const pluginResults = await Promise.all(pluginPromises);
    for (const result of pluginResults) {
      findings.push({ id: findingId('plugin', pluginFindingCounter++), ...result });
    }
  }

  // Phase 3: Detect recent changes
  const recentChanges = await detectRecentChanges(findings);

  // Phase 4: Compute score
  const score = computeHealthScore(findings);

  const result: ScanResult = {
    score,
    findings,
    recentChanges,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  };

  // Build incident summary and attach as text for JSON consumers
  const incidentSummary = buildIncidentSummary(result);
  result.summary = formatIncidentSummaryText(incidentSummary);

  // Generate plain-English AI summary (non-blocking — falls back gracefully)
  const plainEnglish = await generatePlainEnglishSummary(incidentSummary, result.recentChanges);
  result.aiSummary = plainEnglish.text;

  printScanSummary(result);

  // Print next steps from the incident summary (single source of truth)
  for (const step of incidentSummary.nextSteps) {
    printNextAction(step);
  }

  // Print plain-English summary in human mode (replaces structured incident summary)
  if (getOutputMode() === 'human') {
    printPlainEnglishSummary(plainEnglish);
  }

  // Hint about agents that require explicit configuration
  const configuredKinds = new Set(config.targets.map((t) => t.kind));
  const newAgentHints = unconfiguredAgentHints(configuredKinds);
  if (newAgentHints.length > 0) {
    printInfo(`Additional checks available: ${newAgentHints.join(', ')}. Add targets to crisismode.yaml to enable.`);
  }

  // Hint about check plugins when none are discovered
  if (healthPlugins.length === 0) {
    printInfo('No check plugins found. Add custom checks in ./checks/ or scaffold one with: crisismode init --plugin my-check');
  }

  return result;
}

/**
 * Compute a health score (0-100) from scan findings.
 *
 * Scoring: each finding contributes equally.
 *   healthy = 100%, recovering = 60%, unknown = 30%, unhealthy = 0%
 */
function computeHealthScore(findings: ScanFinding[]): number {
  if (findings.length === 0) return 100;

  const weights: Record<string, number> = {
    healthy: 1.0,
    recovering: 0.6,
    unknown: 0.3,
    unhealthy: 0.0,
  };

  let total = 0;
  for (const f of findings) {
    total += weights[f.status] ?? 0;
  }

  return Math.round((total / findings.length) * 100);
}

/**
 * Load config with detection info, without throwing.
 */
function loadConfigWithDetectionSafe(configPath?: string) {
  try {
    return loadConfigWithDetection({ configPath });
  } catch {
    return { config: null, source: 'none' as const };
  }
}

function buildConfigFromDetection(detected: Array<{ kind: string; host: string; port: number }>) {
  return {
    apiVersion: 'crisismode/v1' as const,
    kind: 'SiteConfig' as const,
    metadata: { name: 'auto-detected', environment: 'development' as const },
    targets: detected.map((s) => ({
      name: `detected-${s.kind}`,
      kind: s.kind,
      primary: { host: s.host, port: s.port },
      replicas: [] as Array<{ host: string; port: number }>,
      credentials: { type: 'value' as const, username: '', password: '' },
    })),
  };
}

function timeoutPromise<T>(ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(fallback), ms));
}

/**
 * Normalize plugin-reported status values to the HealthStatus union.
 * Plugins may return 'critical' or 'warning' which are not HealthStatus values.
 */
function normalizePluginStatus(status: string): import('../../types/health.js').HealthStatus {
  switch (status) {
    case 'healthy': return 'healthy';
    case 'recovering': return 'recovering';
    case 'unhealthy': return 'unhealthy';
    case 'critical': return 'unhealthy';
    case 'warning': return 'recovering';
    default: return 'unknown';
  }
}

/**
 * Detect recent changes that might be relevant to an incident.
 * Checks for: container restarts (via signals), recent git deploys,
 * and environment variable indicators.
 */
async function detectRecentChanges(findings: ScanFinding[]): Promise<RecentChange[]> {
  const changes: RecentChange[] = [];
  const now = new Date().toISOString();

  // Check findings signals for restart indicators
  for (const f of findings) {
    for (const signal of f.signals) {
      const detail = signal.detail.toLowerCase();
      if (detail.includes('restart') || detail.includes('restarted')) {
        changes.push({
          type: 'container_restart',
          description: `${f.service}: ${signal.detail}`,
          detectedAt: now,
        });
      }
      if (detail.includes('deploy') || detail.includes('deployed') || detail.includes('rollout')) {
        changes.push({
          type: 'deploy',
          description: `${f.service}: ${signal.detail}`,
          detectedAt: now,
        });
      }
      if (detail.includes('config') && (detail.includes('change') || detail.includes('drift') || detail.includes('mismatch'))) {
        changes.push({
          type: 'config_change',
          description: `${f.service}: ${signal.detail}`,
          detectedAt: now,
        });
      }
    }
  }

  // Note: git log detection removed — crisismode typically runs outside the
  // application repo, so checking the tool's own git history is misleading.
  // Deploy detection is handled via signals from agents (e.g., container image
  // changes, rollout events) which are already captured above.

  return changes;
}
