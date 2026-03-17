// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const configDriftManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'config-drift-recovery',
    version: '1.0.0',
    description:
      'Detects and recovers from secrets, config, and environment drift after deploys.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['config', 'secrets', 'environment', 'drift'],
    plugin: {
      id: 'config.drift',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'application-config',
        versionConstraint: '>=1.0.0',
        components: ['environment-variables', 'secrets', 'config-files'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'deploy-pipeline',
        matchLabels: { alertname: 'ConfigDriftDetected' },
      },
      {
        type: 'health_check',
        name: 'config_alignment_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated config drift recovery after deploy',
      },
    ],
    failureScenarios: [
      'env_var_mismatch',
      'secret_expired',
      'config_file_drift',
      'missing_env_vars',
    ],
    executionContexts: [
      {
        name: 'config_read',
        type: 'api_call',
        privilege: 'read',
        target: 'application-config',
        allowedOperations: ['scan_config', 'verify_alignment'],
        capabilities: ['config.env.read', 'config.secrets.read'],
      },
      {
        name: 'config_write',
        type: 'configuration_change',
        privilege: 'write',
        target: 'application-config',
        allowedOperations: ['restore_env_vars', 'rotate_secrets', 'restore_config_files'],
        capabilities: ['config.env.restore', 'config.secrets.rotate', 'config.file.restore'],
      },
    ],
    observabilityDependencies: {
      required: ['config_manifest', 'secret_status'],
      optional: ['deploy_audit_log', 'prometheus_metrics'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
