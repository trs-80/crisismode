// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryStep } from '../types/step-types.js';
import { isKnownCapability } from './capability-registry.js';
import type { ExecutionBackend } from './backend.js';
import {
  flattenProviderResolutions,
  resolveStepProviders,
  summarizeLiveProviderReadiness,
} from './provider-registry.js';
import type { ProviderCapabilityReference } from './provider-registry.js';
import { riskExceeds, getStepRisk } from './risk.js';
import { walkSteps, collectSystemActions, collectExecutionContexts } from './step-walker.js';

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: {
    blockedCapabilities?: ProviderCapabilityReference[];
    supportedCapabilities?: ProviderCapabilityReference[];
  };
}

export interface ValidationOptions {
  requireExecutableCapabilities?: boolean;
  backend?: ExecutionBackend;
  executionMode?: 'dry-run' | 'execute';
}

type SystemActionStep = RecoveryStep & { type: 'system_action' };

// --- Individual check functions ---

function checkScenario(plan: RecoveryPlan, manifest: AgentManifest): ValidationCheck {
  const passed = manifest.spec.failureScenarios.includes(plan.metadata.scenario);
  return {
    name: 'Scenario declared in manifest',
    passed,
    message: passed
      ? `Scenario '${plan.metadata.scenario}' is declared`
      : `Scenario '${plan.metadata.scenario}' not found in manifest`,
  };
}

function checkExecutionContexts(plan: RecoveryPlan, manifest: AgentManifest): ValidationCheck {
  const manifestContexts = new Set(manifest.spec.executionContexts.map((ec) => ec.name));
  const planContexts = collectExecutionContexts(plan.steps);
  const undeclared = [...planContexts].filter((c) => !manifestContexts.has(c));
  return {
    name: 'Execution contexts declared',
    passed: undeclared.length === 0,
    message: undeclared.length === 0
      ? 'All execution contexts are declared in manifest'
      : `Undeclared contexts: ${undeclared.join(', ')}`,
  };
}

function checkRiskLevels(plan: RecoveryPlan, manifest: AgentManifest): ValidationCheck {
  const maxManifestRisk = manifest.spec.riskProfile.maxRiskLevel;
  let exceeded = false;
  walkSteps(plan.steps, (step) => {
    const risk = getStepRisk(step);
    if (risk && riskExceeds(risk, maxManifestRisk)) exceeded = true;
  });
  return {
    name: 'Risk levels within manifest maximum',
    passed: !exceeded,
    message: !exceeded
      ? `All steps within max risk level '${maxManifestRisk}'`
      : `Some steps exceed manifest max risk level '${maxManifestRisk}'`,
  };
}

function checkUniqueStepIds(plan: RecoveryPlan): ValidationCheck {
  const seen = new Set<string>();
  let hasDuplicates = false;
  walkSteps(plan.steps, (step) => {
    if (seen.has(step.stepId)) hasDuplicates = true;
    seen.add(step.stepId);
  });
  return {
    name: 'Unique step IDs',
    passed: !hasDuplicates,
    message: !hasDuplicates ? `All ${seen.size} step IDs are unique` : 'Duplicate step IDs found',
  };
}

function checkStatePreservation(plan: RecoveryPlan): ValidationCheck {
  let missing = false;
  walkSteps(plan.steps, (step) => {
    if (step.type === 'system_action' && riskExceeds(step.riskLevel, 'routine')) {
      if (!step.statePreservation?.before?.length && step.riskLevel !== 'routine') {
        missing = true;
      }
    }
  });
  return {
    name: 'State preservation for elevated+ steps',
    passed: !missing,
    message: !missing
      ? 'All elevated+ steps have required state preservation'
      : 'Some elevated+ steps missing required before captures',
  };
}

function checkHumanNotification(plan: RecoveryPlan): ValidationCheck {
  const hasElevatedPlus = plan.steps.some((s) => {
    const risk = getStepRisk(s);
    return risk && riskExceeds(risk, 'routine');
  });
  let hasNotification = false;
  walkSteps(plan.steps, (step) => {
    if (step.type === 'human_notification') hasNotification = true;
  });
  const passed = !hasElevatedPlus || hasNotification;
  return {
    name: 'Human notification for elevated+ plans',
    passed,
    message: passed
      ? 'Plan includes human notification'
      : 'Plan has elevated+ steps but no human notification',
  };
}

function checkRollbackStrategy(plan: RecoveryPlan): ValidationCheck {
  return {
    name: 'Rollback strategy declared',
    passed: !!plan.rollbackStrategy,
    message: plan.rollbackStrategy
      ? `Rollback strategy: ${plan.rollbackStrategy.type}`
      : 'Missing rollback strategy',
  };
}

function checkBlastRadiusComponents(systemActions: SystemActionStep[]): ValidationCheck {
  const missing = systemActions
    .filter((step) =>
      step.blastRadius.directComponents.length === 0
      && step.blastRadius.indirectComponents.length === 0,
    )
    .map((step) => step.stepId);
  return {
    name: 'Blast radius declares affected components',
    passed: missing.length === 0,
    message: missing.length === 0
      ? 'All system actions declare at least one affected component in blast radius'
      : `Blast radius missing affected components on steps: ${missing.join(', ')}`,
  };
}

