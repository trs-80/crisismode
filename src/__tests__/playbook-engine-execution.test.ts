// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Regression coverage for C1 (final-review-report.md): playbookToPlan()
 * compiles preconditions, success criteria, and conditionals as statement-less
 * `type: 'expression'` checks whenever a playbook step declares no explicit
 * precondition/success/condition text. Every backend now fails closed on an
 * unrecognized statement (the fail-closed sweep this branch implements), so
 * without engine-layer recognition of these checks as declared no-ops, a
 * compiled playbook plan aborts at its first precondition and every
 * conditional falls to its elseStep — even against a real fail-closed
 * backend that has never seen the playbook's business logic.
 *
 * This compiles a real shipped example playbook through the real parser +
 * playbookToPlan(), then drives it through both execution engines against a
 * real (fail-closed) PgSimulator backend, asserting no step fails because of
 * a statement-less check.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemorySaver } from '@langchain/langgraph';

// Mock the coordinator so the human_approval step doesn't block on stdin.
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: vi.fn(async () => 'approved'),
  shouldAutoApprove: vi.fn(() => true),
}));

import { parsePlaybook } from '../framework/playbook/parser.js';
import { playbookToPlan, buildPlaybookManifest } from '../framework/playbook/runtime.js';
import { LegacyExecutionEngine } from '../framework/engine.js';
import { RecoveryGraphEngine } from '../framework/graph-engine.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { ForensicRecorder } from '../framework/forensics.js';
import { assembleContext } from '../framework/context.js';
import { defaultReplan } from '../agent/interface.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { AgentContext } from '../types/agent-context.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

function compilePlan(): { plan: RecoveryPlan; manifest: ReturnType<typeof buildPlaybookManifest> } {
  const content = readFileSync('playbooks/examples/pg-replication-lag.md', 'utf-8');
  const parsed = parsePlaybook(content, 'pg-replication-lag.md');
  return { plan: playbookToPlan(parsed), manifest: buildPlaybookManifest(parsed) };
}

/**
 * A minimal playbook whose system_action step declares no `capability:`.
 *
 * Used only for the execute-mode tests below. buildPlaybookManifest()
 * hardcodes every execution context's `target` to the literal string
 * 'primary' (src/framework/playbook/runtime.ts) — a per-step instance
 * identifier, not a technology kind. resolveStepProviders()
 * (src/framework/provider-registry.ts) compares that `target` against each
 * required capability's `targetKinds`, which are technology strings (e.g.
 * 'postgresql', 'linux' — see src/agent/pg-replication/manifest.ts). That
 * mismatch means the SHIPPED pg-replication-lag.md playbook's own
 * capability-declaring steps (4, 5, 8) fail provider resolution the moment
 * execute mode's `!providerResolution.resolved -> fail` gate is reached
 * (engine.ts, graph-nodes.ts) — a real, pre-existing bug, unrelated to C1 or
 * this check-evaluation sweep, and out of scope here. A step with no
 * declared capability skips that gate entirely (empty
 * requiredCapabilities.every(...) is vacuously true), which is enough to
 * isolate and exercise what this test actually targets: the success-criteria
 * no-op path (isDeclarativeNoOpCheck()) in execute mode.
 */
function compileMinimalNoOpPlan(): { plan: RecoveryPlan; manifest: ReturnType<typeof buildPlaybookManifest> } {
  const content = `---
name: "noop-execute-test"
version: "1.0.0"
description: "Minimal playbook for execute-mode success-criteria no-op coverage"
agent: pg-replication
severity: routine
---

### 1. Mutate the system
- type: system_action
- risk: routine
- target: primary

\`\`\`sql
SELECT 1;
\`\`\`

### 2. Verify or escalate
- type: conditional
- condition: "system recovered"
- on_success: "All good"

## Rollback

Revert the single mutation manually.
`;
  const parsed = parsePlaybook(content, 'noop-execute-test.md');
  return { plan: playbookToPlan(parsed), manifest: buildPlaybookManifest(parsed) };
}

function makeStubAgent(manifest: ReturnType<typeof buildPlaybookManifest>, plan: RecoveryPlan): RecoveryAgent {
  return {
    manifest,
    assessHealth: () => {
      throw new Error('not used by this test');
    },
    diagnose: () => {
      throw new Error('not used by this test');
    },
    plan: () => Promise.resolve(plan),
    // The playbook's step 6 is a replanning_checkpoint; the engine calls
    // agent.replan() there. defaultReplan() always continues with the
    // existing plan, which is exactly what we want — this test is about
    // check evaluation, not agent-specific replanning behavior.
    replan: defaultReplan,
  };
}

