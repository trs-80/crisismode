// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ValidationResult } from './validator.js';
import { getCapability } from './capability-registry.js';
import type { StepResult } from '../types/execution-state.js';
import type {
  AutomationStatus,
  ExecuteReadiness,
  HealthAssessment,
  OperatorActionRequired,
  OperatorSummary,
} from '../types/health.js';

export interface BuildOperatorSummaryOptions {
  health: HealthAssessment;
  mode: 'dry-run' | 'execute';
  currentValidation?: ValidationResult;
  executeValidation?: ValidationResult;
  results?: StepResult[];
  healthCheckOnly?: boolean;
}

export function buildOperatorSummary(options: BuildOperatorSummaryOptions): OperatorSummary {
  const validationBlockers = collectValidationBlockers(
    options.mode === 'execute' ? options.currentValidation : options.executeValidation,
  );
  const providerResolutionDetails = getProviderResolutionDetails(
    options.mode === 'execute' ? options.currentValidation : options.executeValidation,
  );
  const executeReadiness = determineExecuteReadiness(options);
  const mutationsPerformed = options.mode === 'execute'
    && (options.results?.some(
      (result) => result.step.type === 'system_action' && result.status === 'success',
    ) ?? false);
  const failedSteps = options.results?.some((result) => result.status === 'failed') ?? false;
  const automationStatus = determineAutomationStatus(
    options.health,
    mutationsPerformed,
    failedSteps,
  );
  const actionRequired = determineActionRequired(
    options,
    executeReadiness,
    automationStatus,
    validationBlockers,
  );
  const recommendedNextStep = determineNextStep(
    options,
    actionRequired,
    executeReadiness,
    validationBlockers,
    providerResolutionDetails,
  );
  const recommendedActions = determineRecommendedActions(
    options,
    actionRequired,
    providerResolutionDetails,
  );

  return {
    currentState: options.health.status,
    confidence: options.health.confidence,
    summary: `${options.health.summary} ${summarizeRunOutcome(automationStatus, mutationsPerformed)}`.trim(),
    actionRequired,
    automationStatus,
    executeReadiness,
    mutationsPerformed,
    recommendedNextStep,
    recommendedActions,
    evidence: options.health.signals,
    validationBlockers,
    observedAt: options.health.observedAt,
  };
}

