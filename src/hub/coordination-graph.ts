// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { HubCoordinationState } from './graph-state.js';
import type { HubCoordinationStateType, HubAlert } from './graph-state.js';

/**
 * Configuration for the hub coordination graph.
 */
export interface HubGraphConfig {
  checkpointer: BaseCheckpointSaver;
  catalogEndpoint?: string;
  slackWebhookUrl?: string;
}

/**
 * Alert intake node — validates and normalizes the incoming alert.
 */
function alertIntakeNode(state: HubCoordinationStateType) {
  if (!state.alert) {
    return {
      phase: 'failed' as const,
      error: 'No alert provided to coordination graph',
    };
  }

  return {
    phase: 'catalog_matching' as const,
  };
}

/**
 * Catalog matching node — finds the appropriate agent and scenario.
 *
 * In a production hub, this queries the catalog database. Here we provide
 * a simple mapping based on alert payload fields.
 */
function catalogMatchingNode(state: HubCoordinationStateType) {
  const alert = state.alert!;
  const alertName = alert.payload['alertname'] as string | undefined;

  // Simple pattern matching against known alert names
  const matchers: Array<{ pattern: RegExp; agent: string; scenario: string }> = [
    { pattern: /postgres.*replication/i, agent: 'pg-replication', scenario: 'replication_lag_cascade' },
    { pattern: /redis.*memory/i, agent: 'redis-memory', scenario: 'memory_pressure_critical' },
    { pattern: /etcd.*consensus/i, agent: 'etcd-consensus', scenario: 'consensus_loss' },
    { pattern: /kafka.*broker/i, agent: 'kafka-broker', scenario: 'broker_failure' },
    { pattern: /kubernetes.*node/i, agent: 'k8s-cluster', scenario: 'node_not_ready' },
    { pattern: /ceph.*storage/i, agent: 'ceph-storage', scenario: 'degraded_storage' },
    { pattern: /flink.*checkpoint/i, agent: 'flink-streaming', scenario: 'checkpoint_failure' },
  ];

  const match = alertName
    ? matchers.find((m) => m.pattern.test(alertName))
    : undefined;

  if (!match) {
    return {
      phase: 'failed' as const,
      error: `No catalog match for alert: ${alertName ?? 'unknown'}`,
      catalogMatch: null,
    };
  }

  return {
    phase: 'spoke_dispatch' as const,
    catalogMatch: {
      agentName: match.agent,
      scenario: match.scenario,
      confidence: 0.95,
    },
  };
}

/**
 * Spoke dispatch node — selects and dispatches to the best available spoke.
 */
function spokeDispatchNode(state: HubCoordinationStateType) {
  const match = state.catalogMatch;
  if (!match) {
    return { phase: 'failed' as const, error: 'No catalog match for dispatch' };
  }

  const activeSpokes = state.availableSpokes.filter((s) => s.status === 'active');
  if (activeSpokes.length === 0) {
    return {
      phase: 'failed' as const,
      error: 'No active spokes available for dispatch',
    };
  }

  // Select the spoke with matching capabilities (or first active)
  const targetSpoke = activeSpokes.find((s) =>
    s.capabilities.includes(match.agentName),
  ) ?? activeSpokes[0];

  return {
    phase: 'approval_routing' as const,
    dispatchResults: [{
      spokeId: targetSpoke.spokeId,
      planId: `plan-${Date.now()}`,
      status: 'dispatched' as const,
      dispatchedAt: new Date().toISOString(),
    }],
  };
}

/**
 * Approval routing node — uses interrupt to pause for human decision.
 *
 * In production, this sends a Slack interactive message and waits for the
 * callback to fire `Command({ resume: decision })`.
 */
