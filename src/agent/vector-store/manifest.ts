// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

/**
 * Single source of truth for this agent's maturity claim, shared with the
 * live client's listCapabilityProviders() (src/agent/vector-store/live-client.ts)
 * so the two can never drift. Promoted to 'live_validated' only after
 * real-account validation (Task 10 ruling — no provider credentials yet).
 */
export const VECTOR_STORE_MATURITY = 'simulator_only' as const;

export const vectorStoreManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'vector-store-diagnosis',
    version: '1.0.0',
    description:
      'Checks managed vector stores (Pinecone, Upstash Vector) for reachability, credential validity, and ' +
      'index readiness. Read-only: it reports and suggests, never mutates an index.',
    ...defaultManifestMetadata(),
    tags: ['vector', 'rag', 'retrieval', 'pinecone', 'upstash'],
    plugin: {
      id: 'vector-store.domain-pack',
      kind: 'domain_pack',
      maturity: VECTOR_STORE_MATURITY,
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'vector-store',
        versionConstraint: '*',
        components: ['control-plane', 'index'],
      },
    ],
    triggerConditions: [
      { type: 'health_check', name: 'vector_store_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated vector-store check' },
    ],
    failureScenarios: [
      // The neutral no-actionable-finding scenario is a valid plan outcome, not a failure mode
      // — required so validatePlan accepts healthy-path plans.
      'no_finding',
      'unreachable',
      'auth_rejected',
      'index_not_ready',
      'no_indexes',
    ],
    executionContexts: [
      {
        name: 'vector_store_read',
        type: 'api_call',
        privilege: 'read',
        target: 'vector-store',
        allowedOperations: ['query_vector_stores'],
        capabilities: ['vectorstore.index.read'],
      },
    ],
    observabilityDependencies: {
      required: ['vector_store_control_plane'],
      optional: ['vector_store_index_stats'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
