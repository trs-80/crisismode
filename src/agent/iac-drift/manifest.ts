// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const iacDriftManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'iac-drift-recovery',
    version: '1.0.0',
    description:
      'Detects drift between Terraform-managed intent and observed AWS infrastructure. Read-only: suggests reconciliation, never executes terraform.',
    ...defaultManifestMetadata(),
    tags: ['terraform', 'iac', 'drift', 'aws'],
    plugin: {
      id: 'iac.drift',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'terraform',
        versionConstraint: '*',
        components: ['state', 'aws-resources'],
      },
    ],
    triggerConditions: [
      {
        type: 'health_check',
        name: 'iac_alignment_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Terraform drift scan',
      },
    ],
    failureScenarios: ['resource_missing', 'attribute_drift', 'state_stale', 'state_unreadable'],
    executionContexts: [
      {
        name: 'iac_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'terraform-state',
        allowedOperations: ['scan_iac_drift'],
        capabilities: ['iac.state.read'],
      },
    ],
    observabilityDependencies: {
      required: ['terraform_state'],
      optional: ['aws_control_plane'],
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
