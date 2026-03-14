import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { assembleContext } from '../framework/context.js';
import { validatePlan } from '../framework/validator.js';
import { matchCatalog, getCatalogEntry } from '../framework/catalog.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { ExecutionEngine, type EngineCallbacks } from '../framework/engine.js';
import type { AgentContext } from '../types/agent-context.js';
import type { HumanApprovalStep, SystemActionStep } from '../types/step-types.js';
import * as display from './display.js';

const FORENSIC_OUTPUT_PATH = 'output/forensic-record.json';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDemo(): Promise<void> {
  // ── Banner ──
  display.banner();
  await sleep(500);

  // ── Phase 1: Trigger ──
  display.phase(1, 'Trigger');
  display.step(1, 'Prometheus alert fires');

  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
      lag_seconds: 342,
    },
    receivedAt: new Date().toISOString(),
  };
  display.displayTrigger(trigger);
  await sleep(300);

  // ── Phase 2: Catalog Check ──
  display.phase(2, 'Pre-Authorized Catalog Check');
  display.step(2, 'Checking pre-authorized action catalogs');

  const catalogEntry = getCatalogEntry();
  display.displayCatalogEntry(catalogEntry);
  display.success('Catalog entry found for this scenario');
  await sleep(300);

  // ── Phase 3: Agent Selection ──
  display.phase(3, 'Agent Selection');
  display.step(3, 'Selecting recovery agent based on trigger');

  const agent = new PgReplicationAgent();
  display.displayManifest(
    agent.manifest.metadata.name,
    agent.manifest.metadata.version,
    agent.manifest.metadata.description,
  );
  display.success('Agent selected: trigger matches manifest conditions');
  await sleep(300);

  // ── Phase 4: Context Assembly ──
  display.phase(4, 'Context Assembly');
  display.step(4, 'Assembling agent context from trigger and topology');

  const context = assembleContext(trigger, agent.manifest);
  display.displayContext(context);
  await sleep(300);

  // ── Phase 5: Diagnosis ──
  display.phase(5, 'Diagnosis');
  display.step(5, 'Agent performing read-only investigation');

  const diagnosis = await agent.diagnose(context);
  display.displayDiagnosis(diagnosis);
  display.success(`Diagnosis complete: ${diagnosis.scenario} (${(diagnosis.confidence * 100).toFixed(0)}% confidence)`);
  await sleep(300);

  // ── Phase 6: Plan Creation ──
  display.phase(6, 'Plan Creation');
  display.step(6, 'Agent building recovery plan');

  const plan = await agent.plan(context, diagnosis);
  display.displayPlanTable(plan);
  await sleep(300);

  // ── Phase 7: Plan Validation ──
  display.phase(7, 'Plan Validation');
  display.step(7, 'Framework validating plan against manifest and policies');

  const validationResult = validatePlan(plan, agent.manifest);
  display.displayValidation(validationResult);
  if (validationResult.valid) {
    display.success('Plan validation passed');
  } else {
    display.error('Plan validation failed');
    return;
  }
  await sleep(300);

  // ── Phase 8: Catalog Match ──
  display.phase(8, 'Catalog Matching');
  display.step(8, 'Matching plan against pre-authorized catalog');

  const catalogMatch = matchCatalog(plan);
  display.displayCatalogMatch(catalogMatch);
  await sleep(300);

  // ── Phase 9: Execution ──
  display.phase(9, 'Execution');
  display.step(9, 'Beginning plan execution');
  console.log('');

  const recorder = new ForensicRecorder();
  recorder.setContext(context);
  recorder.setDiagnosis(diagnosis);
  recorder.addPlan(plan);
  recorder.setCatalogMatchUsed(catalogMatch.matched);

  const callbacks: EngineCallbacks = {
    onStepStart: (s, i) => {
      display.displayStepExecution(s, i);
    },
    onStepComplete: (s, result) => {
      display.displayStepResult(s, result);
    },
    onPreConditionCheck: (_s, passed, desc) => {
      display.displayPreCondition(passed, desc);
    },
    onSuccessCheck: (_s, passed, desc) => {
      display.displaySuccessCheck(passed, desc);
    },
    onCapture: (name, status) => {
      display.displayCaptureResult(name, status);
    },
    onNotification: (s) => {
      if (s.type === 'human_notification') {
        display.displayNotification(s);
      }
    },
    onApprovalRequest: (s) => {
      if (s.type === 'human_approval') {
        display.displayApprovalPrompt(s as HumanApprovalStep);
      }
    },
    onApprovalResult: (s, result, catalogCovered) => {
      if (result === 'approved' && catalogCovered) {
        display.displayAutoApproval(true);
      } else if (result === 'approved') {
        display.success(`Approval received: ${result}`);
      } else {
        display.warning(`Approval result: ${result}`);
      }
    },
    onConditionalEval: (_s, result) => {
      display.displayConditionalResult(result);
    },
    onReplanStart: () => {
      display.displayReplanStart();
    },
    onReplanResult: (action, details) => {
      display.displayReplanResult(action, details);
    },
    onBlastRadiusCheck: (s, msg) => {
      display.displayBlastRadius(s, msg);
    },
  };

  const engine = new ExecutionEngine(
    context,
    agent.manifest,
    agent,
    recorder,
    agent.simulator,
    callbacks,
  );
  engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

  await engine.executePlan(plan, diagnosis);

  // ── Phase 10: Completion ──
  display.phase(10, 'Completion');
  display.step(10, 'Writing forensic record');

  const record = recorder.writeToFile(FORENSIC_OUTPUT_PATH);
  display.displayForensicSummary(record);
  display.displayComplete(FORENSIC_OUTPUT_PATH);
}
