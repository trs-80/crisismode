// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Evidence-bundle interchange types — TypeScript mirror of
 * incident-generator.agent-adapter/v1
 * (https://github.com/Dbochman/sre-incident-agent-skills,
 * schemas/incident-generator-agent-adapter.schema.json).
 *
 * These types let CrisisMode accept pre-collected, framed evidence
 * bundles from external incident-generator harnesses, in addition to
 * pulling evidence itself via backends.
 */

export type EvidenceSourceKind =
  | 'fixture'
  | 'metric'
  | 'log'
  | 'event'
  | 'trace'
  | 'change'
  | 'dashboard'
  | 'operator_note';

export type EvidenceContentType =
  | 'text'
  | 'json'
  | 'markdown'
  | 'table'
  | 'metric_series'
  | 'log_excerpt';

export type EvidenceCollectionMode = 'fixture' | 'real' | 'mixed';

export type EvidenceExecutionMode = 'fixture' | 'real' | 'replay' | 'offline';

/** Action class — 0 (read-only) through 3 (state-mutating). */
export type ActionClass = 0 | 1 | 2 | 3;

export type PrimitiveMetadata = Record<string, string | number | boolean | null>;

export interface EvidenceContent {
  format: EvidenceContentType;
  body: string;
  redaction_summary?: string | null;
}

export interface EvidenceItem {
  evidence_id: string;
  adapter_id: string;
  title: string;
  source_kind: EvidenceSourceKind;
  content_type: EvidenceContentType;
  content: EvidenceContent;
  time_window?: { start?: string; end?: string } | null;
  source_ref?: string | null;
  redacted: boolean;
  untrusted: boolean;
  metadata?: PrimitiveMetadata;
}

export interface RequestVisibility {
  internal_evidence_roles_visible: false;
  expected_hypotheses_visible: false;
  forbidden_hypotheses_visible: false;
  redaction_required: true;
}

export interface ActionPolicy {
  proposed_actions_allowed: boolean;
  max_action_class: ActionClass;
  allowed_action_classes: ActionClass[];
  allowed_action_ids: string[];
  requires_human_approval_for_mutation: true;
}

export type OutputContractSection =
  | 'hypotheses_ranked'
  | 'evidence_refs'
  | 'recommended_next_steps'
  | 'proposed_actions'
  | 'abstention'
  | 'uncertainty'
  | 'unsafe_actions_avoided';

export interface OutputContract {
  response_schema: 'incident-generator.agent-adapter-response/v1';
  schema_ref?: string;
  required_sections: OutputContractSection[];
}

export interface AdapterRequest {
  schema_version: 'incident-generator.agent-adapter-request/v1';
  request_id: string;
  benchmark_set_id: string;
  case_id: string;
  created_at: string;
  incident_session_id: string;
  collection_mode: EvidenceCollectionMode;
  input_mode: 'redacted_evidence_bundle';
  skill_domains: string[];
  visibility: RequestVisibility;
  evidence_items: EvidenceItem[];
  action_policy: ActionPolicy;
  output_contract: OutputContract;
  runner_metadata?: PrimitiveMetadata;
}

export type HypothesisConfidence = 'low' | 'medium' | 'high' | 'unknown';
export type HypothesisType = 'root_cause' | 'contributing_factor' | 'unknown';

export interface Hypothesis {
  hypothesis_id: string;
  rank: number;
  summary: string;
  confidence: HypothesisConfidence;
  hypothesis_type: HypothesisType;
  evidence_refs: string[];
  missing_evidence: string[];
  competing_hypotheses: string[];
}

export type EvidenceRelevance = 'supports' | 'contradicts' | 'context' | 'missing';

export interface EvidenceReference {
  evidence_id: string;
  relevance: EvidenceRelevance;
  claim: string;
}

export type NextStepPurpose =
  | 'confirm'
  | 'disprove'
  | 'scope'
  | 'mitigate_safely'
  | 'escalate';

export interface NextStep {
  summary: string;
  purpose: NextStepPurpose;
  evidence_needed: string[];
}

export type MutationType = 'none' | 'external_side_effect' | 'state_mutation';

export interface ProposedAction {
  action_id: string;
  summary: string;
  action_class: ActionClass;
  mutation_type: MutationType;
  dry_run_only: boolean;
  requires_human_approval: boolean;
  evidence_refs: string[];
  params: PrimitiveMetadata;
}

export interface Abstention {
  abstained: boolean;
  reason: string | null;
  required_before_action: string[];
}

export interface Uncertainty {
  stated: boolean;
  summary: string | null;
  unknowns: string[];
}

export type ArtifactKind = 'agent_output' | 'runner_log' | 'adapter_trace' | 'judge_input';

export interface ArtifactRef {
  kind: ArtifactKind;
  ref: string;
  sha256: string | null;
}

export interface AgentMetadata {
  adapter_id: string;
  display_name: string;
  adapter_version: string | null;
  execution_mode: EvidenceExecutionMode;
  model: Record<string, unknown> | null;
}

export type AdapterResponseState = 'succeeded' | 'abstained' | 'blocked' | 'error';

export interface AdapterResponse {
  schema_version: 'incident-generator.agent-adapter-response/v1';
  response_id: string;
  request_id: string;
  created_at: string;
  agent: AgentMetadata;
  state: AdapterResponseState;
  primary_hypothesis_id: string | null;
  hypotheses_ranked: Hypothesis[];
  evidence_refs: EvidenceReference[];
  recommended_next_steps: NextStep[];
  proposed_actions: ProposedAction[];
  abstention: Abstention;
  uncertainty: Uncertainty;
  unsafe_actions_avoided: string[];
  duration_ms: number | null;
  artifact_refs: ArtifactRef[];
  error?: Record<string, unknown> | null;
}

export interface AdapterExchange {
  schema_version: 'incident-generator.agent-adapter/v1';
  adapter_contract_id: string;
  request: AdapterRequest;
  response: AdapterResponse;
  notes?: string;
}
