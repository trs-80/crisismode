// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Live mode entry point — runs recovery agents against real infrastructure.
 * Uses crisismode.yaml for target configuration, with env-var fallback.
 *
 * Usage:
 *   pnpm run live                                  # dry-run, first target
 *   pnpm run live -- --execute                     # live execution with mutations
 *   pnpm run live -- --config crisismode.yaml      # explicit config path
 *   pnpm run live -- --target main-postgres        # specific named target
 *   pnpm run live -- --health-only                 # direct health probe only
 */

import { createInterface } from 'node:readline';
import { assembleContext } from './framework/context.js';
import { diagnoseWithEnvironmentGuard } from './framework/environment-guard.js';
import { buildOperatorSummary } from './framework/operator-summary.js';
import { validatePlan } from './framework/validator.js';
import { matchCatalog } from './framework/catalog.js';
import { ForensicRecorder } from './framework/forensics.js';
import { ExecutionEngine, type ExecutionMode, type EngineCallbacks } from './framework/engine.js';
import { explainPlan } from './framework/ai-explainer.js';
import { loadConfig, parseCliFlags } from './config/loader.js';
import { validateCredentials } from './config/credentials.js';
import { AgentRegistry } from './config/agent-registry.js';
import { createAgentForTarget } from './cli/runtime.js';
import type { AgentContext } from './types/agent-context.js';
import type { HumanApprovalStep } from './types/step-types.js';
import type { PgLiveClient } from './agent/pg-replication/live-client.js';
import * as display from './demo/display.js';
import {
  getOutputMode, printHealthStatus, printDiagnosis, printPlan,
  printPlanExplanation, printResults, printOperatorSummary,
} from './cli/output.js';

const FORENSIC_OUTPUT_PATH = 'output/forensic-record-live.json';