function checkNoNestedConditionals(plan: RecoveryPlan): ValidationCheck {
  // TypeScript's NonConditionalStep type prevents nesting at compile time,
  // but we validate at runtime for plans from external sources
  const hasNested = plan.steps.some((step) => {
    if (step.type !== 'conditional') return false;
    const thenStep = step.thenStep as unknown as RecoveryStep;
    const elseStep = step.elseStep === 'skip' ? 'skip' : (step.elseStep as unknown as RecoveryStep);
    return thenStep.type === 'conditional' || (elseStep !== 'skip' && elseStep.type === 'conditional');
  });
  return {
    name: 'No nested conditionals',
    passed: !hasNested,
    message: !hasNested
      ? 'No nested conditional steps found'
      : 'Nested conditional steps detected (not permitted)',
  };
}

function checkCapabilityDeclarations(systemActions: SystemActionStep[]): ValidationCheck {
  const missing = systemActions
    .filter((step) => step.requiredCapabilities.length === 0)
    .map((step) => step.stepId);
  return {
    name: 'System actions declare required capabilities',
    passed: missing.length === 0,
    message: missing.length === 0
      ? `All ${systemActions.length} system actions declare capabilities`
      : `Missing capabilities on steps: ${missing.join(', ')}`,
  };
}

function checkManifestCapabilities(manifest: AgentManifest): ValidationCheck {
  const unknown = manifest.spec.executionContexts.flatMap((context) =>
    (context.capabilities ?? [])
      .filter((capability) => !isKnownCapability(capability))
      .map((capability) => `${context.name}:${capability}`),
  );
  return {
    name: 'Manifest capabilities are registered',
    passed: unknown.length === 0,
    message: unknown.length === 0
      ? 'All manifest execution-context capabilities exist in the registry'
      : `Unknown manifest capabilities: ${unknown.join(', ')}`,
  };
}

function checkStepCapabilities(systemActions: SystemActionStep[]): ValidationCheck {
  const unknown = systemActions.flatMap((step) =>
    step.requiredCapabilities
      .filter((capability) => !isKnownCapability(capability))
      .map((capability) => `${step.stepId}:${capability}`),
  );
  return {
    name: 'Step capabilities are registered',
    passed: unknown.length === 0,
    message: unknown.length === 0
      ? 'All step capabilities exist in the registry'
      : `Unknown step capabilities: ${unknown.join(', ')}`,
  };
}

function checkExecutableCapabilities(
  systemActions: SystemActionStep[],
  manifest: AgentManifest,
): ValidationCheck {
  const contextCapabilities = new Map(
    manifest.spec.executionContexts.map((context) => [context.name, new Set(context.capabilities ?? [])]),
  );
  const unresolved = systemActions.flatMap((step) => {
    const declared = contextCapabilities.get(step.executionContext) ?? new Set<string>();
    return step.requiredCapabilities
      .filter((capability) => !declared.has(capability))
      .map((capability) => `${step.stepId}:${capability}@${step.executionContext}`);
  });
  return {
    name: 'Required capabilities resolve for live execution',
    passed: unresolved.length === 0,
    message: unresolved.length === 0
      ? 'All required capabilities resolve to the declared execution contexts'
      : `Unresolved live capabilities: ${unresolved.join(', ')}`,
  };
}

function checkProviderResolution(
  systemActions: SystemActionStep[],
  manifest: AgentManifest,
  backend: ExecutionBackend,
): ValidationCheck {
  const resolutions = systemActions.map((step) =>
    resolveStepProviders(step, manifest, backend, 'execute'),
  );
  const flattened = flattenProviderResolutions(resolutions);
  return {
    name: 'Provider resolution for live execution',
    passed: resolutions.every((r) => r.resolved),
    message: summarizeLiveProviderReadiness(resolutions),
    details: {
      blockedCapabilities: flattened.filter((r) => !r.resolved),
      supportedCapabilities: flattened.filter((r) => r.resolved),
    },
  };
}

// --- Main validation function ---

export function validatePlan(
  plan: RecoveryPlan,
  manifest: AgentManifest,
  options: ValidationOptions = {},
): ValidationResult {
  const systemActions = collectSystemActions(plan.steps);

  const checks: ValidationCheck[] = [
    checkScenario(plan, manifest),
    checkExecutionContexts(plan, manifest),
    checkRiskLevels(plan, manifest),
    checkUniqueStepIds(plan),
    checkStatePreservation(plan),
    checkHumanNotification(plan),
    checkRollbackStrategy(plan),
    checkBlastRadiusComponents(systemActions),
    checkNoNestedConditionals(plan),
    checkCapabilityDeclarations(systemActions),
    checkManifestCapabilities(manifest),
    checkStepCapabilities(systemActions),
  ];

  if (options.requireExecutableCapabilities) {
    checks.push(checkExecutableCapabilities(systemActions, manifest));
  }

  if (options.backend && options.executionMode === 'execute') {
    checks.push(checkProviderResolution(systemActions, manifest, options.backend));
  }

  return {
    valid: checks.every((c) => c.passed),
    checks,
  };
}
