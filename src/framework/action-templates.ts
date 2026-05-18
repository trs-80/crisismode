// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Built-in action templates — read-only and low-risk actions
 * matching the SRE-skills (incident-generator) action vocabulary.
 *
 * Phase 0 scope: class 0 (read) and class 1 (low-risk read with
 * side effects). Class 2/3 mutating templates land in Phase 3.
 */

import type { ActionTemplate } from '../types/action-template.js';

export const BUILT_IN_TEMPLATES: ActionTemplate[] = [
  {
    action_id: 'inspect_service_logs',
    display_name: 'Inspect service logs',
    description: 'Read recent log lines from a target service to identify error signatures.',
    skill_domain: 'service',
    action_class: 0,
    mutation_type: 'none',
    step_type: 'diagnosis_action',
    target_kinds: ['linux', 'kubernetes', 'service'],
    required_capabilities: ['logs.read'],
    execution_context: 'service_read',
    default_timeout: 'PT30S',
  },
  {
    action_id: 'inspect_database_pool',
    display_name: 'Inspect database connection pool',
    description: 'Read pool saturation and active connection counts from a database target.',
    skill_domain: 'database',
    action_class: 0,
    mutation_type: 'none',
    step_type: 'diagnosis_action',
    target_kinds: ['postgresql', 'mysql'],
    required_capabilities: ['db.query.read'],
    execution_context: 'database_read',
    default_timeout: 'PT30S',
  },
  {
    action_id: 'inspect_kafka_lag',
    display_name: 'Inspect Kafka consumer lag',
    description: 'Read consumer group lag and broker health from a Kafka target.',
    skill_domain: 'service',
    action_class: 0,
    mutation_type: 'none',
    step_type: 'diagnosis_action',
    target_kinds: ['kafka'],
    required_capabilities: ['kafka.metrics.read'],
    execution_context: 'kafka_read',
    default_timeout: 'PT30S',
  },
  {
    action_id: 'inspect_k8s_pods',
    display_name: 'Inspect Kubernetes pod state',
    description: 'List pods and their phase, restarts, and recent events.',
    skill_domain: 'kubernetes',
    action_class: 0,
    mutation_type: 'none',
    step_type: 'diagnosis_action',
    target_kinds: ['kubernetes'],
    required_capabilities: ['k8s.resource.read'],
    execution_context: 'kubernetes_read',
    default_timeout: 'PT30S',
  },
  {
    action_id: 'inspect_dns_resolution',
    display_name: 'Inspect DNS resolution',
    description: 'Resolve target hostnames and read resolver health.',
    skill_domain: 'network',
    action_class: 0,
    mutation_type: 'none',
    step_type: 'diagnosis_action',
    target_kinds: ['linux', 'kubernetes', 'dns'],
    required_capabilities: ['dns.resolution.read'],
    execution_context: 'network_read',
    default_timeout: 'PT15S',
  },
  {
    action_id: 'capture_state_snapshot',
    display_name: 'Capture state snapshot',
    description:
      'Capture a point-in-time state snapshot for downstream comparison or forensic retention.',
    skill_domain: 'service',
    action_class: 1,
    mutation_type: 'external_side_effect',
    step_type: 'system_action',
    target_kinds: ['linux', 'kubernetes', 'postgresql', 'redis'],
    required_capabilities: ['state.snapshot.capture'],
    execution_context: 'state_capture',
    default_timeout: 'PT60S',
    risk_level: 'routine',
    blast_radius: {
      directComponents: ['snapshot_store'],
      indirectComponents: [],
      maxImpact: 'Writes a snapshot artifact; no impact on target system.',
      cascadeRisk: 'none',
    },
    needs_state_preservation: false,
    needs_human_approval: false,
  },
  {
    action_id: 'tail_audit_log',
    display_name: 'Tail audit log',
    description: 'Open a streaming view of the target audit log for the operator.',
    skill_domain: 'linux',
    action_class: 1,
    mutation_type: 'external_side_effect',
    step_type: 'system_action',
    target_kinds: ['linux', 'kubernetes'],
    required_capabilities: ['logs.read'],
    execution_context: 'audit_read',
    default_timeout: 'PT60S',
    risk_level: 'routine',
    blast_radius: {
      directComponents: ['audit_log_reader'],
      indirectComponents: [],
      maxImpact: 'Opens a log stream; read-only on the target.',
      cascadeRisk: 'none',
    },
    needs_state_preservation: false,
    needs_human_approval: false,
  },
  // ── Class 2 / 3 mutating templates (Phase 3) ──
  {
    action_id: 'disconnect_replica',
    display_name: 'Disconnect lagging database replica',
    description:
      'Terminate the replication connection for a lagging replica so the primary is not blocked by a slow consumer.',
    skill_domain: 'database',
    action_class: 2,
    mutation_type: 'state_mutation',
    step_type: 'system_action',
    target_kinds: ['postgresql', 'mysql'],
    required_capabilities: ['db.replica.disconnect'],
    execution_context: 'database_write',
    default_timeout: 'PT60S',
    risk_level: 'elevated',
    blast_radius: {
      directComponents: ['replica'],
      indirectComponents: ['read_traffic'],
      maxImpact:
        'Replica goes offline for replication; downstream read traffic must be redirected.',
      cascadeRisk: 'low',
    },
    state_captures_before: [
      {
        name: 'replication_status_before',
        captureType: 'sql_query',
        statement: 'SELECT * FROM pg_stat_replication;',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    state_captures_after: [
      {
        name: 'replication_status_after',
        captureType: 'sql_query',
        statement: 'SELECT * FROM pg_stat_replication;',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    success_check: {
      description: 'WAL sender for the disconnected replica is no longer present',
      check: {
        type: 'sql_count',
        statement: 'SELECT count(*) FROM pg_stat_replication WHERE client_addr = $1;',
        expect: { operator: 'eq', value: 0 },
      },
    },
    rollback: {
      type: 'manual',
      description: 'Re-establish replication from the primary using your standard replica rebuild workflow.',
      estimatedDuration: 'PT30M',
    },
  },
  {
    action_id: 'rollback_deploy',
    display_name: 'Roll back deployment to last known good',
    description:
      'Revert the target deployment to the previous known-good release after a regression is detected.',
    skill_domain: 'service',
    action_class: 3,
    mutation_type: 'state_mutation',
    step_type: 'system_action',
    target_kinds: ['kubernetes', 'service'],
    required_capabilities: ['deploy.rollback'],
    execution_context: 'deploy_write',
    default_timeout: 'PT5M',
    risk_level: 'high',
    blast_radius: {
      directComponents: ['deployment'],
      indirectComponents: ['traffic', 'downstream_services'],
      maxImpact: 'Service version reverts; in-flight requests may fail during the swap.',
      cascadeRisk: 'medium',
    },
    state_captures_before: [
      {
        name: 'deployment_state_before',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
      {
        name: 'deploy_history',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    state_captures_after: [
      {
        name: 'deployment_state_after',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    success_check: {
      description: 'Active revision matches the targeted previous-good revision',
      check: {
        type: 'api_field',
        operation: 'get_active_revision',
        expect: { operator: 'eq', value: '$previous_revision' },
      },
    },
    rollback: {
      type: 'manual',
      description: 'Reverting a rollback requires a forward deploy of the new version through CI/CD.',
      estimatedDuration: 'PT15M',
    },
  },
  {
    action_id: 'drain_node',
    display_name: 'Drain Kubernetes node',
    description:
      'Cordon and drain the target node to evacuate workloads ahead of replacement or maintenance.',
    skill_domain: 'kubernetes',
    action_class: 2,
    mutation_type: 'state_mutation',
    step_type: 'system_action',
    target_kinds: ['kubernetes'],
    required_capabilities: ['k8s.node.drain'],
    execution_context: 'kubernetes_write',
    default_timeout: 'PT10M',
    risk_level: 'elevated',
    blast_radius: {
      directComponents: ['node'],
      indirectComponents: ['workloads', 'scheduler_capacity'],
      maxImpact: 'Workloads on the node are evicted and rescheduled; throughput may dip briefly.',
      cascadeRisk: 'medium',
    },
    state_captures_before: [
      {
        name: 'node_state_before',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
      {
        name: 'node_pods_before',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    state_captures_after: [
      {
        name: 'node_state_after',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    success_check: {
      description: 'Node is cordoned and reports zero scheduled non-daemonset pods',
      check: {
        type: 'api_field',
        operation: 'get_node_pod_count',
        expect: { operator: 'eq', value: 0 },
      },
    },
    rollback: {
      type: 'command',
      description: 'Uncordon the node to restore scheduling.',
      estimatedDuration: 'PT1M',
      command: {
        type: 'kubernetes_api',
        operation: 'uncordon_node',
      },
    },
  },
  {
    action_id: 'evict_pod',
    display_name: 'Evict Kubernetes pod',
    description: 'Evict the target pod so the controller reschedules a fresh replica.',
    skill_domain: 'kubernetes',
    action_class: 2,
    mutation_type: 'state_mutation',
    step_type: 'system_action',
    target_kinds: ['kubernetes'],
    required_capabilities: ['k8s.pod.delete'],
    execution_context: 'kubernetes_write',
    default_timeout: 'PT60S',
    risk_level: 'elevated',
    blast_radius: {
      directComponents: ['pod'],
      indirectComponents: ['service_endpoints'],
      maxImpact: 'In-flight requests on the evicted pod terminate; replacement comes up shortly.',
      cascadeRisk: 'low',
    },
    state_captures_before: [
      {
        name: 'pod_state_before',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    state_captures_after: [
      {
        name: 'replacement_pod_state',
        captureType: 'api_snapshot',
        captureCost: 'negligible',
        capturePolicy: 'best_effort',
      },
    ],
    success_check: {
      description: 'Original pod is gone and a replacement is Running',
      check: {
        type: 'api_field',
        operation: 'replacement_pod_running',
        expect: { operator: 'eq', value: true },
      },
    },
    rollback: {
      type: 'manual',
      description:
        'Eviction is not directly reversible; the controller reschedules automatically. Investigate root cause if the replacement also fails.',
      estimatedDuration: 'PT2M',
    },
  },
  {
    action_id: 'reset_consumer_group',
    display_name: 'Reset Kafka consumer group offsets',
    description:
      'Reset consumer group offsets to a recovery point to clear lag or skip a poisoned message.',
    skill_domain: 'service',
    action_class: 2,
    mutation_type: 'state_mutation',
    step_type: 'system_action',
    target_kinds: ['kafka'],
    required_capabilities: ['consumer.group.reset'],
    execution_context: 'kafka_write',
    default_timeout: 'PT2M',
    risk_level: 'elevated',
    blast_radius: {
      directComponents: ['consumer_group'],
      indirectComponents: ['downstream_consumers', 'message_processing'],
      maxImpact:
        'Messages between current and reset offset are skipped or replayed depending on the reset target.',
      cascadeRisk: 'medium',
    },
    state_captures_before: [
      {
        name: 'consumer_group_state_before',
        captureType: 'command_output',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
      {
        name: 'consumer_group_lag_before',
        captureType: 'command_output',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    state_captures_after: [
      {
        name: 'consumer_group_state_after',
        captureType: 'command_output',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ],
    success_check: {
      description: 'Consumer group offsets are at the requested reset target',
      check: {
        type: 'kafka_offset',
        operation: 'get_offsets',
        expect: { operator: 'eq', value: '$target_offset' },
      },
    },
    rollback: {
      type: 'manual',
      description:
        'Offset reset is destructive of consumer state; manual replay from the original offset is required if the reset was wrong.',
      estimatedDuration: 'PT5M',
    },
  },
];