function makeContext(manifest: ReturnType<typeof buildPlaybookManifest>): AgentContext {
  const trigger: AgentContext['trigger'] = {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname: 'PostgresReplicationLagCritical',
      instance: 'pg-primary-us-east-1',
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
  return assembleContext(trigger, manifest);
}

function makeDiagnosis(): DiagnosisResult {
  return {
    status: 'identified',
    scenario: 'replication_lag_cascade',
    confidence: 0.9,
    findings: [],
    diagnosticPlanNeeded: false,
  };
}

describe('compiled playbook plans against a fail-closed backend', () => {
  it('playbookToPlan emits statement-less expression checks (precondition for this test class)', () => {
    const { plan } = compilePlan();
    const disconnectStep = plan.steps.find((s) => s.type === 'system_action' && s.name.includes('Disconnect'));
    expect(disconnectStep?.type).toBe('system_action');
    if (disconnectStep?.type === 'system_action') {
      // The playbook declares a `precondition:` and `success:` line, but
      // convertStep() still emits { type: 'expression', expect: {...} } with
      // no statement for either — the description carries the author's
      // intent, but the check itself is unevaluable by any backend.
      expect(disconnectStep.preConditions?.[0]?.check.statement).toBeUndefined();
      expect(disconnectStep.preConditions?.[0]?.check.type).toBe('expression');
      expect(disconnectStep.successCriteria.check.statement).toBeUndefined();
      expect(disconnectStep.successCriteria.check.type).toBe('expression');
    }
  });

  it('LegacyExecutionEngine completes every step without a precondition/success/conditional failure', async () => {
    const { plan, manifest } = compilePlan();
    const context = makeContext(manifest);
    const agent = makeStubAgent(manifest, plan);
    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    const backend = new PgSimulator();

    const engine = new LegacyExecutionEngine(context, manifest, agent, recorder, backend, {}, 'dry-run');
    engine.setCoveredRiskLevels(['routine', 'elevated', 'high']);

    const results = await engine.executePlan(plan, makeDiagnosis());

    expect(results.length).toBe(plan.steps.length);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed.map((r) => ({ stepId: r.stepId, error: r.error }))).toEqual([]);
  });

  it('RecoveryGraphEngine completes every step without a precondition/success/conditional failure', async () => {
    const { plan, manifest } = compilePlan();
    const context = makeContext(manifest);
    const agent = makeStubAgent(manifest, plan);
    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    const backend = new PgSimulator();

    const engine = new RecoveryGraphEngine(context, manifest, agent, recorder, backend, 'dry-run', {
      checkpointer: new MemorySaver(),
    });
    engine.setCoveredRiskLevels(['routine', 'elevated', 'high']);

    const results = await engine.executePlan(plan, makeDiagnosis());

    expect(results.length).toBe(plan.steps.length);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed.map((r) => ({ stepId: r.stepId, error: r.error }))).toEqual([]);
  });

  // CodeRabbit finding E: the two tests above are dry-run only, so
  // successCriteria evaluation (engine.ts's Phase 6 / graph-nodes.ts's
  // success-criteria check) is never exercised — dry-run returns success
  // before reaching it. Preconditions and conditionals ARE evaluated in
  // dry-run, but success criteria are not (see engine.ts's dry-run early
  // return and graph-nodes.ts's mirrored branch). Execute mode is safe here
  // because the backend is a simulator — no real infrastructure is touched.
  //
  // These use compileMinimalNoOpPlan() rather than the shipped
  // pg-replication-lag.md playbook — see that function's doc comment for
  // why the shipped playbook cannot run in execute mode today (a separate,
  // pre-existing provider-resolution bug).

  it('LegacyExecutionEngine completes every step in execute mode, exercising the success-criteria no-op path', async () => {
    const { plan, manifest } = compileMinimalNoOpPlan();
    const context = makeContext(manifest);
    const agent = makeStubAgent(manifest, plan);
    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    const backend = new PgSimulator();

    const engine = new LegacyExecutionEngine(context, manifest, agent, recorder, backend, {}, 'execute');
    engine.setCoveredRiskLevels(['routine', 'elevated', 'high']);

    const results = await engine.executePlan(plan, makeDiagnosis());

    expect(results.length).toBe(plan.steps.length);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed.map((r) => ({ stepId: r.stepId, error: r.error }))).toEqual([]);
  });

  it('RecoveryGraphEngine completes every step in execute mode, exercising the success-criteria no-op path', async () => {
    const { plan, manifest } = compileMinimalNoOpPlan();
    const context = makeContext(manifest);
    const agent = makeStubAgent(manifest, plan);
    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    const backend = new PgSimulator();

    const engine = new RecoveryGraphEngine(context, manifest, agent, recorder, backend, 'execute', {
      checkpointer: new MemorySaver(),
    });
    engine.setCoveredRiskLevels(['routine', 'elevated', 'high']);

    const results = await engine.executePlan(plan, makeDiagnosis());

    expect(results.length).toBe(plan.steps.length);
    const failed = results.filter((r) => r.status === 'failed');
    expect(failed.map((r) => ({ stepId: r.stepId, error: r.error }))).toEqual([]);
  });
});
