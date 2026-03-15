// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryStep } from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';
import { isKnownCapability } from './capability-registry.js';
import type { ExecutionBackend } from './backend.js';
import {
  flattenProviderResolutions,
  resolveStepProviders,
  summarizeLiveProviderReadiness,
} from './provider-registry.js';
import type { ProviderCapabilityReference } from './provider-registry.js';

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

const RISK_ORDER: RiskLevel[] = ['routine', 'elevated', 'high', 'critical'];

function riskExceeds(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER.indexOf(a) > RISK_ORDER.indexOf(b);
}

function getStepRisk(step: RecoveryStep): RiskLevel | null {
  if (step.type === 'system_action') return step.riskLevel;
  if (step.type === 'conditional') {
    const thenRisk = getStepRisk(step.thenStep);
    const elseRisk = step.elseStep === 'skip' ? null : getStepRisk(step.elseStep);
    if (!thenRisk && !elseRisk) return null;
    if (!thenRisk) return elseRisk;
    if (!elseRisk) return thenRisk;
    return RISK_ORDER.indexOf(thenRisk) >= RISK_ORDER.indexOf(elseRisk) ? thenRisk : elseRisk;
  }
  return null;
}

export function validatePlan(
  plan: RecoveryPlan,
  manifest: AgentManifest,
  options: ValidationOptions = {},
): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Check 1: scenario matches manifest
  const scenarioValid = manifest.spec.failureScenarios.includes(plan.metadata.scenario);
  checks.push({
    name: 'Scenario declared in manifest',
    passed: scenarioValid,
    message: scenarioValid
      ? `Scenario '${plan.metadata.scenario}' is declared`
      : `Scenario '${plan.metadata.scenario}' not found in manifest`,
  });

  // Check 2: execution contexts
  const manifestContexts = new Set(manifest.spec.executionContexts.map((ec) => ec.name));
  const planContexts = new Set<string>();
  const collectContexts = (step: RecoveryStep) => {
    if (step.type === 'system_action' || step.type === 'diagnosis_action') {
      planContexts.add(step.executionContext);
    }
    if (step.type === 'conditional') {
      collectContexts(step.thenStep);
      if (step.elseStep !== 'skip') collectContexts(step.elseStep);
    }
  };
  plan.steps.forEach(collectContexts);
  const undeclaredContexts = [...planContexts].filter((c) => !manifestContexts.has(c));
  checks.push({
    name: 'Execution contexts declared',
    passed: undeclaredContexts.length === 0,
    message:
      undeclaredContexts.length === 0
        ? 'All execution contexts are declared in manifest'
        : `Undeclared contexts: ${undeclaredContexts.join(', ')}`,
  });

  // Check 3: risk levels within manifest max
  const maxManifestRisk = manifest.spec.riskProfile.maxRiskLevel;
  let riskExceeded = false;
  const checkRisk = (step: RecoveryStep) => {
    const risk = getStepRisk(step);
    if (risk && riskExceeds(risk, maxManifestRisk)) riskExceeded = true;
    if (step.type === 'conditional') {
      checkRisk(step.thenStep);
      if (step.elseStep !== 'skip') checkRisk(step.elseStep);
    }
  };
  plan.steps.forEach(checkRisk);
  checks.push({
    name: 'Risk levels within manifest maximum',
    passed: !riskExceeded,
    message: !riskExceeded
      ? `All steps within max risk level '${maxManifestRisk}'`
      : `Some steps exceed manifest max risk level '${maxManifestRisk}'`,
  });

  // Check 4: unique step IDs
  const stepIds = new Set<string>();
  let duplicateIds = false;
  const collectIds = (step: RecoveryStep) => {
    if (stepIds.has(step.stepId)) duplicateIds = true;
    stepIds.add(step.stepId);
    if (step.type === 'conditional') {
      collectIds(step.thenStep);
      if (step.elseStep !== 'skip') collectIds(step.elseStep);
    }
  };
  plan.steps.forEach(collectIds);
  checks.push({
    name: 'Unique step IDs',
    passed: !duplicateIds,
    message: !duplicateIds ? `All ${stepIds.size} step IDs are unique` : 'Duplicate step IDs found',
  });

  // Check 5: elevated+ steps have state preservation
  let missingPreservation = false;
  const checkPreservation = (step: RecoveryStep) => {
    if (step.type === 'system_action' && riskExceeds(step.riskLevel, 'routine')) {
      if (!step.statePreservation?.before?.length) {
        // elevated+ requires at least one before capture
        if (step.riskLevel !== 'routine') missingPreservation = true;
      }
    }
    if (step.type === 'conditional') {
      checkPreservation(step.thenStep);
      if (step.elseStep !== 'skip') checkPreservation(step.elseStep);
    }
  };
  plan.steps.forEach(checkPreservation);
  checks.push({
    name: 'State preservation for elevated+ steps',
    passed: !missingPreservation,
    message: !missingPreservation
      ? 'All elevated+ steps have required state preservation'
      : 'Some elevated+ steps missing required before captures',
  });

  // Check 6: elevated+ plans have human notification
  const hasElevatedPlus = plan.steps.some((s) => {
    const risk = getStepRisk(s);
    return risk && riskExceeds(risk, 'routine');
  });
  const hasNotification = plan.steps.some(
    (s) => s.type === 'human_notification' || (s.type === 'conditional' && (
      s.thenStep.type === 'human_notification' ||
      (s.elseStep !== 'skip' && s.elseStep.type === 'human_notification')
    )),
  );
  checks.push({
    name: 'Human notification for elevated+ plans',
    passed: !hasElevatedPlus || hasNotification,
    message:
      !hasElevatedPlus || hasNotification
        ? 'Plan includes human notification'
        : 'Plan has elevated+ steps but no human notification',
  });

  // Check 7: rollback strategy present
  checks.push({
    name: 'Rollback strategy declared',
    passed: !!plan.rollbackStrategy,
    message: plan.rollbackStrategy
      ? `Rollback strategy: ${plan.rollbackStrategy.type}`
      : 'Missing rollback strategy',
  });

  // Check 8: no nested conditionals
  // Note: TypeScript's NonConditionalStep type prevents nesting at compile time,
  // but we validate at runtime for plans from external sources
  const hasNestedConditional = (step: RecoveryStep): boolean => {
    if (step.type !== 'conditional') return false;
    const thenStep = step.thenStep as unknown as RecoveryStep;
    const elseStep = step.elseStep === 'skip' ? 'skip' : (step.elseStep as unknown as RecoveryStep);
    return thenStep.type === 'conditional' || (elseStep !== 'skip' && elseStep.type === 'conditional');
  };
  const nestedConditional = plan.steps.some(hasNestedConditional);
  checks.push({
    name: 'No nested conditionals',
    passed: !nestedConditional,
    message: !nestedConditional
      ? 'No nested conditional steps found'
      : 'Nested conditional steps detected (not permitted)',
  });

  // Check 9: system actions declare required capabilities
  const systemActionSteps = collectSystemActions(plan.steps);
  const missingCapabilityDeclarations = systemActionSteps
    .filter((step) => step.requiredCapabilities.length === 0)
    .map((step) => step.stepId);
  checks.push({
    name: 'System actions declare required capabilities',
    passed: missingCapabilityDeclarations.length === 0,
    message:
      missingCapabilityDeclarations.length === 0
        ? `All ${systemActionSteps.length} system actions declare capabilities`
        : `Missing capabilities on steps: ${missingCapabilityDeclarations.join(', ')}`,
  });

  // Check 10: manifest capabilities are registered
  const unknownManifestCapabilities = manifest.spec.executionContexts.flatMap((context) =>
    (context.capabilities ?? [])
      .filter((capability) => !isKnownCapability(capability))
      .map((capability) => `${context.name}:${capability}`),
  );
  checks.push({
    name: 'Manifest capabilities are registered',
    passed: unknownManifestCapabilities.length === 0,
    message:
      unknownManifestCapabilities.length === 0
        ? 'All manifest execution-context capabilities exist in the registry'
        : `Unknown manifest capabilities: ${unknownManifestCapabilities.join(', ')}`,
  });

  // Check 11: step capabilities are registered
  const unknownStepCapabilities = systemActionSteps.flatMap((step) =>
    step.requiredCapabilities
      .filter((capability) => !isKnownCapability(capability))
      .map((capability) => `${step.stepId}:${capability}`),
  );
  checks.push({
    name: 'Step capabilities are registered',
    passed: unknownStepCapabilities.length === 0,
    message:
      unknownStepCapabilities.length === 0
        ? 'All step capabilities exist in the registry'
        : `Unknown step capabilities: ${unknownStepCapabilities.join(', ')}`,
  });

  // Check 12: required capabilities are declared on execution contexts for live execution
  if (options.requireExecutableCapabilities) {
    const contextCapabilities = new Map(
      manifest.spec.executionContexts.map((context) => [context.name, new Set(context.capabilities ?? [])]),
    );
    const unresolvedCapabilities = systemActionSteps.flatMap((step) => {
      const declared = contextCapabilities.get(step.executionContext) ?? new Set<string>();
      return step.requiredCapabilities
        .filter((capability) => !declared.has(capability))
        .map((capability) => `${step.stepId}:${capability}@${step.executionContext}`);
    });
    checks.push({
      name: 'Required capabilities resolve for live execution',
      passed: unresolvedCapabilities.length === 0,
      message:
        unresolvedCapabilities.length === 0
          ? 'All required capabilities resolve to the declared execution contexts'
          : `Unresolved live capabilities: ${unresolvedCapabilities.join(', ')}`,
    });
  }

  // Check 13: provider resolution for live execution
  if (options.backend && options.executionMode === 'execute') {
    const backend = options.backend;
    const providerResolutions = systemActionSteps.map((step) =>
      resolveStepProviders(step, manifest, backend, 'execute'),
    );
    const flattenedResolutions = flattenProviderResolutions(providerResolutions);
    checks.push({
      name: 'Provider resolution for live execution',
      passed: providerResolutions.every((resolution) => resolution.resolved),
      message: summarizeLiveProviderReadiness(providerResolutions),
      details: {
        blockedCapabilities: flattenedResolutions.filter((resolution) => !resolution.resolved),
        supportedCapabilities: flattenedResolutions.filter((resolution) => resolution.resolved),
      },
    });
  }

  return {
    valid: checks.every((c) => c.passed),
    checks,
  };
}

function collectSystemActions(steps: RecoveryStep[]): Array<RecoveryStep & { type: 'system_action' }> {
  const actions: Array<RecoveryStep & { type: 'system_action' }> = [];
  const visit = (step: RecoveryStep) => {
    if (step.type === 'system_action') {
      actions.push(step);
      return;
    }
    if (step.type === 'conditional') {
      visit(step.thenStep as RecoveryStep);
      if (step.elseStep !== 'skip') visit(step.elseStep as RecoveryStep);
    }
  };
  steps.forEach(visit);
  return actions;
}
