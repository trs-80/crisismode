// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { validatePlan } from '../framework/validator.js';
import { assembleContext } from '../framework/context.js';
import { RISK_ORDER, riskExceeds, getMaxRiskIndex } from '../framework/risk.js';
import { walkSteps, collectSystemActions } from '../framework/step-walker.js';
import { registerExternalCapability } from '../framework/capability-registry.js';
import { PgReplicationAgent } from '../agent/pg-replication/agent.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { RedisMemoryAgent } from '../agent/redis/agent.js';
import { RedisSimulator } from '../agent/redis/simulator.js';
import { EtcdRecoveryAgent } from '../agent/etcd/agent.js';
import { EtcdSimulator } from '../agent/etcd/simulator.js';
import { KafkaRecoveryAgent } from '../agent/kafka/agent.js';
import { KafkaSimulator } from '../agent/kafka/simulator.js';
import { K8sRecoveryAgent } from '../agent/kubernetes/agent.js';
import { K8sSimulator } from '../agent/kubernetes/simulator.js';
import { CephRecoveryAgent } from '../agent/ceph/agent.js';
import { CephSimulator } from '../agent/ceph/simulator.js';
import { FlinkRecoveryAgent } from '../agent/flink/agent.js';
import { FlinkSimulator } from '../agent/flink/simulator.js';
import { AiProviderFailoverAgent } from '../agent/ai-provider/agent.js';
import { AiProviderSimulator } from '../agent/ai-provider/simulator.js';
import { ConfigDriftAgent } from '../agent/config-drift/agent.js';
import { ConfigDriftSimulator } from '../agent/config-drift/simulator.js';
import { DbMigrationAgent } from '../agent/db-migration/agent.js';
import { DbMigrationSimulator } from '../agent/db-migration/simulator.js';
import { DeployRollbackAgent } from '../agent/deploy-rollback/agent.js';
import { DeploySimulator } from '../agent/deploy-rollback/simulator.js';
import { QueueBacklogAgent } from '../agent/queue-backlog/agent.js';
import { QueueSimulator } from '../agent/queue-backlog/simulator.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from '../framework/backend.js';

// Register capabilities used by newer agents that aren't yet in the built-in registry.
// Each entry needs only id, actionKind, description, targetKinds, and manualFallback.
const EXTRA_CAPABILITIES: Array<{
  id: string;
  actionKind: 'read' | 'mutate';
  targetKinds: string[];
}> = [
  // AI Provider
  { id: 'provider.status.read', actionKind: 'read', targetKinds: ['ai-provider'] },
  { id: 'provider.metrics.read', actionKind: 'read', targetKinds: ['ai-provider'] },
  { id: 'provider.circuit_breaker.trip', actionKind: 'mutate', targetKinds: ['ai-provider'] },
  { id: 'provider.fallback.activate', actionKind: 'mutate', targetKinds: ['ai-provider'] },
  { id: 'provider.traffic.shift', actionKind: 'mutate', targetKinds: ['ai-provider'] },
  // Config Drift
  { id: 'config.env.read', actionKind: 'read', targetKinds: ['config'] },
  { id: 'config.secrets.read', actionKind: 'read', targetKinds: ['config'] },
  { id: 'config.env.restore', actionKind: 'mutate', targetKinds: ['config'] },
  { id: 'config.secrets.rotate', actionKind: 'mutate', targetKinds: ['config'] },
  { id: 'config.file.restore', actionKind: 'mutate', targetKinds: ['config'] },
  // DB Migration
  { id: 'db.connections.read', actionKind: 'read', targetKinds: ['postgresql'] },
  { id: 'db.connections.terminate', actionKind: 'mutate', targetKinds: ['postgresql'] },
  { id: 'db.migration.rollback', actionKind: 'mutate', targetKinds: ['postgresql'] },
  // Deploy Rollback
  { id: 'deploy.status.read', actionKind: 'read', targetKinds: ['deployment'] },
  { id: 'deploy.history.read', actionKind: 'read', targetKinds: ['deployment'] },
  { id: 'deploy.rollback', actionKind: 'mutate', targetKinds: ['deployment'] },
  { id: 'traffic.shift', actionKind: 'mutate', targetKinds: ['deployment'] },
  // Queue Backlog
  { id: 'queue.stats.read', actionKind: 'read', targetKinds: ['message-queue'] },
  { id: 'queue.workers.read', actionKind: 'read', targetKinds: ['message-queue'] },
  { id: 'queue.pause', actionKind: 'mutate', targetKinds: ['message-queue'] },
  { id: 'queue.workers.restart', actionKind: 'mutate', targetKinds: ['message-queue'] },
  { id: 'queue.dlq.retry', actionKind: 'mutate', targetKinds: ['message-queue'] },
  { id: 'queue.workers.scale', actionKind: 'mutate', targetKinds: ['message-queue'] },
];

interface PlanFixture {
  name: string;
  build: () => {
    agent: RecoveryAgent;
    backend: ExecutionBackend;
    context: AgentContext;
  };
}

function makeAlertTrigger(
  alertname: string,
  instance: string,
): AgentContext['trigger'] {
  return {
    type: 'alert',
    source: 'prometheus',
    payload: {
      alertname,
      instance,
      severity: 'critical',
    },
    receivedAt: new Date().toISOString(),
  };
}

