// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { Annotation, StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { SpokeRegistration, SpokeDispatchResult } from './graph-state.js';
import type { ForensicLogEntry } from '../framework/graph-types.js';

/**
 * State for coordinating multiple spokes executing related recovery plans.
 *
 * Used when a cascading failure affects multiple systems and each requires
 * its own spoke to execute recovery independently but in a coordinated sequence.
 */
export const MultiSpokeState = Annotation.Root({
  /** Spokes participating in this coordinated recovery */
  spokes: Annotation<SpokeRegistration[]>({
    reducer: (_existing, update) => update,
    default: () => [],
  }),

  /** Dispatch results for each spoke — append */
  dispatches: Annotation<SpokeDispatchResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Status of each spoke's execution */
  spokeStatuses: Annotation<Record<string, 'pending' | 'running' | 'success' | 'failed'>>({
    reducer: (existing, updates) => ({ ...existing, ...updates }),
    default: () => ({}),
  }),

  /** Coordination log — append */
  coordinationLog: Annotation<ForensicLogEntry[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Overall coordination outcome */
  outcome: Annotation<'pending' | 'success' | 'partial' | 'failed'>({
    reducer: (_existing, update) => update,
    default: () => 'pending' as const,
  }),
});

type MultiSpokeStateType = typeof MultiSpokeState.State;

/**
 * Dispatch node — sends recovery plans to all participating spokes.
 */
function dispatchAllNode(state: MultiSpokeStateType) {
  const logs: ForensicLogEntry[] = [];
  const dispatches: SpokeDispatchResult[] = [];
  const spokeStatuses: Record<string, 'pending' | 'running'> = {};

  for (const spoke of state.spokes) {
    if (spoke.status !== 'active') {
      logs.push({
        timestamp: new Date().toISOString(),
        type: 'info',
        message: `Skipping inactive spoke: ${spoke.spokeId} (status: ${spoke.status})`,
      });
      continue;
    }

    dispatches.push({
      spokeId: spoke.spokeId,
      planId: `plan-${spoke.spokeId}-${Date.now()}`,
      status: 'dispatched',
      dispatchedAt: new Date().toISOString(),
    });

    spokeStatuses[spoke.spokeId] = 'running';

    logs.push({
      timestamp: new Date().toISOString(),
      type: 'info',
      message: `Dispatched recovery to spoke: ${spoke.spokeId}`,
    });
  }

  return {
    dispatches,
    spokeStatuses,
    coordinationLog: logs,
  };
}

/**
 * Monitor node — checks status of all dispatched spokes.
 * In production, this polls spoke heartbeats/status APIs.
 */
function monitorNode(state: MultiSpokeStateType) {
  const allStatuses = Object.values(state.spokeStatuses);
  const running = allStatuses.filter((s) => s === 'running').length;
  const failed = allStatuses.filter((s) => s === 'failed').length;
  const succeeded = allStatuses.filter((s) => s === 'success').length;

  let outcome: 'pending' | 'success' | 'partial' | 'failed';
  if (running > 0) {
    outcome = 'pending';
  } else if (failed > 0 && succeeded > 0) {
    outcome = 'partial';
  } else if (failed > 0) {
    outcome = 'failed';
  } else {
    outcome = 'success';
  }

  return {
    outcome,
    coordinationLog: [{
      timestamp: new Date().toISOString(),
      type: 'info' as const,
      message: `Multi-spoke status: ${succeeded} succeeded, ${failed} failed, ${running} running`,
    }],
  };
}

/**
 * Build a multi-spoke coordination graph.
 *
 * Flow: START -> dispatch_all -> monitor -> END
 */
export function buildMultiSpokeGraph(checkpointer?: BaseCheckpointSaver) {
  const builder = new StateGraph(MultiSpokeState);

  builder.addNode('dispatch_all', dispatchAllNode);
  builder.addNode('monitor', monitorNode);

  const g = builder as unknown as {
    addEdge(from: string, to: string): unknown;
    compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
  };

  g.addEdge(START, 'dispatch_all');
  g.addEdge('dispatch_all', 'monitor');
  g.addEdge('monitor', END);

  return g.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}
