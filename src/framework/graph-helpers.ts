// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { BaseCheckpointSaver } from '@langchain/langgraph';

/**
 * Type-safe operations for dynamically-wired LangGraph StateGraphs.
 *
 * LangGraph's TypeScript types require node names as string literals,
 * but recovery graphs wire nodes dynamically (step_0, step_1, rollback_0, etc.).
 * This interface provides a typed escape hatch used across all graph builders.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DynamicGraphOps {
  addEdge(from: string, to: string): any;
  addConditionalEdges(from: string, fn: (state: any) => string): any;
  compile(opts: { checkpointer: BaseCheckpointSaver }): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Cast a StateGraph builder to DynamicGraphOps for dynamic node wiring.
 *
 * This is the single location for the type assertion that bridges LangGraph's
 * static string-literal node name requirement with our dynamic step_N naming.
 */
export function dynamicOps(builder: unknown): DynamicGraphOps {
  return builder as DynamicGraphOps;
}

/**
 * Create an ISO timestamp string.
 * Shared across graph nodes and rollback to avoid duplication.
 */
export function makeTimestamp(): string {
  return new Date().toISOString();
}