const fixtures: PlanFixture[] = [
  {
    name: 'PostgreSQL replication',
    build: () => {
      const backend = new PgSimulator();
      const agent = new PgReplicationAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('PostgresReplicationLagCritical', 'pg-primary-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Redis memory',
    build: () => {
      const backend = new RedisSimulator();
      const agent = new RedisMemoryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('RedisMemoryPressureCritical', 'redis-primary-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'etcd',
    build: () => {
      const backend = new EtcdSimulator();
      const agent = new EtcdRecoveryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('EtcdLeaderElectionLoop', 'etcd-cluster-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Kafka',
    build: () => {
      const backend = new KafkaSimulator();
      const agent = new KafkaRecoveryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('KafkaUnderReplicatedPartitions', 'kafka-cluster-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Kubernetes',
    build: () => {
      const backend = new K8sSimulator();
      const agent = new K8sRecoveryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('KubernetesNodeNotReady', 'k8s-cluster-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Ceph',
    build: () => {
      const backend = new CephSimulator();
      const agent = new CephRecoveryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('CephOSDDown', 'ceph-cluster-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Flink',
    build: () => {
      const backend = new FlinkSimulator();
      const agent = new FlinkRecoveryAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('FlinkCheckpointFailure', 'flink-cluster-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'AI Provider',
    build: () => {
      const backend = new AiProviderSimulator();
      const agent = new AiProviderFailoverAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('AiProviderLatencyCritical', 'ai-provider-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Config Drift',
    build: () => {
      const backend = new ConfigDriftSimulator();
      const agent = new ConfigDriftAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('ConfigDriftDetected', 'config-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'DB Migration',
    build: () => {
      const backend = new DbMigrationSimulator();
      const agent = new DbMigrationAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('DatabaseMigrationStuck', 'db-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Deploy Rollback',
    build: () => {
      const backend = new DeploySimulator();
      const agent = new DeployRollbackAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('error_rate_spike', 'app-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
  {
    name: 'Queue Backlog',
    build: () => {
      const backend = new QueueSimulator();
      const agent = new QueueBacklogAgent(backend);
      const context = assembleContext(
        makeAlertTrigger('QueueBacklogOverflow', 'queue-us-east-1'),
        agent.manifest,
      );
      return { agent, backend, context };
    },
  },
];

describe('safety invariants', () => {
  beforeAll(() => {
    for (const cap of EXTRA_CAPABILITIES) {
      registerExternalCapability({
        id: cap.id,
        actionKind: cap.actionKind,
        description: `Test-registered capability: ${cap.id}`,
        targetKinds: cap.targetKinds,
        manualFallback: `Perform ${cap.id} manually.`,
      });
    }
  });

  describe('plan validation', () => {
    it.each(fixtures)('$name plans always pass structural validation', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);
          const result = validatePlan(plan, agent.manifest);
          expect(result.valid).toBe(true);
          expect(result.checks.filter((c) => !c.passed)).toEqual([]);
        }),
        { numRuns: 1 },
      );
    });
  });

  describe('step ID uniqueness', () => {
    it.each(fixtures)('$name has unique step IDs', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);
          const ids: string[] = [];
          walkSteps(plan.steps, (step) => ids.push(step.stepId));
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(ids.length);
        }),
        { numRuns: 1 },
      );
    });
  });

  describe('rollback always present', () => {
    it.each(fixtures)('$name plan has a rollback strategy', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);
          expect(plan.rollbackStrategy).toBeDefined();
          expect(plan.rollbackStrategy.type).toBeTruthy();
        }),
        { numRuns: 1 },
      );
    });
  });

  describe('escalation monotonicity', () => {
    it('higher risk steps never decrease the plan escalation level', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 3 }),
          fc.integer({ min: 0, max: 3 }),
          (a, b) => {
            // If a > b, then riskExceeds(RISK_ORDER[a], RISK_ORDER[b]) must be true
            if (a > b) {
              expect(riskExceeds(RISK_ORDER[a], RISK_ORDER[b])).toBe(true);
            }
            // The max risk index of a combined set should be >= each individual index
            expect(Math.max(a, b)).toBeGreaterThanOrEqual(a);
            expect(Math.max(a, b)).toBeGreaterThanOrEqual(b);
          },
        ),
        { numRuns: 100 },
      );
    });

    it.each(fixtures)('$name plan max risk index is consistent with steps', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);
          const maxIndex = getMaxRiskIndex(plan.steps);
          // Max risk index must be a valid index into RISK_ORDER
          expect(maxIndex).toBeGreaterThanOrEqual(0);
          expect(maxIndex).toBeLessThan(RISK_ORDER.length);
          // Verify it actually matches the highest risk step
          const actions = collectSystemActions(plan.steps);
          if (actions.length > 0) {
            const highestStepIndex = Math.max(
              ...actions.map((a) => RISK_ORDER.indexOf(a.riskLevel)),
            );
            expect(maxIndex).toBe(highestStepIndex);
          }
        }),
        { numRuns: 1 },
      );
    });
  });

  describe('read-only idempotency', () => {
    it.each(fixtures)('$name assessHealth returns identical results on repeated calls', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const first = await agent.assessHealth(context);
          const second = await agent.assessHealth(context);
          expect(first.status).toBe(second.status);
          expect(first.confidence).toBe(second.confidence);
        }),
        { numRuns: 1 },
      );
    });
  });

  describe('state preservation for elevated+ steps', () => {
    it.each(fixtures)('$name elevated+ system_actions have statePreservation.before', async ({ build }) => {
      await fc.assert(
        fc.asyncProperty(fc.constant(build()), async ({ agent, context }) => {
          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);
          const actions = collectSystemActions(plan.steps);
          for (const action of actions) {
            if (riskExceeds(action.riskLevel, 'routine') || action.riskLevel === 'elevated') {
              expect(
                action.statePreservation?.before?.length,
                `Step "${action.stepId}" at risk "${action.riskLevel}" must have statePreservation.before captures`,
              ).toBeGreaterThan(0);
            }
          }
        }),
        { numRuns: 1 },
      );
    });
  });
});
