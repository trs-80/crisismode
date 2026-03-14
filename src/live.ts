/**
 * Live mode entry point — runs the PgReplicationAgent against real PostgreSQL
 * containers in the podman test environment.
 *
 * Usage:
 *   pnpm run live              # defaults to localhost:5432/5433
 *   PG_HOST=10.0.0.1 pnpm run live  # custom host
 */

import { PgReplicationAgent } from './agent/pg-replication/agent.js';
import { PgLiveClient } from './agent/pg-replication/live-client.js';
import { assembleContext } from './framework/context.js';
import { validatePlan } from './framework/validator.js';
import { matchCatalog, getCatalogEntry } from './framework/catalog.js';
import { ForensicRecorder } from './framework/forensics.js';
import { ExecutionEngine, type EngineCallbacks } from './framework/engine.js';
import type { AgentContext } from './types/agent-context.js';
import type { HumanApprovalStep, SystemActionStep } from './types/step-types.js';
import * as display from './demo/display.js';

const FORENSIC_OUTPUT_PATH = 'output/forensic-record-live.json';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLive(): Promise<void> {
  const pgHost = process.env.PG_HOST || 'localhost';
  const pgPort = parseInt(process.env.PG_PORT || '5432', 10);
  const pgReplicaPort = parseInt(process.env.PG_REPLICA_PORT || '5433', 10);
  const pgUser = process.env.PG_USER || 'crisismode';
  const pgPassword = process.env.PG_PASSWORD || 'crisismode';
  const pgDatabase = process.env.PG_DATABASE || 'crisismode';

  display.banner();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  🔴 LIVE MODE — Real PostgreSQL Connections  │');
  console.log('  │                                              │');
  console.log(`  │  Primary:  ${pgHost}:${pgPort}                     │`);
  console.log(`  │  Replica:  ${pgHost}:${pgReplicaPort}                     │`);
  console.log(`  │  Database: ${pgDatabase}                       │`);
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');

  // Create live PostgreSQL backend
  const liveClient = new PgLiveClient(
    { host: pgHost, port: pgPort, user: pgUser, password: pgPassword, database: pgDatabase },
    { host: pgHost, port: pgReplicaPort, user: pgUser, password: pgPassword, database: pgDatabase },
  );

  try {
    // Quick connectivity check
    console.log('  Connecting to PostgreSQL...');
    const replStatus = await liveClient.queryReplicationStatus();
    const replicaStatus = await liveClient.queryReplicaStatus();
    const connCount = await liveClient.queryConnectionCount();
    const slots = await liveClient.queryReplicationSlots();

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

    await sleep(500);

    // ── Phase 1: Trigger ──
    display.phase(1, 'Trigger (Live)');
    display.step(1, 'Simulating Prometheus alert from live data');

    // Build trigger from live data — use the worst lag from either perspective
    const primaryViewLag = replStatus.reduce((max, r) => Math.max(max, r.lag_seconds), 0);
    const replicaViewLag = replicaStatus?.lagSeconds ?? 0;
    const maxLag = Math.max(primaryViewLag, replicaViewLag);
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'prometheus',
      payload: {
        alertname: 'PostgresReplicationLagCritical',
        instance: `${pgHost}:${pgPort}`,
        severity: maxLag > 30 ? 'critical' : maxLag > 10 ? 'warning' : 'info',
        lag_seconds: maxLag,
      },
      receivedAt: new Date().toISOString(),
    };
    display.displayTrigger(trigger);

    if (maxLag <= 10) {
      console.log('');
      console.log('  ℹ️  Replication lag is healthy (<10s). No recovery needed.');
      console.log('  💡 To create a test failure, run:');
      console.log('     ./test/failures/inject-replication-lag.sh');
      console.log('');
      console.log('  Then re-run: pnpm run live');
      return;
    }

    await sleep(300);

    // ── Phase 2: Agent + Context ──
    display.phase(2, 'Agent Selection & Context');

    const agent = new PgReplicationAgent(liveClient);
    const context = assembleContext(trigger, agent.manifest);
    display.displayManifest(
      agent.manifest.metadata.name,
      agent.manifest.metadata.version,
      agent.manifest.metadata.description,
    );
    await sleep(300);

    // ── Phase 3: Diagnosis ──
    display.phase(3, 'Diagnosis (Live)');
    display.step(3, 'Agent querying real PostgreSQL for diagnosis');

    const diagnosis = await agent.diagnose(context);
    display.displayDiagnosis(diagnosis);
    display.success(`Diagnosis: ${diagnosis.scenario} (${(diagnosis.confidence * 100).toFixed(0)}% confidence)`);
    await sleep(300);

    // ── Phase 4: Plan ──
    display.phase(4, 'Plan Creation');
    const plan = await agent.plan(context, diagnosis);
    display.displayPlanTable(plan);

    // ── Phase 5: Validation ──
    display.phase(5, 'Validation');
    const validation = validatePlan(plan, agent.manifest);
    display.displayValidation(validation);
    if (!validation.valid) {
      display.error('Plan validation failed');
      return;
    }
    display.success('Plan validated');

    // ── Phase 6: Catalog Match ──
    display.phase(6, 'Catalog Match');
    const catalogMatch = matchCatalog(plan);
    display.displayCatalogMatch(catalogMatch);
    await sleep(300);

    // ── Phase 7: Execution ──
    display.phase(7, 'Execution (Live — READ-ONLY)');
    console.log('');
    console.log('  ⚠️  Live execution is currently READ-ONLY.');
    console.log('  Diagnosis and state capture steps will execute against real PG.');
    console.log('  System actions that mutate state are logged but not executed.');
    console.log('');

    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);
    recorder.setCatalogMatchUsed(catalogMatch.matched);

    const callbacks: EngineCallbacks = {
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
      liveClient,
      callbacks,
    );
    engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

    await engine.executePlan(plan, diagnosis);

    // ── Phase 8: Forensics ──
    display.phase(8, 'Forensic Record');
    const record = recorder.writeToFile(FORENSIC_OUTPUT_PATH);
    display.displayForensicSummary(record);
    display.displayComplete(FORENSIC_OUTPUT_PATH);

  } finally {
    await liveClient.close();
  }
}

runLive().catch((err) => {
  console.error('Live mode failed:', err);
  process.exit(1);
});
