// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { validatePlan } from '../framework/validator.js';
import { assembleContext } from '../framework/context.js';
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
import type { RecoveryAgent } from '../agent/interface.js';
import type { AgentContext } from '../types/agent-context.js';
import type { ExecutionBackend } from '../framework/backend.js';

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
];

describe('generated recovery plans', () => {
  it.each(fixtures)('$name plans pass structural validation and simulator execute readiness checks', async ({ build }) => {
    const { agent, backend, context } = build();
    const diagnosis = await agent.diagnose(context);
    const plan = await agent.plan(context, diagnosis);

    const structuralValidation = validatePlan(plan, agent.manifest);
    expect(structuralValidation.valid).toBe(true);
    expect(structuralValidation.checks.filter((check) => !check.passed)).toEqual([]);

    const executeValidation = validatePlan(plan, agent.manifest, {
      requireExecutableCapabilities: true,
      backend,
      executionMode: 'execute',
    });
    expect(executeValidation.valid).toBe(true);
    expect(executeValidation.checks.filter((check) => !check.passed)).toEqual([]);
  });
});
