// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { builtinAgents } from '../config/builtin-agents.js';
import { explainSource } from '../framework/signal-explanations.js';

/**
 * Representative diagnosis signal source(s) per built-in agent kind.
 * Adding a new agent to builtinAgents without adding it here fails the first
 * assertion; listing a source no EXPLANATIONS entry matches fails the second.
 * Grep the agent's agent.ts for `source: '...'` values when adding.
 */
const REPRESENTATIVE_SOURCES: Record<string, string[]> = {
  postgresql: ['pg_connection', 'pg_replication_lag'],
  redis: ['redis_info_memory'],
  etcd: ['etcd_cluster_health'],
  kafka: ['kafka_broker_status'],
  kubernetes: ['k8s_node_status'],
  ceph: ['ceph_cluster_health'],
  flink: ['flink_job_status'],
  dns: ['resolver_reachability'],
  tls: ['certificate_expiry'],
  disk: ['disk_usage'],
  backup: ['backup_existence'],
  'ai-provider': ['provider_health_status'],
  'application-config': ['environment_variables'],
  'managed-database': ['schema_migrations'],
  application: ['deploy_status'],
  'message-queue': ['queue_discovery'],
  'aws-s3': ['s3_versioning'],
  'aws-dynamodb': ['dynamodb_continuous_backups'],
  'aws-rds': ['rds_backup_retention', 'rds_instance_status', 'rds_connection_saturation', 'rds_storage', 'rds_security_group', 'rds_iam_permissions'],
  'iac-drift': ['iac_state', 'iac_resource_missing', 'iac_attribute_drift'],
  'llm-provider.anthropic': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.openai': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.google': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'llm-provider.openrouter': ['llm_key_present', 'llm_key_valid', 'llm_quota_billing', 'llm_rate_limit_headroom', 'llm_model_deprecated', 'llm_provider_status'],
  'vector-store': ['vector_store_reachable', 'vector_store_auth', 'vector_store_index'],
};

describe('explanation coverage', () => {
  it('lists representative sources for every built-in agent kind', () => {
    for (const reg of builtinAgents) {
      expect(
        REPRESENTATIVE_SOURCES[reg.kind],
        `agent kind '${reg.kind}' has no representative sources — add them (and an EXPLANATIONS entry if needed)`,
      ).toBeDefined();
    }
  });

  it('every representative source matches an EXPLANATIONS entry', () => {
    for (const [kind, sources] of Object.entries(REPRESENTATIVE_SOURCES)) {
      for (const source of sources) {
        expect(
          explainSource(source),
          `source '${source}' (agent '${kind}') matches no EXPLANATIONS entry`,
        ).toBeDefined();
      }
    }
  });
});
