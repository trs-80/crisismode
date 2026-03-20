// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Generic agent test harness.
 *
 * Validates any RecoveryAgent against the contract, and any external check
 * plugin against the check-plugin protocol.  Designed to be used from vitest
 * tests but has no test-framework dependency itself.
 */

import type { RecoveryAgent } from '../agent/interface.js';
import type { AgentContext } from '../types/agent-context.js';
import type { CheckPluginManifest, CheckRequest, CheckVerb } from './check-plugin.js';
import { executeCheckPlugin, executeNagiosPlugin, executeGossPlugin, executeSensuPlugin } from './check-plugin.js';

// ── Public types ──

export interface HarnessResult {
  passed: boolean;
  checks: HarnessCheck[];
}

export interface HarnessCheck {
  name: string;
  passed: boolean;
  message: string;
}

// ── Agent validation ──

/**
 * Run the full agent contract validation suite.
 */
export async function validateAgent(
  agent: RecoveryAgent,
  context: AgentContext,
): Promise<HarnessResult> {
  const checks: HarnessCheck[] = [];

  // 1. Manifest checks
  checks.push(checkManifest(agent));

  // 2. assessHealth
  checks.push(await checkAssessHealth(agent, context));

  // 3. diagnose
  const { check: diagnoseCheck, result: diagnosisResult } =
    await checkDiagnose(agent, context);
  checks.push(diagnoseCheck);

  // 4. plan (only if diagnosis succeeded)
  if (diagnosisResult) {
    checks.push(await checkPlan(agent, context, diagnosisResult));
  } else {
    checks.push({
      name: 'plan returns valid RecoveryPlan',
      passed: false,
      message: 'Skipped — diagnose did not return a result',
    });
  }

  // 5. Methods return promises
  checks.push(checkMethodsAsync(agent, context));

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function checkManifest(agent: RecoveryAgent): HarnessCheck {
  const m = agent.manifest;
  const missing: string[] = [];

  if (!m) return { name: 'manifest exists', passed: false, message: 'manifest is falsy' };
  if (!m.metadata?.name) missing.push('metadata.name');
  if (!m.metadata?.version) missing.push('metadata.version');
  if (!m.apiVersion) missing.push('apiVersion');
  if (m.kind !== 'AgentManifest') missing.push('kind (expected "AgentManifest")');

  if (missing.length > 0) {
    return {
      name: 'manifest has required fields',
      passed: false,
      message: `Missing or invalid: ${missing.join(', ')}`,
    };
  }

  return { name: 'manifest has required fields', passed: true, message: 'OK' };
}

async function checkAssessHealth(
  agent: RecoveryAgent,
  context: AgentContext,
): Promise<HarnessCheck> {
  try {
    const health = await agent.assessHealth(context);
    const validStatuses = ['healthy', 'recovering', 'unhealthy', 'unknown'];
    const errors: string[] = [];

    if (!validStatuses.includes(health.status)) {
      errors.push(`status "${health.status}" not in ${validStatuses.join(',')}`);
    }
    if (typeof health.confidence !== 'number' || health.confidence < 0 || health.confidence > 1) {
      errors.push(`confidence ${health.confidence} not in [0,1]`);
    }
    if (!health.summary || typeof health.summary !== 'string') {
      errors.push('summary is missing or not a string');
    }

    if (errors.length > 0) {
      return {
        name: 'assessHealth returns valid HealthAssessment',
        passed: false,
        message: errors.join('; '),
      };
    }
    return {
      name: 'assessHealth returns valid HealthAssessment',
      passed: true,
      message: 'OK',
    };
  } catch (err) {
    return {
      name: 'assessHealth returns valid HealthAssessment',
      passed: false,
      message: `Threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDiagnose(
  agent: RecoveryAgent,
  context: AgentContext,
): Promise<{ check: HarnessCheck; result: Awaited<ReturnType<RecoveryAgent['diagnose']>> | null }> {
  try {
    const diag = await agent.diagnose(context);
    const validStatuses = ['identified', 'partial', 'inconclusive', 'unable'];
    const errors: string[] = [];

    if (!validStatuses.includes(diag.status)) {
      errors.push(`status "${diag.status}" not in ${validStatuses.join(',')}`);
    }
    if (!Array.isArray(diag.findings)) {
      errors.push('findings is not an array');
    }
    if (typeof diag.confidence !== 'number') {
      errors.push('confidence is not a number');
    }

    if (errors.length > 0) {
      return {
        check: {
          name: 'diagnose returns valid DiagnosisResult',
          passed: false,
          message: errors.join('; '),
        },
        result: null,
      };
    }
    return {
      check: {
        name: 'diagnose returns valid DiagnosisResult',
        passed: true,
        message: 'OK',
      },
      result: diag,
    };
  } catch (err) {
    return {
      check: {
        name: 'diagnose returns valid DiagnosisResult',
        passed: false,
        message: `Threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      result: null,
    };
  }
}

async function checkPlan(
  agent: RecoveryAgent,
  context: AgentContext,
  diagnosis: Awaited<ReturnType<RecoveryAgent['diagnose']>>,
): Promise<HarnessCheck> {
  try {
    const plan = await agent.plan(context, diagnosis);
    const errors: string[] = [];

    if (!plan.metadata?.planId) errors.push('missing metadata.planId');
    if (!plan.metadata?.agentName) errors.push('missing metadata.agentName');

    // Check for duplicate step IDs
    const stepIds = plan.steps.map((s) => s.stepId);
    const dupes = stepIds.filter((id, i) => stepIds.indexOf(id) !== i);
    if (dupes.length > 0) {
      errors.push(`duplicate step IDs: ${[...new Set(dupes)].join(', ')}`);
    }

    if (errors.length > 0) {
      return {
        name: 'plan returns valid RecoveryPlan',
        passed: false,
        message: errors.join('; '),
      };
    }
    return { name: 'plan returns valid RecoveryPlan', passed: true, message: 'OK' };
  } catch (err) {
    return {
      name: 'plan returns valid RecoveryPlan',
      passed: false,
      message: `Threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkMethodsAsync(agent: RecoveryAgent, context: AgentContext): HarnessCheck {
  try {
    // Call each method and verify the return is a thenable (Promise)
    const healthResult = agent.assessHealth(context);
    const diagnoseResult = agent.diagnose(context);

    const isThenable = (v: unknown): boolean =>
      v != null && typeof (v as { then?: unknown }).then === 'function';

    if (!isThenable(healthResult) || !isThenable(diagnoseResult)) {
      return {
        name: 'methods return promises',
        passed: false,
        message: 'assessHealth or diagnose did not return a thenable',
      };
    }

    // Prevent unhandled rejections
    void Promise.resolve(healthResult).catch(() => {});
    void Promise.resolve(diagnoseResult).catch(() => {});

    return { name: 'methods return promises', passed: true, message: 'OK' };
  } catch (err) {
    return {
      name: 'methods return promises',
      passed: false,
      message: `Threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Check plugin validation ──

/**
 * Validate a check plugin against the external plugin contract.
 */
export async function validateCheckPlugin(
  executablePath: string,
  manifest: CheckPluginManifest,
  options?: { cwd?: string },
): Promise<HarnessResult> {
  const checks: HarnessCheck[] = [];

  // 1. Manifest fields
  checks.push(checkPluginManifest(manifest));

  // 2. Execute each verb and validate output
  for (const verb of manifest.verbs ?? []) {
    checks.push(await checkPluginVerb(executablePath, verb, manifest, options));
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function checkPluginManifest(manifest: CheckPluginManifest): HarnessCheck {
  const missing: string[] = [];
  if (!manifest.name) missing.push('name');
  if (!manifest.verbs || manifest.verbs.length === 0) missing.push('verbs');
  if (!manifest.targetKinds) missing.push('targetKinds');
  if (!manifest.executable) missing.push('executable');

  if (missing.length > 0) {
    return {
      name: 'plugin manifest has required fields',
      passed: false,
      message: `Missing: ${missing.join(', ')}`,
    };
  }
  return { name: 'plugin manifest has required fields', passed: true, message: 'OK' };
}

async function checkPluginVerb(
  executablePath: string,
  verb: string,
  manifest: CheckPluginManifest,
  options?: { cwd?: string },
): Promise<HarnessCheck> {
  const execOpts = { timeoutMs: manifest.timeoutMs ?? 10_000, cwd: options?.cwd };

  try {
    const res = manifest.format === 'nagios'
      ? await executeNagiosPlugin(executablePath, verb as CheckVerb, execOpts)
      : manifest.format === 'goss'
        ? await executeGossPlugin(executablePath, verb as CheckVerb, execOpts)
        : manifest.format === 'sensu'
          ? await executeSensuPlugin(executablePath, verb as CheckVerb, { ...execOpts, sensuMetricFormat: manifest.sensuMetricFormat })
          : await executeCheckPlugin(
            executablePath,
            { verb: verb as CheckVerb, target: { name: 'harness-test', kind: manifest.targetKinds[0] ?? 'generic' } },
            execOpts,
          );

    // Exit code must be 0-3
    if (res.exitCode < 0 || res.exitCode > 3) {
      return {
        name: `verb "${verb}" produces valid output`,
        passed: false,
        message: `Unexpected exit code ${res.exitCode}`,
      };
    }

    if (!res.result) {
      return {
        name: `verb "${verb}" produces valid output`,
        passed: false,
        message: `No parseable JSON output (stderr: ${res.stderr.slice(0, 200)})`,
      };
    }

    // Verb-specific validation
    const errors = validateVerbResult(verb, res.result as unknown as Record<string, unknown>);
    if (errors.length > 0) {
      return {
        name: `verb "${verb}" produces valid output`,
        passed: false,
        message: errors.join('; '),
      };
    }

    return { name: `verb "${verb}" produces valid output`, passed: true, message: 'OK' };
  } catch (err) {
    return {
      name: `verb "${verb}" produces valid output`,
      passed: false,
      message: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function validateVerbResult(verb: string, result: Record<string, unknown>): string[] {
  const errors: string[] = [];
  switch (verb) {
    case 'health':
      if (!result.status) errors.push('missing status');
      if (!result.summary) errors.push('missing summary');
      if (typeof result.confidence !== 'number') errors.push('missing or invalid confidence');
      break;
    case 'diagnose':
      if (typeof result.healthy !== 'boolean') errors.push('missing or invalid healthy');
      if (!result.summary) errors.push('missing summary');
      if (!Array.isArray(result.findings)) errors.push('missing or invalid findings');
      break;
    case 'plan':
      if (!result.name) errors.push('missing name');
      if (!result.description) errors.push('missing description');
      if (!Array.isArray(result.steps)) errors.push('missing or invalid steps');
      break;
  }
  return errors;
}
