// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));
vi.mock('../framework/coordinator.js', () => ({
  requestApproval: async () => 'approved' as const,
  shouldAutoApprove: () => true,
  sendNotification: () => {},
}));

import { validatePlan } from '../framework/validator.js';
import { assembleContext } from '../framework/context.js';
import { ExecutionEngine } from '../framework/engine.js';
import { ForensicRecorder } from '../framework/forensics.js';
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

interface E2EFixture {
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

const fixtures: E2EFixture[] = [
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

describe('end-to-end simulator flows', () => {
  it.each(fixtures)(
    '$name: assessHealth → diagnose → plan → validate → dry-run',
    async ({ build }) => {
      const { agent, backend, context } = build();

      // 1. Health assessment
      const health = await agent.assessHealth(context);
      expect(health.status).toBeDefined();
      expect(health.confidence).toBeGreaterThan(0);
      expect(health.confidence).toBeLessThanOrEqual(1);

      // 2. Diagnosis
      const diagnosis = await agent.diagnose(context);
      expect(diagnosis.status).toBeDefined();

      // 3. Plan generation
      const plan = await agent.plan(context, diagnosis);
      expect(plan.steps.length).toBeGreaterThan(0);

      // 4. Validation
      const validation = validatePlan(plan, agent.manifest);
      expect(validation.checks.filter((c) => !c.passed)).toEqual([]);
      expect(validation.valid).toBe(true);

      // 5. Dry-run execution via ExecutionEngine
      const recorder = new ForensicRecorder();
      const engine = new ExecutionEngine(
        context,
        agent.manifest,
        agent,
        recorder,
        backend,
        {},
        'dry-run',
      );
      const results = await engine.executePlan(plan, diagnosis);
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(['success', 'skipped', 'failed']).toContain(result.status);
        expect(result.stepId).toBeDefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }
    },
  );
});