function approvalRoutingNode(state: HubCoordinationStateType) {
  const dispatch = state.dispatchResults[state.dispatchResults.length - 1];
  if (!dispatch) {
    return { phase: 'failed' as const, error: 'No dispatch result for approval' };
  }

  // Interrupt for human approval via Slack/PagerDuty
  const decision = interrupt({
    type: 'hub_approval',
    spokeId: dispatch.spokeId,
    planId: dispatch.planId,
    alert: state.alert,
    catalogMatch: state.catalogMatch,
  });

  const approvalDecision = decision as string;

  return {
    phase: approvalDecision === 'approved'
      ? 'execution_monitoring' as const
      : 'failed' as const,
    approvalResults: [{
      stepId: dispatch.planId,
      decision: approvalDecision as 'approved' | 'rejected',
      decidedBy: 'hub-operator',
      decidedAt: new Date().toISOString(),
      channel: 'slack',
    }],
    ...(approvalDecision !== 'approved' ? { error: `Approval ${approvalDecision}` } : {}),
  };
}

/**
 * Execution monitoring node — tracks spoke execution progress.
 * In production, this polls spoke heartbeats and status.
 */
function executionMonitoringNode(state: HubCoordinationStateType) {
  return {
    phase: 'forensic_collection' as const,
  };
}

/**
 * Forensic collection node — aggregates forensic records from spokes.
 */
function forensicCollectionNode(state: HubCoordinationStateType) {
  return {
    phase: 'trust_update' as const,
  };
}

/**
 * Trust update node — adjusts agent trust scores based on execution outcome.
 */
function trustUpdateNode(state: HubCoordinationStateType) {
  const match = state.catalogMatch;
  if (!match) {
    return { phase: 'completed' as const };
  }

  const forensicRecords = state.forensicRecords;
  const successCount = forensicRecords.filter((r) => r.summary.outcome === 'success').length;
  const totalCount = forensicRecords.length;
  const successRate = totalCount > 0 ? successCount / totalCount : 1.0;

  return {
    phase: 'completed' as const,
    trustUpdates: [{
      agentName: match.agentName,
      scenario: match.scenario,
      previousScore: 0.5,
      newScore: Math.min(1.0, 0.5 + successRate * 0.3),
      factors: [`${successCount}/${totalCount} successful executions`],
      updatedAt: new Date().toISOString(),
    }],
  };
}

/**
 * Build the hub coordination graph.
 *
 * Lifecycle: alert_intake -> catalog_matching -> spoke_dispatch ->
 * approval_routing (interrupt) -> execution_monitoring ->
 * forensic_collection -> trust_update -> END
 */
export function buildCoordinationGraph(config: HubGraphConfig) {
  const builder = new StateGraph(HubCoordinationState);

  builder.addNode('alert_intake', alertIntakeNode);
  builder.addNode('catalog_matching', catalogMatchingNode);
  builder.addNode('spoke_dispatch', spokeDispatchNode);
  builder.addNode('approval_routing', approvalRoutingNode);
  builder.addNode('execution_monitoring', executionMonitoringNode);
  builder.addNode('forensic_collection', forensicCollectionNode);
  builder.addNode('trust_update', trustUpdateNode);

  // Use type assertion for dynamic node name edges
  const g = builder as unknown as {
    addEdge(from: string, to: string): unknown;
    addConditionalEdges(from: string, fn: (state: HubCoordinationStateType) => string): unknown;
    compile(opts: { checkpointer: BaseCheckpointSaver }): ReturnType<typeof builder.compile>;
  };

  g.addEdge(START, 'alert_intake');

  // Route based on phase — failed phases go to END
  g.addConditionalEdges('alert_intake', (state) =>
    state.phase === 'failed' ? END : 'catalog_matching');

  g.addConditionalEdges('catalog_matching', (state) =>
    state.phase === 'failed' ? END : 'spoke_dispatch');

  g.addConditionalEdges('spoke_dispatch', (state) =>
    state.phase === 'failed' ? END : 'approval_routing');

  g.addConditionalEdges('approval_routing', (state) =>
    state.phase === 'failed' ? END : 'execution_monitoring');

  g.addEdge('execution_monitoring', 'forensic_collection');
  g.addEdge('forensic_collection', 'trust_update');
  g.addEdge('trust_update', END);

  return g.compile({ checkpointer: config.checkpointer });
}
