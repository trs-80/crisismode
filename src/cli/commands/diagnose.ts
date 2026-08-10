// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode diagnose` — read-only health check and diagnosis.
 * Safe to run at any time — never mutates infrastructure.
 */

import { assembleContext } from '../../framework/context.js';
import { applyEnvironmentGuard } from '../../framework/environment-guard.js';
import { buildOperatorSummary } from '../../framework/operator-summary.js';
import { AgentRegistry } from '../../config/agent-registry.js';
import { loadConfigWithLocalTargets } from '../runtime.js';
import { probeNetwork } from '../../framework/network-profile.js';
import { discoverCheckPlugins } from '../../framework/check-discovery.js';
import { dispatchPluginExecution } from '../../framework/check-plugin.js';
import { readVercelProjectConfig } from '../autodiscovery.js';
import { platformsForTarget } from '../../framework/guidance/platforms.js';
import type { DiscoveredPlugin } from '../../framework/check-discovery.js';
import {
  printBanner, printHealthStatus, printDiagnosis, printOperatorSummary,
  printInfo, printSuccess, printWarning, printError, printNetworkProfile, printSpacer,
} from '../output.js';
import { severityExitCode } from '../status-presentation.js';
import { ExitCode } from '../exit-codes.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { CheckDiagnoseResult } from '../../framework/check-plugin.js';
import type { ExplanationContext } from '../../framework/signal-explanations.js';

export interface DiagnoseOptions {
  configPath?: string | undefined;
  targetName?: string | undefined;
}

export async function runDiagnose(opts: DiagnoseOptions): Promise<ExitCode> {
  printBanner();

  const explanationCtx: ExplanationContext = {
    serverless: readVercelProjectConfig(process.cwd()) !== null || process.env['VERCEL_TOKEN'] !== undefined,
  };

  // Route PLUG-* IDs to check plugin diagnose verb
  if (opts.targetName) {
    const plugMatch = opts.targetName.match(/^PLUG-(\d+)$/i);
    if (plugMatch) {
      return runPluginDiagnose(parseInt(plugMatch[1]!, 10) - 1);
    }
  }

  // Load config or detect (injects local health agents, prints Config: line)
  const { config } = await loadConfigWithLocalTargets(opts);

  // A target name that matches nothing is the user naming something that
  // does not exist — a usage error (2), the same class as an unknown flag.
  //
  // Checked here rather than letting AgentRegistry.createForTarget throw,
  // because a throw is indistinguishable from a real connection failure and
  // would surface as an internal error (70). And checked *immediately after
  // the config load*, before probeNetwork is kicked off: this used to sit
  // below the probe, so a typo'd target name fired real network probes
  // against every configured target before erroring. Under pressure a typo
  // must fail in milliseconds, not after a network round-trip.
  if (opts.targetName !== undefined && !config.targets.some((t) => t.name === opts.targetName)) {
    printError(
      `Target "${opts.targetName}" not found in config. Available: ${config.targets.map((t) => t.name).join(', ')}`,
    );
    return ExitCode.USAGE;
  }

  // Probe network connectivity (runs in parallel with agent setup)
  const targetProbes = config.targets
    .filter((t) => t.primary)
    .map((t) => ({
      host: t.primary!.host,
      port: t.primary!.port,
      label: t.name,
    }));
  const hubEndpoint = 'hub' in config ? config.hub?.endpoint : undefined;
  const networkPromise = probeNetwork({
    ...(hubEndpoint !== undefined ? { hubEndpoint } : {}),
    targets: targetProbes,
  });

  const registry = new AgentRegistry(config);
  const { agent, backend, target } = opts.targetName
    ? await registry.createForTarget(opts.targetName)
    : await registry.createFirst();

  // Wait for network probe (ran in parallel with agent creation)
  const networkProfile = await networkPromise;
  printNetworkProfile(networkProfile);

  await AgentRegistry.discoverVersion({ agent, backend, target });

  printInfo(`Target: ${target.name} (${target.kind})`);
  printSpacer();

  try {
    // Build a trigger context for diagnosis
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'cli-diagnose',
      payload: {
        alertname: `${target.kind}HealthCheck`,
        instance: `${target.primary.host}:${target.primary.port}`,
        severity: 'info',
      },
      receivedAt: new Date().toISOString(),
    };

    const context = assembleContext(trigger, agent.manifest);
    context.network = networkProfile;

    // Health assessment
    printInfo('Assessing health...');
    const health = await agent.assessHealth(context);
    printHealthStatus(health, explanationCtx);

    if (health.status === 'healthy') {
      printSuccess('System is healthy. No issues detected.');
      printOperatorSummary(buildOperatorSummary({
        health,
        mode: 'dry-run',
        healthCheckOnly: true,
      }));
      return ExitCode.OK;
    }

    // Diagnosis (read-only)
    const hasAiKey = !!process.env.ANTHROPIC_API_KEY;
    const aiAvailable = hasAiKey && networkProfile.internet.status !== 'unavailable';
    const aiCapable = agent.supportsAiDiagnosis === true;
    printInfo(aiAvailable && aiCapable
      ? 'Running AI-powered diagnosis...'
      : 'Running rule-based diagnosis...');

    const diagnosis = applyEnvironmentGuard(
      await agent.diagnose(context),
      networkProfile,
      target.name,
    );
    printDiagnosis(diagnosis, explanationCtx, { platforms: platformsForTarget(target.kind, target.name) });

    printOperatorSummary(buildOperatorSummary({
      health,
      mode: 'dry-run',
      healthCheckOnly: true,
    }));

    if (health.status === 'unhealthy') {
      printWarning('To fix: `crisismode recover`');
    } else if (health.status === 'recovering') {
      printInfo('Monitor progress: `crisismode watch`');
    }

    // C8a: diagnose reported `unhealthy` and exited 0.
    return severityExitCode([health.status]);
  } finally {
    await backend.close();
  }
}

