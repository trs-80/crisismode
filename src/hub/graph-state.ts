// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { Annotation } from '@langchain/langgraph';
import type { ForensicRecord } from '../types/forensic-record.js';

/**
 * Hub coordination lifecycle phases.
 */
export type CoordinationPhase =
  | 'alert_intake'
  | 'catalog_matching'
  | 'spoke_dispatch'
  | 'approval_routing'
  | 'execution_monitoring'
  | 'forensic_collection'
  | 'trust_update'
  | 'completed'
  | 'failed';

/**
 * An alert received by the hub from an external source (AlertManager, PagerDuty, etc.).
 */
export interface HubAlert {
  alertId: string;
  source: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  severity: string;
}

/**
 * A spoke registration known to the hub.
 */
export interface SpokeRegistration {
  spokeId: string;
  environmentId: string;
  capabilities: string[];
  lastHeartbeat: string;
  status: 'active' | 'degraded' | 'offline';
}

/**
 * The result of dispatching work to a spoke.
 */
export interface SpokeDispatchResult {
  spokeId: string;
  planId: string;
  status: 'dispatched' | 'rejected' | 'timeout';
  dispatchedAt: string;
}

/**
 * Approval decision routed through the hub.
 */
export interface ApprovalRoutingResult {
  stepId: string;
  decision: 'approved' | 'rejected' | 'skipped' | 'timeout';
  decidedBy: string;
  decidedAt: string;
  channel: string;
}

/**
 * Trust score update after a recovery execution.
 */
export interface TrustScoreUpdate {
  agentName: string;
  scenario: string;
  previousScore: number;
  newScore: number;
  factors: string[];
  updatedAt: string;
}

/**
 * Hub-level state for the coordination graph.
 *
 * Models the full lifecycle: alert intake -> catalog matching -> spoke dispatch ->
 * approval routing -> forensic collection -> trust score update.
 */
export const HubCoordinationState = Annotation.Root({
  /** Current phase of the coordination lifecycle */
  phase: Annotation<CoordinationPhase>({
    reducer: (_existing, update) => update,
    default: () => 'alert_intake' as const,
  }),

  /** The alert that triggered this coordination */
  alert: Annotation<HubAlert | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),

  /** Matched catalog entry (agent + scenario) */
  catalogMatch: Annotation<{
    agentName: string;
    scenario: string;
    confidence: number;
  } | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),

  /** Available spokes for dispatch */
  availableSpokes: Annotation<SpokeRegistration[]>({
    reducer: (_existing, update) => update,
    default: () => [],
  }),

  /** Dispatch results — append for multi-spoke */
  dispatchResults: Annotation<SpokeDispatchResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Approval routing results — append */
  approvalResults: Annotation<ApprovalRoutingResult[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Forensic records collected from spokes — append */
  forensicRecords: Annotation<ForensicRecord[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Trust score updates — append */
  trustUpdates: Annotation<TrustScoreUpdate[]>({
    reducer: (existing, updates) => [...existing, ...updates],
    default: () => [],
  }),

  /** Error message if coordination fails */
  error: Annotation<string | null>({
    reducer: (_existing, update) => update,
    default: () => null,
  }),
});

export type HubCoordinationStateType = typeof HubCoordinationState.State;
