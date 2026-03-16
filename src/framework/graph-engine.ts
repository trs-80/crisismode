// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { StateGraph, END, START, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { RecoveryGraphState } from './graph-state.js';
import type { RecoveryGraphStateType } from './graph-state.js';
import { createNodeForStep } from './graph-nodes.js';
import type { GraphNodeContext, ExecutionMode } from './graph-nodes.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { StepResult } from '../types/execution-state.js';
import type { AgentContext } from '../types/agent-context.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RiskLevel } from '../types/common.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from './backend.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { EngineCallbacks } from './engine.js';
import { ForensicRecorder } from './forensics.js';
import { Command } from '@langchain/langgraph';

export interface GraphEngineOptions {
  checkpointer?: BaseCheckpointSaver;
  approvalHandler?: ApprovalHandler;
  callbacks?: EngineCallbacks;
  threadId?: string;
}

/**
 * RecoveryGraphEngine wraps recovery plan execution in a LangGraph StateGraph.
 *
 * Each step in the plan becomes a graph node. The graph executes sequentially
 * (step_0 -> step_1 -> ... -> step_N -> END), with conditional routing to
 * skip remaining steps when a failure or abort occurs.
 *
 * Gains over the legacy engine:
 * - Durable checkpointing (MemorySaver for dev, PostgresSaver for hub)
 * - Interrupt/resume for human-in-the-loop approval
 * - Inter-step state passing via stepOutputs channel
 * - Crash recovery: resume from last checkpoint
 */
export class RecoveryGraphEngine {
  private recorder: ForensicRecorder;
  private coveredRiskLevels: RiskLevel[] = [];
  private callbacks: EngineCallbacks;
  private backend: ExecutionBackend;
  private mode: ExecutionMode;
  private checkpointer: BaseCheckpointSaver;
  private approvalHandler?: ApprovalHandler;
  private threadId: string;

  constructor(
    private context: AgentContext,
    private manifest: AgentManifest,
    private agent: RecoveryAgent,
    recorder: ForensicRecorder,
    backend: ExecutionBackend,
    mode: ExecutionMode = 'dry-run',
    options: GraphEngineOptions = {},
  ) {
    this.recorder = recorder;
    this.callbacks = options.callbacks ?? {};
    this.backend = backend;
    this.mode = mode;
    this.checkpointer = options.checkpointer ?? new MemorySaver();
    this.approvalHandler = options.approvalHandler;
    this.threadId = options.threadId ?? `recovery-${Date.now()}`;
  }

  setCoveredRiskLevels(levels: RiskLevel[]): void {
    this.coveredRiskLevels = levels;
  }