async function runPluginDiagnose(pluginIndex: number): Promise<ExitCode> {
  const { plugins } = await discoverCheckPlugins();
  const diagPlugins = plugins.filter((p: DiscoveredPlugin) => p.manifest.verbs.includes('diagnose'));

  const plugin = diagPlugins[pluginIndex];
  if (!plugin) {
    printWarning(`No plugin found at index ${pluginIndex + 1}. Run \`crisismode scan\` to see available plugins.`);
    // Nothing was checked, so nothing is known to be broken — the ID the
    // user passed does not resolve, which is a usage problem, not a
    // health verdict.
    return ExitCode.USAGE;
  }

  printInfo(`Plugin: ${plugin.manifest.name}`);
  printSpacer();

  const execOpts = { timeoutMs: plugin.manifest.timeoutMs ?? 10_000, cwd: plugin.pluginDir };
  const request = { verb: 'diagnose' as const, target: { name: 'plugin-diagnose', kind: plugin.manifest.targetKinds[0] ?? 'generic' } };
  const execResult = await dispatchPluginExecution(plugin, 'diagnose', execOpts, request);

  const result = execResult.result as CheckDiagnoseResult | null;
  if (!result) {
    printWarning(`Plugin exited with status: ${execResult.exitStatus}. No diagnosis output.`);
    return ExitCode.OK;
  }

  let code: ExitCode;
  if (result.healthy) {
    printSuccess(`Healthy: ${result.summary}`);
    code = ExitCode.OK;
  } else if (execResult.exitStatus === 'warning') {
    printWarning(`Recovering: ${result.summary}`);
    code = severityExitCode(['recovering']);
  } else {
    printWarning(`Unhealthy: ${result.summary}`);
    code = severityExitCode(['unhealthy']);
  }

  if ((result.findings ?? []).length > 0) {
    printSpacer();
    printInfo('Findings:');
    for (const f of result.findings ?? []) {
      const icon = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️ ';
      console.log(`  ${icon}  [${f.severity}] ${f.title}`);
      console.log(`       ${f.detail}`);
    }
  }

  const docs = plugin.manifest.docs;
  if (docs?.explanation || docs?.learnMoreUrl) {
    printSpacer();
    if (docs.explanation) printInfo(`About this check: ${docs.explanation}`);
    if (docs.learnMoreUrl) printInfo(`Learn more: ${docs.learnMoreUrl}`);
  }
  printSpacer();
  return code;
}
