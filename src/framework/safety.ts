// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CaptureDirective, RiskLevel } from '../types/common.js';
import type { RecoveryStep, SystemActionStep } from '../types/step-types.js';
import type { AgentManifest } from '../types/manifest.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from './backend.js';
import type { CaptureStore } from './capture-store.js';

export interface CaptureResult {
  name: string;
  captureType: CaptureDirective['captureType'];
  status: 'captured' | 'skipped' | 'failed';
  reason?: string;
  timestamp: string;
  data?: unknown;
  /** Capture store ID when persisted */
  captureId?: string;
}

/**
 * Options for real capture execution.
 * When backend is provided, captures execute against live systems.
 * When store is provided, captured data is persisted to disk.
 */
export interface CaptureExecutionOptions {
  /** Backend for executing real capture commands */
  backend?: ExecutionBackend;
  /** Store for persisting captured data */
  store?: CaptureStore;
  /** Plan ID for associating captures */
  planId?: string;
  /** Step ID for associating captures */
  stepId?: string;
  /** Agent ID for associating captures */
  agentId?: string;
}

/**
 * Execute a capture directive.
 *
 * When no backend is provided (or capture type doesn't support live execution),
 * falls back to simulated capture for demo/test compatibility.
 *
 * When a backend is provided, executes the capture against the real system:
 * - sql_query: Runs the SQL statement via backend.executeCommand()
 * - api_snapshot: Executes an api_call command via backend.executeCommand()
 * - command_output: Executes the command via backend.executeCommand()
 * - config_snapshot: Reads configuration via backend.executeCommand()
 * - file_snapshot / filesystem_snapshot: Reads file targets via backend
 *
 * When a CaptureStore is provided, persists the result to disk.
 */
export async function executeCaptureAsync(
  capture: CaptureDirective,
  options?: CaptureExecutionOptions,
): Promise<CaptureResult> {
  const timestamp = new Date().toISOString();

  // Deferred captures are queued, not executed inline
  if (capture.capturePolicy === 'deferred') {
    return {
      name: capture.name,
      captureType: capture.captureType,
      status: 'skipped',
      reason: 'Deferred capture - queued for post-action or post-recovery execution',
      timestamp,
    };
  }

  if (capture.captureCost === 'expensive' && capture.capturePolicy === 'best_effort') {
    return {
      name: capture.name,
      captureType: capture.captureType,
      status: 'skipped',
      reason: 'Expensive capture skipped during active degradation (best_effort)',
      timestamp,
    };
  }

  const backend = options?.backend;
  let data: unknown;

  if (backend) {
    try {
      data = await executeLiveCapture(capture, backend);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (capture.capturePolicy === 'required') {
        return {
          name: capture.name,
          captureType: capture.captureType,
          status: 'failed',
          reason: `Live capture failed: ${errMsg}`,
          timestamp,
        };
      }

      // best_effort — fall through to simulated data
      data = simulateCaptureData(capture);
    }
  } else {
    data = simulateCaptureData(capture);
  }

  const result: CaptureResult = {
    name: capture.name,
    captureType: capture.captureType,
    status: 'captured',
    timestamp,
    data,
  };

  // Persist to capture store if available
  if (options?.store && data !== undefined) {
    try {
      const metadata = await options.store.store({
        name: capture.name,
        captureType: capture.captureType,
        data,
        planId: options.planId,
        stepId: options.stepId,
        agentId: options.agentId,
        retention: capture.retention,
        rollbackCapable: isRollbackCapable(capture),
        tags: [capture.captureType],
      });
      result.captureId = metadata.id;
    } catch {
      // Storage failure is non-fatal — data is still returned in-memory
    }
  }

  return result;
}

/**
 * Synchronous capture execution for backwards compatibility.
 * Uses simulated data only — no live backend support.
 */
export function executeCapture(capture: CaptureDirective): CaptureResult {
  const timestamp = new Date().toISOString();

  if (capture.capturePolicy === 'deferred') {
    return {
      name: capture.name,
      captureType: capture.captureType,
      status: 'skipped',
      reason: 'Deferred capture - queued for post-action or post-recovery execution',
      timestamp,
    };
  }

  if (capture.captureCost === 'expensive' && capture.capturePolicy === 'best_effort') {
    return {
      name: capture.name,
      captureType: capture.captureType,
      status: 'skipped',
      reason: 'Expensive capture skipped during active degradation (best_effort)',
      timestamp,
    };
  }

  return {
    name: capture.name,
    captureType: capture.captureType,
    status: 'captured',
    timestamp,
    data: simulateCaptureData(capture),
  };
}

/**
 * Execute a capture against a live system via the ExecutionBackend.
 */
async function executeLiveCapture(
  capture: CaptureDirective,
  backend: ExecutionBackend,
): Promise<unknown> {
  switch (capture.captureType) {
    case 'sql_query': {
      if (!capture.statement) {
        throw new Error('sql_query capture requires a statement');
      }
      const rows = await backend.executeCommand({
        type: 'sql',
        statement: capture.statement,
      });
      return {
        statement: capture.statement,
        rows,
        capturedAt: new Date().toISOString(),
      };
    }

    case 'api_snapshot': {
      const result = await backend.executeCommand({
        type: 'api_call',
        operation: capture.statement ?? 'snapshot',
        parameters: capture.targets ? { targets: capture.targets } : undefined,
      });
      return {
        endpoint: capture.statement,
        response: result,
        capturedAt: new Date().toISOString(),
      };
    }

    case 'command_output': {
      const output = await backend.executeCommand({
        type: 'structured_command',
        operation: capture.statement ?? 'capture',
        parameters: capture.targets ? { targets: capture.targets } : undefined,
      });
      return {
        command: capture.statement,
        output,
        capturedAt: new Date().toISOString(),
      };
    }

    case 'file_snapshot':
    case 'filesystem_snapshot': {
      const snapshots: Record<string, unknown> = {};
      for (const target of capture.targets ?? []) {
        const content = await backend.executeCommand({
          type: 'structured_command',
          operation: 'read_file',
          parameters: { path: target },
        });
        snapshots[target] = content;
      }
      return {
        files: capture.targets,
        snapshots,
        snapshotId: `snap-${Date.now()}`,
        capturedAt: new Date().toISOString(),
      };
    }

    case 'custom': {
      const result = await backend.executeCommand({
        type: 'structured_command',
        operation: capture.statement ?? 'custom_capture',
        parameters: {
          ...(capture.targets ? { targets: capture.targets } : {}),
          format: capture.format,
        },
      });
      return {
        type: 'custom',
        result,
        capturedAt: new Date().toISOString(),
      };
    }

    default: {
      // Unknown capture type — fall back to simulation
      return simulateCaptureData(capture);
    }
  }
}

/**
 * Determine if a capture can be used to generate rollback commands.
 */
function isRollbackCapable(capture: CaptureDirective): boolean {
  return capture.captureType === 'sql_query'
    || capture.captureType === 'api_snapshot'
    || capture.captureType === 'file_snapshot'
    || capture.captureType === 'filesystem_snapshot';
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