/** True when display.* human-formatted output should be suppressed. */
function isJson(): boolean {
  return getOutputMode() === 'machine';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prompt the user for confirmation before executing mutations.
 * Returns true if the user confirms, false otherwise.
 *
 * Non-interactive behavior: the prompt requires an interactive TTY. When
 * stdin is not a TTY (CI, harness, piped input), we fail closed unless
 * CRISISMODE_AUTO_CONFIRM=1 is set as an explicit opt-in.
 */
async function confirmExecution(targetName: string, targetKind: string): Promise<boolean> {
  if (process.env.CRISISMODE_AUTO_CONFIRM === '1') {
    console.log(`  EXECUTE MODE auto-confirmed via CRISISMODE_AUTO_CONFIRM=1 (target: ${targetName} [${targetKind}])`);
    return true;
  }

  if (!process.stdin.isTTY) {
    console.error('  --execute requires an interactive terminal for confirmation.');
    console.error('  Set CRISISMODE_AUTO_CONFIRM=1 to bypass the prompt in non-interactive contexts.');
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  WARNING: EXECUTE MODE                              │');
    console.log('  │                                                     │');
    console.log(`  │  Target: ${targetName} (${targetKind})`);
    console.log('  │  This will run mutations against real infrastructure│');
    console.log('  │  including SQL writes, service restarts, etc.       │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log('');
    rl.question('  Type "yes" to confirm execute mode: ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

export interface RecoveryOptions {
  configPath?: string;
  targetName?: string;
  execute?: boolean;
  healthOnly?: boolean;
}

/**
 * Run the full recovery flow — extracted for CLI reuse.
 */
export async function runRecovery(options: RecoveryOptions = {}): Promise<void> {
  const execMode: ExecutionMode = options.execute ? 'execute' : 'dry-run';
  const healthOnly = options.healthOnly ?? false;
  const configPath = options.configPath;
  const targetName = options.targetName;

  // Load config (file or env-var fallback)
  const { config, source, filePath } = loadConfig(configPath !== undefined ? { configPath } : {});

  // Validate credential env vars at load time
  for (const target of config.targets) {
    const warnings = validateCredentials(target.credentials);
    for (const w of warnings) {
      console.warn(`  Warning: Target "${target.name}" — ${w.message}`);
    }
  }

  const registry = new AgentRegistry(config);

  // Resolve the target to run against (and discover its version if unset)
  const { agent, backend, target } = await createAgentForTarget(registry, targetName);

  // Confirm before execute mode — prevent accidental mutations
  if (execMode === 'execute') {
    const confirmed = await confirmExecution(target.name, target.kind);
    if (!confirmed) {
      console.log('  Aborted. Run without --execute for dry-run mode.');
      return;
    }
  }

  // Cast for PG-specific connectivity display (only used for postgresql targets)
  const pgClient = target.kind === 'postgresql' ? backend as PgLiveClient : null;

  if (!isJson()) {
    display.banner();
    console.log('');
    console.log(`  Config: ${source === 'file' ? filePath : 'env-var fallback (no crisismode.yaml found)'}`);
    console.log('  ┌─────────────────────────────────────────────┐');
    console.log(`  │  🔴 LIVE MODE — ${target.kind} target: ${target.name}`);
    console.log('  │                                              │');
    console.log(`  │  Primary:  ${target.primary.host}:${target.primary.port}`);
    if (target.replicas.length > 0) {
      console.log(`  │  Replica:  ${target.replicas[0]!.host}:${target.replicas[0]!.port}`);
    }
    if (target.primary.database) {
      console.log(`  │  Database: ${target.primary.database}`);
    }
    if (target.version) {
      console.log(`  │  Version:  ${target.version}`);
    }
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
  }

  try {
    // Quick connectivity check (PG-specific display)
    let replStatus: Awaited<ReturnType<PgLiveClient['queryReplicationStatus']>> = [];
    let replicaStatus: Awaited<ReturnType<PgLiveClient['queryReplicaStatus']>> = null;

    if (pgClient) {
      if (!isJson()) console.log('  Connecting to PostgreSQL...');
      try {
        replStatus = await pgClient.queryReplicationStatus();
        replicaStatus = await pgClient.queryReplicaStatus();
        const connCount = await pgClient.queryConnectionCount();
        const slots = await pgClient.queryReplicationSlots();

        if (!isJson()) {
          console.log(`  ✅ Primary connected — ${connCount} active connections`);
          console.log(`  ✅ Replication: ${replStatus.length} replica(s) streaming`);
          if (replicaStatus) {
            console.log(`  ✅ Replica connected — recovery mode: ${replicaStatus.isInRecovery}, lag: ${replicaStatus.lagSeconds}s`);
          }
          console.log(`  ✅ Slots: ${slots.length} replication slot(s)`);
          console.log('');

          // Show live replication data
          console.log('  ── Live Replication Status ──');
          for (const r of replStatus) {
            const lagColor = r.lag_seconds > 30 ? '🔴' : r.lag_seconds > 10 ? '🟡' : '🟢';
            console.log(`  ${lagColor} ${r.client_addr} | ${r.state} | lag: ${r.lag_seconds}s | sent: ${r.sent_lsn} | replay: ${r.replay_lsn}`);
          }
          console.log('');

          for (const s of slots) {
            const statusIcon = s.active ? '🟢' : '🔴';
            console.log(`  ${statusIcon} Slot: ${s.slot_name} | type: ${s.slot_type} | active: ${s.active} | wal: ${s.wal_status}`);
          }
          console.log('');
        }
      } catch {
        if (!isJson()) {
          console.log('  ❌ PostgreSQL unreachable — target is down or connection refused');
          console.log('');
        }
      }
    } else {
      if (!isJson()) console.log(`  Connecting to ${target.kind} target "${target.name}"...`);
    }

    if (!isJson()) await sleep(500);

    // ── Phase 1: Trigger ──
    if (!isJson()) {
      display.phase(1, 'Trigger (Live)');
      display.step(1, 'Simulating Prometheus alert from live data');
    }

    // Build trigger from live data
    const primaryViewLag = replStatus.reduce((max, r) => Math.max(max, r.lag_seconds), 0);
    const replicaViewLag = replicaStatus?.lagSeconds ?? 0;
    const maxLag = Math.max(primaryViewLag, replicaViewLag);
    const alertname = target.kind === 'postgresql'
      ? 'PostgresReplicationLagCritical'
      : target.kind === 'redis'
        ? 'RedisMemoryPressureCritical'
        : `${target.kind}HealthDegraded`;
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'prometheus',
      payload: {
        alertname,
        instance: `${target.primary.host}:${target.primary.port}`,
        severity: maxLag > 30 ? 'critical' : maxLag > 10 ? 'warning' : 'info',
        lag_seconds: maxLag,
      },
      receivedAt: new Date().toISOString(),
    };
    if (!isJson()) display.displayTrigger(trigger);

    // ── Phase 2: Agent + Context ──
    if (!isJson()) {
      display.phase(2, 'Agent Selection & Context');
      display.displayManifest(
        agent.manifest.metadata.name,
        agent.manifest.metadata.version,
        agent.manifest.metadata.description,
      );
    }

    const context = assembleContext(trigger, agent.manifest);
    if (!isJson()) await sleep(300);

    // ── Phase 3: Health Assessment ──
    if (!isJson()) {
      display.phase(3, healthOnly ? 'Health Assessment (Live — Standalone)' : 'Health Assessment (Live)');
      display.step(3, 'Agent probing live PostgreSQL health directly');
    }
    const initialHealth = await agent.assessHealth(context);
    if (isJson()) {
      printHealthStatus(initialHealth);
    } else {
      display.displayHealthAssessment(initialHealth);
    }

    if (healthOnly || initialHealth.status === 'healthy') {
      if (!isJson()) {
        if (initialHealth.status === 'healthy' && !healthOnly) {
          display.success('Direct health probe indicates the system is healthy. No recovery action is required.');
          display.warning('The triggering alert may be stale or delayed relative to current system state.');
        }
        display.phase(4, 'Operator Summary');
      }

      const earlySummary = buildOperatorSummary({
        health: initialHealth,
        mode: execMode,
        healthCheckOnly: healthOnly,
      });
      if (isJson()) {
        printOperatorSummary(earlySummary);
      } else {
        display.displayOperatorSummary(earlySummary);
        if (!healthOnly && initialHealth.status === 'healthy') {
          console.log('  💡 To create a test failure, run:');
          console.log('     ./test/failures/inject-replication-lag.sh');
          console.log('');
          console.log('  Then re-run: pnpm run live');
        }
      }
      return;
    }

    if (!isJson()) await sleep(300);

    // ── Phase 4: Diagnosis ──
    const hasAiKey = !!process.env.ANTHROPIC_API_KEY;
    if (!isJson()) {
      display.phase(4, hasAiKey ? 'Diagnosis (Live — AI-Powered)' : 'Diagnosis (Live — Rule-Based)');
      if (hasAiKey) {
        console.log('  🤖 AI analyzing system state via Claude...');
      } else {
        console.log('  📋 Using rule-based diagnosis (set ANTHROPIC_API_KEY for AI diagnosis)');
      }
      display.step(4, 'Agent querying real PostgreSQL for diagnosis');
    }

    const diagnosis = await diagnoseWithEnvironmentGuard(agent, context, target, config.targets);
    if (isJson()) {
      printDiagnosis(diagnosis);
    } else {
      display.displayDiagnosis(diagnosis);
      display.success(`Diagnosis: ${diagnosis.scenario} (${(diagnosis.confidence * 100).toFixed(0)}% confidence)`);
    }
    if (!isJson()) await sleep(300);

    // ── Phase 5: Plan ──
    if (!isJson()) display.phase(5, 'Plan Creation');
    const plan = await agent.plan(context, diagnosis);

    // AI plan explanation (falls back to structural summary if no API key)
    const explanation = await explainPlan(plan, diagnosis);
    if (isJson()) {
      printPlan(plan);
      printPlanExplanation(explanation);
    } else {
      display.displayPlanTable(plan);
      display.displayPlanExplanation(explanation);
    }

    // ── Phase 6: Validation ──
    if (!isJson()) display.phase(6, 'Validation');
    const validation = validatePlan(plan, agent.manifest, {
      backend,
      executionMode: execMode,
      requireExecutableCapabilities: execMode === 'execute',
    });
    const executeReadinessValidation = validatePlan(plan, agent.manifest, {
      backend,
      executionMode: 'execute',
      requireExecutableCapabilities: true,
    });
    if (!isJson()) {
      display.displayValidation(validation);
      if (execMode === 'dry-run' && !executeReadinessValidation.valid) {
        display.warning('Dry-run can continue, but execute mode is currently blocked by live capability/provider readiness.');
      }
    }
    if (!validation.valid) {
      const blockedHealth = await agent.assessHealth(context);
      const blockedSummary = buildOperatorSummary({
        health: blockedHealth,
        mode: execMode,
        currentValidation: validation,
        executeValidation: executeReadinessValidation,
      });
      if (isJson()) {
        printOperatorSummary(blockedSummary);
      } else {
        display.phase(7, 'Operator Summary');
        display.displayOperatorSummary(blockedSummary);
        display.error('Plan validation failed');
      }
      return;
    }
    if (!isJson()) display.success('Plan validated');

    // ── Phase 7: Catalog Match ──
    if (!isJson()) display.phase(7, 'Catalog Match');
    const catalogMatch = matchCatalog(plan);
    if (!isJson()) {
      display.displayCatalogMatch(catalogMatch);
      await sleep(300);
    }

    // ── Phase 8: Execution ──
    if (!isJson()) {
      if (execMode === 'execute') {
        display.phase(8, 'Execution (Live — EXECUTE MODE)');
        console.log('');
        console.log('  🔴 EXECUTE MODE — SQL mutations WILL be run against real PostgreSQL.');
        console.log('');
      } else {
        display.phase(8, 'Execution (Live — DRY-RUN)');
        console.log('');
        console.log('  🟡 DRY-RUN — Diagnosis and checks run against real PG.');
        console.log('     System actions are logged but NOT executed.');
        console.log('     To execute mutations: pnpm run live -- --execute');
        console.log('');
      }
    }

    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);
    recorder.setCatalogMatchUsed(catalogMatch.matched);

    const callbacks: EngineCallbacks = isJson() ? {} : {
      onStepStart: (s, i) => display.displayStepExecution(s, i),
      onStepComplete: (s, result) => display.displayStepResult(s, result),
      onPreConditionCheck: (_s, passed, desc) => display.displayPreCondition(passed, desc),
      onSuccessCheck: (_s, passed, desc) => display.displaySuccessCheck(passed, desc),
      onCapture: (name, status) => display.displayCaptureResult(name, status),
      onNotification: (s) => {
        if (s.type === 'human_notification') display.displayNotification(s);
      },
      onApprovalRequest: (s) => {
        if (s.type === 'human_approval') display.displayApprovalPrompt(s as HumanApprovalStep);
      },
      onApprovalResult: (_s, result, catalogCovered) => {
        if (result === 'approved' && catalogCovered) {
          display.displayAutoApproval(true);
        }
      },
      onConditionalEval: (_s, result) => display.displayConditionalResult(result),
      onReplanStart: () => display.displayReplanStart(),
      onReplanResult: (action, details) => display.displayReplanResult(action, details),
      onBlastRadiusCheck: (s, msg) => display.displayBlastRadius(s, msg),
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      callbacks,
      execMode,
    );
    engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

    const results = await engine.executePlan(plan, diagnosis);
    if (isJson()) printResults(results);

    // ── Phase 9: Operator Summary ──
    if (!isJson()) display.phase(9, 'Operator Summary');
    const finalHealth = await agent.assessHealth(context);
    const finalSummary = buildOperatorSummary({
      health: finalHealth,
      mode: execMode,
      currentValidation: validation,
      executeValidation: executeReadinessValidation,
      results,
    });
    if (isJson()) {
      printOperatorSummary(finalSummary);
    } else {
      display.displayOperatorSummary(finalSummary);
    }

    // ── Phase 10: Forensics ──
    if (!isJson()) {
      display.phase(10, 'Forensic Record');
      const record = recorder.writeToFile(FORENSIC_OUTPUT_PATH);
      display.displayForensicSummary(record);
      display.displayComplete(FORENSIC_OUTPUT_PATH);
    } else {
      recorder.writeToFile(FORENSIC_OUTPUT_PATH);
    }

  } finally {
    await backend.close();
  }
}

/** Backward-compatible entry point for `pnpm run live`. */
function runLive(): Promise<void> {
  const execMode = process.argv.includes('--execute');
  const healthOnly = process.argv.includes('--health-only');
  const { configPath, targetName } = parseCliFlags(process.argv);
  return runRecovery({
    ...(configPath !== undefined ? { configPath } : {}),
    ...(targetName !== undefined ? { targetName } : {}),
    execute: execMode,
    healthOnly,
  });
}

// Direct execution entry point (backward compat for `pnpm run live`).
// Guarded so importing this module (e.g. `runRecovery` from recover.ts, or
// from tests) never triggers a background CLI run — matches the pattern
// already used in webhook.ts.
const isDirectExecution = process.argv[1]?.endsWith('live.ts') || process.argv[1]?.endsWith('live.js');
if (isDirectExecution) {
  runLive().catch((err) => {
    console.error('Live mode failed:', err);
    process.exit(1);
  });
}
