// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const tlsManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'tls-certificate-recovery',
    version: '1.0.0',
    description:
      'Detects and alerts on TLS certificate issues including expiration, chain validation failures, hostname mismatches, and weak cryptographic configurations.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['tls', 'ssl', 'certificate', 'expiry', 'security'],
    plugin: {
      id: 'tls.certificate',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'tls',
        versionConstraint: '*',
        components: ['certificate', 'chain', 'endpoint'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'TlsCertExpiringSoon' } },
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'TlsCertExpired' } },
      { type: 'health_check', name: 'tls_certificate_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated TLS certificate inspection' },
    ],
    failureScenarios: [
      'certificate_expired',
      'certificate_expiring_soon',
      'certificate_chain_invalid',
      'certificate_hostname_mismatch',
      'weak_key_or_protocol',
    ],
    executionContexts: [
      {
        name: 'tls_read',
        type: 'api_call',
        privilege: 'read',
        target: 'tls-endpoint',
        allowedOperations: ['inspect_endpoint', 'validate_chain', 'check_config'],
        capabilities: ['tls.endpoint.inspect', 'tls.chain.validate', 'tls.config.read'],
      },
    ],
    observabilityDependencies: {
      required: ['endpoint_certificate_info'],
      optional: ['certificate_transparency_logs', 'ocsp_status'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: false,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'security_engineer', 'engineering_lead'],
    },
  },
};