function collectValidationBlockers(validation?: ValidationResult): string[] {
  if (!validation) {
    return [];
  }

  return validation.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.message}`);
}

function determineExecuteReadiness(options: BuildOperatorSummaryOptions): ExecuteReadiness {
  if (options.healthCheckOnly || !options.executeValidation) {
    return 'not_applicable';
  }

  return options.executeValidation.valid ? 'ready' : 'blocked';
}

function determineAutomationStatus(
  health: HealthAssessment,
  mutationsPerformed: boolean,
  failedSteps: boolean,
): AutomationStatus {
  if (!mutationsPerformed) {
    return 'no_mutations_performed';
  }

  if (!failedSteps && health.status === 'healthy') {
    return 'recovery_completed';
  }

  return 'partial_mutations_performed';
}

function determineActionRequired(
  options: BuildOperatorSummaryOptions,
  executeReadiness: ExecuteReadiness,
  automationStatus: AutomationStatus,
  validationBlockers: string[],
): OperatorActionRequired {
  if (options.health.status === 'healthy') {
    return 'none';
  }

  if (options.health.status === 'recovering') {
    return 'monitor';
  }

  if (options.healthCheckOnly || options.health.status === 'unknown') {
    return 'investigate';
  }

  if (executeReadiness === 'blocked') {
    return 'use_different_tool';
  }

  if (options.mode === 'dry-run' && automationStatus === 'no_mutations_performed') {
    return 'retry_with_execute';
  }

  if (validationBlockers.length > 0) {
    return 'manual_intervention_required';
  }

  return 'manual_intervention_required';
}

function determineNextStep(
  options: BuildOperatorSummaryOptions,
  actionRequired: OperatorActionRequired,
  executeReadiness: ExecuteReadiness,
  validationBlockers: string[],
  providerResolutionDetails: ProviderResolutionDetails | null,
): string {
  if (actionRequired === 'none') {
    return options.health.recommendedActions[0]
      ?? 'No action required. Continue monitoring the latest direct health signals.';
  }

  if (actionRequired === 'monitor') {
    return options.health.recommendedActions[0]
      ?? 'Continue monitoring until direct health signals return to healthy thresholds.';
  }

  if (actionRequired === 'investigate') {
    return options.healthCheckOnly
      ? 'Run `pnpm run live` to generate a recovery plan based on direct health signals.'
      : options.health.recommendedActions[0]
        ?? 'Investigate the latest direct health signals before attempting recovery.';
  }

  if (actionRequired === 'retry_with_execute') {
    return executeReadiness === 'ready'
      ? 'Review the dry-run output and rerun with `pnpm run live -- --execute` when you are ready to apply mutations.'
      : 'The system is unhealthy, but execute mode is not currently ready. Resolve the blocking validation issues first.';
  }

  if (actionRequired === 'use_different_tool') {
    if (providerResolutionDetails?.blockedCapabilities.length) {
      const blockedList = providerResolutionDetails.blockedCapabilities
        .map((capability) => capability.capability)
        .join(', ');
      return `Do not partially execute this plan. Use the manual recovery workflow for ${blockedList}, or add live providers for those capabilities before retrying execute mode.`;
    }

    const blocker = formatPrimaryBlocker(validationBlockers[0]);
    return `Automation is blocked. Use the manual runbook or add the missing capability providers. ${blocker}`;
  }

  return options.health.recommendedActions[0]
    ?? 'Manual intervention is required. Reassess the system directly before attempting another automated run.';
}

function formatPrimaryBlocker(blocker?: string): string {
  if (!blocker) {
    return 'Execute readiness is currently blocked.';
  }

  return blocker
    .replace(/^Provider resolution for live execution:\s*/, '')
    .replace(/^Required capabilities resolve for live execution:\s*/, '');
}

function summarizeRunOutcome(
  automationStatus: AutomationStatus,
  mutationsPerformed: boolean,
): string {
  if (!mutationsPerformed) {
    return 'No system mutations were performed in this run.';
  }

  if (automationStatus === 'recovery_completed') {
    return 'Automation completed and the latest health probe indicates the system is healthy.';
  }

  return 'Automation performed some mutations, but the latest health probe still indicates more attention is required.';
}

interface ProviderResolutionDetails {
  blockedCapabilities: Array<{ stepId: string; capability: string; reason?: string }>;
  supportedCapabilities: Array<{ stepId: string; capability: string; providerId?: string }>;
}

function getProviderResolutionDetails(validation?: ValidationResult): ProviderResolutionDetails | null {
  const providerCheck = validation?.checks.find(
    (check) => check.name === 'Provider resolution for live execution',
  );
  if (!providerCheck?.details) {
    return null;
  }

  return {
    blockedCapabilities: providerCheck.details.blockedCapabilities ?? [],
    supportedCapabilities: providerCheck.details.supportedCapabilities ?? [],
  };
}

function determineRecommendedActions(
  options: BuildOperatorSummaryOptions,
  actionRequired: OperatorActionRequired,
  providerResolutionDetails: ProviderResolutionDetails | null,
): string[] {
  if (actionRequired !== 'use_different_tool' || !providerResolutionDetails?.blockedCapabilities.length) {
    return options.health.recommendedActions;
  }

  const actions: string[] = [];
  if (providerResolutionDetails.supportedCapabilities.length > 0) {
    actions.push(
      'Do not partially run only the supported steps in execute mode; this recovery path requires the blocked capabilities too.',
    );
  }

  const uniqueBlockedCapabilities = [...new Set(
    providerResolutionDetails.blockedCapabilities.map((capability) => capability.capability),
  )];
  for (const capabilityId of uniqueBlockedCapabilities) {
    const capability = getCapability(capabilityId);
    const blockingSteps = providerResolutionDetails.blockedCapabilities
      .filter((blocked) => blocked.capability === capabilityId)
      .map((blocked) => blocked.stepId)
      .join(', ');
    actions.push(
      `${capability?.manualFallback ?? `Perform ${capabilityId} manually with your approved operational workflow.`} (${capabilityId}; blocked at ${blockingSteps})`,
    );
  }

  actions.push('Retry `pnpm run live -- --execute` only after those live providers exist or the manual recovery is complete.');
  return actions;
}
