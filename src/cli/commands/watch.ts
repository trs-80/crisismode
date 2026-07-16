// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode watch` — shadow/continuous observation mode.
 * Runs periodic health checks and produces recovery proposals proactively.
 * Safe to run indefinitely — never mutates infrastructure.
 *
 * Uses WatchState to accumulate health history, detect patterns, and
 * build health cards across observation cycles.
 */

import { assembleContext } from '../../framework/context.js';
import { diagnoseWithEnvironmentGuard } from '../../framework/environment-guard.js';
import { buildOperatorSummary } from '../../framework/operator-summary.js';
import { AgentRegistry } from '../../config/agent-registry.js';
import { createAgentForTarget, loadConfigWithLocalTargets } from '../runtime.js';
import { generateDiagnosisReport } from '../../framework/incident-report.js';
import { WatchState } from '../../framework/watch-state.js';
import {
  printBanner, printInfo,
  printWarning, printError,
} from '../output.js';
import type { AgentContext } from '../../types/agent-context.js';

export interface WatchOptions {
  configPath?: string | undefined;
  targetName?: string | undefined;
  intervalMs?: number | undefined;
  maxCycles?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;

export async function runWatch(opts: WatchOptions): Promise<void> {
  printBanner();

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Load config or detect
  const { config } = await loadConfigWithLocalTargets(opts);

  const registry = new AgentRegistry(config);
  const { agent, backend, target } = await createAgentForTarget(registry, opts.targetName);

  const intervalSec = (intervalMs / 1000).toFixed(0);
  printInfo(`Shadow mode active — observing ${target.name} every ${intervalSec}s`);
  console.log('');

  const watchState = new WatchState(target.name);
  let running = true;
  let cycleCount = 0;

  const handleShutdown = (): void => {
    running = false;
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    while (running) {
      if (opts.maxCycles !== undefined && cycleCount >= opts.maxCycles) {
        break;
      }

      cycleCount++;

      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'cli-watch',
        payload: {
          alertname: `${target.kind}WatchCheck`,
          instance: `${target.primary.host}:${target.primary.port}`,
          severity: 'info',
          cycle: cycleCount,
        },
        receivedAt: new Date().toISOString(),
      };

      const context = assembleContext(trigger, agent.manifest);

      try {
        const health = await agent.assessHealth(context);
        const confidencePct = (health.confidence * 100).toFixed(0);

        // Record in watch state
        const transition = watchState.recordHealth(health, cycleCount);

        // Compact status line — incident-native: what's the state right now?
        const statusLabel = health.status === 'healthy' ? 'OK'
          : health.status === 'unhealthy' ? 'PROBLEM'
          : health.status === 'recovering' ? 'RECOVERING'
          : 'CHECKING';

        // Show delta from previous cycle
        if (transition) {
          printWarning(`[cycle ${cycleCount}] ${statusLabel} — changed from ${transition.from} to ${transition.to} (${confidencePct}% confidence)`);
        } else {
          printInfo(`[cycle ${cycleCount}] ${statusLabel} — ${health.summary} (${confidencePct}% confidence)`);
        }

        // If transitioned from healthy to unhealthy, generate a recovery proposal
        if (transition && transition.from === 'healthy' && transition.to === 'unhealthy') {
          printWarning('Health transitioned from healthy to unhealthy — generating recovery proposal...');
          console.log('');

          const diagnosis = await diagnoseWithEnvironmentGuard(agent, context, target, config.targets);
          const plan = await agent.plan(context, diagnosis);

          watchState.recordProposal(diagnosis, plan, cycleCount);

          const operatorSummary = buildOperatorSummary({
            health,
            mode: 'dry-run',
            healthCheckOnly: false,
          });

          const report = generateDiagnosisReport(diagnosis, health, operatorSummary);
          console.log(report.markdown);
          console.log('');

          printWarning('Recovery proposal ready. To fix: `crisismode recover`');
          console.log('');
        }

        // Print pattern and forecast alerts
        if (cycleCount > 0 && cycleCount % 10 === 0) {
          const patterns = watchState.detectPatterns();
          for (const pattern of patterns) {
            printWarning(`Pattern: ${pattern.description}`);
          }
          const forecasts = watchState.forecastDegradation();
          for (const forecast of forecasts) {
            printWarning(`Forecast: ${forecast.explanation}`);
            printInfo(`  -> ${forecast.recommendation}`);
          }
        }
      } catch (err) {
        printError(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Sleep for the interval, but check running flag periodically
      if (running && (opts.maxCycles === undefined || cycleCount < opts.maxCycles)) {
        await sleep(intervalMs);
      }
    }
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
    await backend.close();
  }

  printWatchSummary(watchState);
}

/** Get a health card for the current watch state — used by integrations. */
export { WatchState };

function printWatchSummary(state: WatchState): void {
  const summary = state.getSummary();
  const card = state.getHealthCard();

  console.log('');
  printInfo('--- Watch Summary ---');
  printInfo(`Target:               ${card.target}`);
  printInfo(`Total cycles:         ${summary.totalCycles}`);
  printInfo(`Health transitions:   ${summary.transitions.length}`);
  printInfo(`Proposals generated:  ${summary.proposals.length}`);
  printInfo(`Uptime:               ${card.uptimePercent}%`);
  printInfo(`Avg confidence:       ${(card.avgConfidence * 100).toFixed(1)}%`);
  printInfo(`Started:              ${summary.startedAt}`);
  printInfo(`Ended:                ${summary.lastUpdated}`);

  if (summary.transitions.length > 0) {
    console.log('');
    printInfo('What changed:');
    for (const t of summary.transitions) {
      printInfo(`  ${t.timestamp}: ${t.from} -> ${t.to}`);
    }
  }

  if (summary.patterns.length > 0) {
    console.log('');
    printInfo('Patterns noticed:');
    for (const p of summary.patterns) {
      printWarning(`  [${p.pattern}] ${p.description}`);
    }
  }

  if (card.forecasts.length > 0) {
    console.log('');
    printInfo('Risk forecast:');
    for (const f of card.forecasts) {
      printWarning(`  [${f.driver}] ${f.explanation}`);
      printInfo(`    -> ${f.recommendation}`);
    }
  }

  // Suggest next action
  if (summary.transitions.length > 0) {
    console.log('');
    printInfo('Next step: `crisismode diagnose` to investigate, or `crisismode recover` to fix.');
  }

  console.log('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

