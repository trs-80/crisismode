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
import { loadConfig } from '../../config/loader.js';
import { detectServices } from '../detect.js';
import { discoverStack } from '../autodiscovery.js';
import { discoverCheckPlugins } from '../../framework/check-discovery.js';
import { executeCheckPlugin, exitStatusToHealth } from '../../framework/check-plugin.js';
import {
  printBanner, printScanSummary, printNextAction,
  printInfo, printDetection, printError,
} from '../output.js';
import type { ScanFinding, ScanResult } from '../output.js';
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
  const [stackProfile, configResult] = await Promise.all([
    discoverStack(),
    loadConfigSafe(opts.configPath),
  ]);

  // Merge detected services with config targets
  const detectedServices = stackProfile.services.filter((s) => s.detected);
  printDetection(stackProfile.services);

  // Build a config — either from file or from detected services
  let config = configResult;
  if (!config && detectedServices.length > 0) {
    config = buildConfigFromDetection(detectedServices);
  }

  if (!config) {
    // Nothing detected, nothing configured — still produce a scan result
    const result: ScanResult = {
      score: 100,
      findings: [],
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
    printScanSummary(result);
    printNextAction('No services detected. Run `crisismode init` to configure manually.');
    return result;
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
  const healthPromises = targets.map(async (target) => {
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

      const id = findingId(target.kind, findingCounter++);
      findings.push({
        id,
        service: `${target.kind} (${target.name})`,
        status: health.status,
        summary: health.summary,
        confidence: health.confidence,
        escalationLevel: health.status === 'healthy' ? 1 : 2,
        signals: health.signals.map((s) => ({ status: s.status, detail: s.detail })),
      });

      return health;
    } catch (err) {
      if (instance) {
        await instance.backend.close().catch(() => {});
      }
      const id = findingId(target.kind, findingCounter++);
      findings.push({
        id,
        service: `${target.kind} (${target.name})`,
        status: 'unknown',
        summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
        confidence: 0,
        escalationLevel: 2,
        signals: [],
      });
      return null;
    }
  });

  // Await plugin discovery alongside built-in health checks
  const [, discoveryResult] = await Promise.all([
    Promise.all(healthPromises),
    pluginDiscovery,
  ]);

  // Phase 2b: External check plugin health checks
  const healthPlugins = discoveryResult.plugins.filter(
    (p) => p.manifest.verbs.includes('health'),
  );

  if (healthPlugins.length > 0) {
    printInfo(`Found ${healthPlugins.length} external check plugin(s)`);

    const pluginPromises = healthPlugins.map(async (plugin: DiscoveredPlugin) => {
      try {
        const request: CheckRequest = {
          verb: 'health',
          target: {
            name: 'plugin-check',
            kind: plugin.manifest.targetKinds[0] ?? 'generic',
          },
        };

        const execResult = await executeCheckPlugin(
          plugin.executablePath,
          request,
          { timeoutMs: plugin.manifest.timeoutMs ?? 10_000, cwd: plugin.pluginDir },
        );

        const healthResult = execResult.result as CheckHealthResult | null;
        const rawStatus = healthResult?.status ?? exitStatusToHealth(execResult.exitStatus);
        const status = normalizePluginStatus(rawStatus);
        const summary = healthResult?.summary ?? `Plugin exited with status: ${execResult.exitStatus}`;
        const confidence = healthResult?.confidence ?? (status === 'unknown' ? 0 : 0.5);
        const signals = (healthResult?.signals ?? []).map((s) => ({
          status: s.status,
          detail: s.detail,
        }));

        const id = findingId('plugin', pluginFindingCounter++);
        findings.push({
          id,
          service: `plugin (${plugin.manifest.name})`,
          status,
          summary,
          confidence,
          escalationLevel: status === 'healthy' ? 1 : 2,
          signals,
        });
      } catch (err) {
        const id = findingId('plugin', pluginFindingCounter++);
        findings.push({
          id,
          service: `plugin (${plugin.manifest.name})`,
          status: 'unknown',
          summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0,
          escalationLevel: 2,
          signals: [],
        });
      }
    });

    await Promise.all(pluginPromises);
  }

  // Phase 3: Compute score
  const score = computeHealthScore(findings);

  const result: ScanResult = {
    score,
    findings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  };

  printScanSummary(result);

  // Progressive disclosure: suggest next action based on findings
  const unhealthy = findings.filter((f) => f.status === 'unhealthy');
  const recovering = findings.filter((f) => f.status === 'recovering');
  const unknown = findings.filter((f) => f.status === 'unknown');

  if (unhealthy.length > 0) {
    const first = unhealthy[0];
    printNextAction(`Run \`crisismode diagnose ${first.id}\` to investigate ${first.service}`);
  } else if (recovering.length > 0) {
    printNextAction(`Run \`crisismode watch\` to monitor recovery progress`);
  } else if (unknown.length > 0) {
    printNextAction(`Run \`crisismode scan --verbose\` for more details on unknown services`);
  } else if (findings.length > 0) {
    printNextAction('All systems healthy. Run `crisismode watch` to monitor continuously.');
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
 * Load config without throwing — returns null if no config found.
 */
function loadConfigSafe(configPath?: string) {
  try {
    const result = loadConfig({ configPath });
    return result.config;
  } catch {
    return null;
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
