// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const dnsManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'dns-recovery',
    version: '1.0.0',
    description:
      'Detects and recovers from DNS resolution failures including resolver timeouts, SERVFAIL storms, NXDOMAIN propagation failures, split-brain DNS, stale resolvers, and DNSSEC validation failures.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['dns', 'resolver', 'networking', 'split-brain', 'dnssec'],
    plugin: {
      id: 'dns.recovery',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'dns',
        versionConstraint: '*',
        components: ['resolver', 'zone', 'cache', 'dnssec-chain'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'DnsResolutionFailure' } },
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'DnsLatencyHigh' } },
      { type: 'health_check', name: 'dns_resolver_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated DNS recovery' },
    ],
    failureScenarios: [
      'resolver_timeout',
      'nxdomain_storm',
      'servfail_responses',
      'stale_resolvers',
      'split_brain_dns',
      'dnssec_validation_failure',
    ],
    executionContexts: [
      {
        name: 'dns_read',
        type: 'api_call',
        privilege: 'read',
        target: 'dns-resolver',
        allowedOperations: ['probe_resolvers', 'check_resolv_conf', 'verify_resolution'],
        capabilities: ['dns.resolver.probe', 'dns.resolution.verify', 'dns.resolv_conf.read'],
      },
      {
        name: 'dns_write',
        type: 'api_call',
        privilege: 'write',
        target: 'dns-resolver',
        allowedOperations: ['flush_cache', 'update_resolv_conf'],
        capabilities: ['dns.cache.flush', 'dns.resolv_conf.write'],
      },
    ],
    observabilityDependencies: {
      required: ['resolver_probe_results', 'resolv_conf'],
      optional: ['resolution_latency_metrics', 'dnssec_chain_status'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'network_engineer', 'engineering_lead'],
    },
  },
};
