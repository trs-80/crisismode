import type { AgentContext } from '../types/agent-context.js';
import type { AgentManifest } from '../types/manifest.js';

export function assembleContext(
  trigger: AgentContext['trigger'],
  manifest: AgentManifest,
): AgentContext {
  return {
    trigger,
    topology: {
      source: 'framework_model',
      staleness: 'PT5M',
      authoritative: false,
      components: [
        {
          identifier: 'pg-primary-us-east-1',
          technology: 'postgresql',
          version: '16.2',
          role: 'primary',
          reachable: true,
          lastHealthCheck: new Date(Date.now() - 25000).toISOString(),
          healthStatus: 'degraded',
        },
        {
          identifier: 'pg-replica-us-east-1a',
          technology: 'postgresql',
          version: '16.2',
          role: 'replica',
          reachable: true,
          lastHealthCheck: new Date(Date.now() - 25000).toISOString(),
          healthStatus: 'degraded',
        },
        {
          identifier: 'pg-replica-us-east-1b',
          technology: 'postgresql',
          version: '16.2',
          role: 'replica',
          reachable: true,
          lastHealthCheck: new Date(Date.now() - 25000).toISOString(),
          healthStatus: 'unhealthy',
        },
        {
          identifier: 'pg-replica-us-east-1c',
          technology: 'postgresql',
          version: '16.2',
          role: 'replica',
          reachable: true,
          lastHealthCheck: new Date(Date.now() - 25000).toISOString(),
          healthStatus: 'degraded',
        },
        {
          identifier: 'haproxy-us-east-1',
          technology: 'haproxy',
          version: '2.8.3',
          role: 'load_balancer',
          reachable: true,
          lastHealthCheck: new Date(Date.now() - 10000).toISOString(),
          healthStatus: 'healthy',
        },
      ],
      relationships: [
        { from: 'pg-primary-us-east-1', to: 'pg-replica-us-east-1a', type: 'replication', status: 'lagging' },
        { from: 'pg-primary-us-east-1', to: 'pg-replica-us-east-1b', type: 'replication', status: 'lagging' },
        { from: 'pg-primary-us-east-1', to: 'pg-replica-us-east-1c', type: 'replication', status: 'lagging' },
        { from: 'haproxy-us-east-1', to: 'pg-replica-us-east-1a', type: 'load_balance', status: 'active' },
        { from: 'haproxy-us-east-1', to: 'pg-replica-us-east-1b', type: 'load_balance', status: 'active' },
        { from: 'haproxy-us-east-1', to: 'pg-replica-us-east-1c', type: 'load_balance', status: 'active' },
      ],
    },
    frameworkLayers: {
      execution_kernel: 'available',
      safety: 'available',
      coordination: 'available',
      enrichment: 'unavailable',
    },
    trustLevel: 'copilot',
    trustScenarioOverrides: {
      replication_lag_cascade: 'autopilot',
    },
    organizationalPolicies: {
      maxAutonomousRiskLevel: 'routine',
      requireApprovalAbove: 'routine',
      requireApprovalForAllElevated: false,
      shellCommandsEnabled: false,
      approvalTimeoutMinutes: 15,
      escalationDepth: 3,
    },
    preAuthorizedCatalogs: ['pg-replication-standard-recovery'],
    availableExecutionContexts: manifest.spec.executionContexts.map((ec) => ec.name),
    priorIncidents: [],
  };
}
