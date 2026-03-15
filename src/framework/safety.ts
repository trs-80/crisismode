// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CaptureDirective, RiskLevel } from '../types/common.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { AgentManifest } from '../types/manifest.js';
import type { AgentContext } from '../types/agent-context.js';

export interface CaptureResult {
  name: string;
  captureType: CaptureDirective['captureType'];
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  timestamp: string;
  data?: unknown;
}

export function executeCapture(capture: CaptureDirective): CaptureResult {
  // Simulate capture execution based on cost/policy
  const timestamp = new Date().toISOString();

  // Deferred captures are queued for execution after the action or after
  // system health improves — not executed inline during plan execution
  if (capture.capturePolicy === 'deferred') {
    return {
      name: capture.name,
      captureType: capture.captureType,
      status: 'skipped',
      reason: 'Deferred capture - queued for post-action or post-recovery execution',
      timestamp,
    };
  }

  if (capture.captureCost === 'expensive') {
    if (capture.capturePolicy === 'best_effort') {
      return {
        name: capture.name,
        captureType: capture.captureType,
        status: 'skipped',
        reason: 'Expensive capture skipped during active degradation (best_effort)',
        timestamp,
      };
    }
  }

  // Simulate successful capture
  return {
    name: capture.name,
    captureType: capture.captureType,
    status: 'captured',
    timestamp,
    data: simulateCaptureData(capture),
  };
}

function simulateCaptureData(capture: CaptureDirective): unknown {
  switch (capture.captureType) {
    case 'sql_query':
      return { rows: '[simulated query result]', statement: capture.statement };
    case 'file_snapshot':
      return { files: capture.targets, snapshotId: `snap-${Date.now()}` };
    case 'command_output':
      return { output: '[simulated command output]' };
    default:
      return { type: capture.captureType, captured: true };
  }
}

export function validateBlastRadius(
  step: SystemActionStep,
  manifest: AgentManifest,
  context?: AgentContext,
): { valid: boolean; message: string } {
  // Tier 1: verify the execution context exists and the target references a declared system scope.
  const executionContext = manifest.spec.executionContexts.find(
    (ec) => ec.name === step.executionContext,
  );

  if (!executionContext) {
    return {
      valid: false,
      message: `Step targets context '${step.executionContext}' not declared in manifest`,
    };
  }

  const normalizedTarget = normalizeIdentifier(step.target);
  if (!normalizedTarget) {
    return {
      valid: false,
      message: 'Step target must identify a specific system component',
    };
  }

  const knownReferences = new Set<string>([
    executionContext.target,
    ...manifest.spec.targetSystems.flatMap((system) => [system.technology, ...system.components]),
    ...step.blastRadius.directComponents,
    ...step.blastRadius.indirectComponents,
  ].map(normalizeIdentifier).filter((value): value is string => value.length > 0));

  const triggerInstance = context?.trigger.payload.instance;
  if (typeof triggerInstance === 'string') {
    knownReferences.add(normalizeIdentifier(triggerInstance));
  }

  for (const component of context?.topology.components ?? []) {
    knownReferences.add(normalizeIdentifier(component.identifier));
    knownReferences.add(normalizeIdentifier(component.role));
    knownReferences.add(normalizeIdentifier(component.technology));
  }

  const targetRepresented = [...knownReferences].some((reference) =>
    reference === normalizedTarget
    || reference.includes(normalizedTarget)
    || normalizedTarget.includes(reference),
  );
  if (!targetRepresented) {
    return {
      valid: false,
      message:
        `Step target '${step.target}' is not represented in the manifest, trigger context, topology, or declared blast radius`,
    };
  }

  // Tier 2: check blast radius declaration completeness (advisory)
  if (
    step.blastRadius.directComponents.length === 0 &&
    step.riskLevel !== 'routine'
  ) {
    return {
      valid: true,
      message:
        'Warning: no direct components declared in blast radius for non-routine action',
    };
  }

  return {
    valid: true,
    message: `Blast radius validated: ${step.blastRadius.directComponents.length} direct, ${step.blastRadius.indirectComponents.length} indirect components`,
  };
}

export function shouldRequireApproval(
  riskLevel: RiskLevel,
  trustLevel: string,
  policies: { requireApprovalForAllElevated: boolean },
  catalogCovers: boolean,
): boolean {
  if (catalogCovers) return false;

  if (riskLevel === 'high' || riskLevel === 'critical') return true;

  if (riskLevel === 'elevated') {
    if (policies.requireApprovalForAllElevated) return true;
    if (trustLevel === 'autopilot' || trustLevel === 'full_autonomy') return false;
    return true;
  }

  // routine
  if (trustLevel === 'observe') return true;
  return false;
}

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}