  /**
   * Build a LangGraph StateGraph from a RecoveryPlan.
   *
   * Each step becomes a node named `step_{index}`.
   * Edges route sequentially, with conditional checks to short-circuit
   * on failure or abort.
   */
  private buildGraph(plan: RecoveryPlan) {
    const nodeCtx: GraphNodeContext = {
      backend: this.backend,
      manifest: this.manifest,
      agentContext: this.context,
      agent: this.agent,
      mode: this.mode,
      coveredRiskLevels: this.coveredRiskLevels,
      approvalHandler: this.approvalHandler,
    };

    const builder = new StateGraph(RecoveryGraphState);
    const stepCount = plan.steps.length;

    for (let i = 0; i < stepCount; i++) {
      const step = plan.steps[i];
      const nodeName = `step_${i}`;
      const nodeCallbacks = this.callbacks;

      const nodeFactory = createNodeForStep(step, nodeCtx);

      // Wrap the node factory to fire callbacks
      const wrappedNode = async (state: RecoveryGraphStateType) => {
        nodeCallbacks.onStepStart?.(step, i);
        const result = await nodeFactory(state);
        const stepResults = (result as { completedSteps?: StepResult[] }).completedSteps ?? [];
        for (const sr of stepResults) {
          nodeCallbacks.onStepComplete?.(step, sr);
          this.recorder.addStepResult(sr);
        }
        return result;
      };

      builder.addNode(nodeName, wrappedNode);
    }

    // Wire edges: START -> step_0, step_i -> step_{i+1} (conditional), step_N -> END
    // We use type assertions because node names are dynamic strings.
    const g = builder as unknown as {
      addEdge(from: string, to: string): unknown;
      addConditionalEdges(from: string, fn: (state: RecoveryGraphStateType) => string): unknown;
      compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
    };

    if (stepCount > 0) {
      g.addEdge(START, 'step_0');

      for (let i = 0; i < stepCount - 1; i++) {
        const currentNode = `step_${i}`;
        const nextNode = `step_${i + 1}`;

        // Conditional edge: if the current step failed or was abort-skipped, go to END
        g.addConditionalEdges(currentNode, (state: RecoveryGraphStateType) => {
          const lastResult = state.completedSteps[state.completedSteps.length - 1];
          if (!lastResult) return nextNode;

          if (lastResult.status === 'failed') return END;
          if (lastResult.status === 'skipped' && lastResult.step.type === 'human_approval') return END;

          return nextNode;
        });
      }

      // Last step always goes to END
      g.addEdge(`step_${stepCount - 1}`, END);
    } else {
      builder.addNode('noop', () => ({}));
      g.addEdge(START, 'noop');
      g.addEdge('noop', END);
    }

    return builder.compile({ checkpointer: this.checkpointer });
  }

  /**
   * Execute a recovery plan through the graph engine.
   *
   * Returns the same StepResult[] array as the legacy engine for compatibility.
   */
  async executePlan(plan: RecoveryPlan, diagnosis: DiagnosisResult): Promise<StepResult[]> {
    const graph = this.buildGraph(plan);
    const config = { configurable: { thread_id: this.threadId } };

    const initialState = {
      plan,
      diagnosis,
    };

    let finalState: RecoveryGraphStateType | undefined;

    for await (const event of await graph.stream(initialState, {
      ...config,
      streamMode: 'values',
    })) {
      const candidate = event as RecoveryGraphStateType;
      // Interrupt events may emit partial state without completedSteps.
      // Keep the last state that has the completedSteps array.
      if (candidate.completedSteps !== undefined) {
        finalState = candidate;
      }
    }

    return finalState?.completedSteps ?? [];
  }

  /**
   * Resume a previously interrupted graph execution (e.g., after approval).
   */
  async resume(decision: string): Promise<StepResult[]> {
    const plan = await this.getInterruptedPlan();
    if (!plan) {
      throw new Error('No interrupted graph to resume');
    }

    const graph = this.buildGraph(plan);
    const config = { configurable: { thread_id: this.threadId } };

    let finalState: RecoveryGraphStateType | undefined;

    for await (const event of await graph.stream(
      new Command({ resume: decision }),
      { ...config, streamMode: 'values' },
    )) {
      const candidate = event as RecoveryGraphStateType;
      if (candidate.completedSteps !== undefined) {
        finalState = candidate;
      }
    }

    return finalState?.completedSteps ?? [];
  }

  /**
   * Get the current state of the graph (useful for inspecting interrupted state).
   */
  async getState(): Promise<RecoveryGraphStateType | undefined> {
    // Build a minimal graph to access state — the checkpointer holds the state
    // so we need a compiled graph to query it
    const builder = new StateGraph(RecoveryGraphState);
    builder.addNode('noop', () => ({}));
    const g = builder as unknown as {
      addEdge(from: string, to: string): unknown;
      compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
    };
    g.addEdge(START, 'noop');
    g.addEdge('noop', END);
    const graph = g.compile({ checkpointer: this.checkpointer });

    const config = { configurable: { thread_id: this.threadId } };
    const snapshot = await graph.getState(config);
    return snapshot?.values as RecoveryGraphStateType | undefined;
  }

  private async getInterruptedPlan(): Promise<RecoveryPlan | undefined> {
    const state = await this.getState();
    return state?.plan;
  }
}
