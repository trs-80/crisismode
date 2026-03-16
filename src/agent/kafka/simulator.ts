// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  KafkaBackend,
  KafkaBrokerInfo,
  KafkaClusterMetadata,
  KafkaConsumerGroup,
  KafkaTopicPartition,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class KafkaSimulator implements KafkaBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getClusterMetadata(): Promise<KafkaClusterMetadata> {
    const brokers = await this.getBrokers();
    return {
      clusterId: 'kafka-cluster-001',
      controllerId: 0,
      brokers,
      topicCount: 5,
      partitionCount: 24,
    };
  }

  async getTopicPartitions(_topic?: string): Promise<KafkaTopicPartition[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
          { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0], isUnderReplicated: true },
          { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1], isUnderReplicated: true },
          { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0], isUnderReplicated: true },
          { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
          { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
        ];
      case 'recovering':
        return [
          { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
          { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
          { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1], isUnderReplicated: true },
          { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
          { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
          { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
        ];
      case 'recovered':
        return [
          { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
          { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
          { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
          { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
          { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
          { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
        ];
    }
  }

  async getConsumerGroups(): Promise<KafkaConsumerGroup[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { groupId: 'order-processor', state: 'Stable', members: 4, lag: 45_000 },
          { groupId: 'event-aggregator', state: 'PreparingRebalance', members: 3, lag: 12_000 },
          { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 500 },
        ];
      case 'recovering':
        return [
          { groupId: 'order-processor', state: 'Stable', members: 4, lag: 8_000 },
          { groupId: 'event-aggregator', state: 'CompletingRebalance', members: 3, lag: 3_500 },
          { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 200 },
        ];
      case 'recovered':
        return [
          { groupId: 'order-processor', state: 'Stable', members: 4, lag: 50 },
          { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 30 },
          { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 10 },
        ];
    }
  }

  async getUnderReplicatedPartitions(): Promise<KafkaTopicPartition[]> {
    const partitions = await this.getTopicPartitions();
    return partitions.filter((p) => p.isUnderReplicated);
  }

  async getBrokerConfigs(_brokerId: number): Promise<Record<string, string>> {
    switch (this.state) {
      case 'degraded':
        return {
          'log.flush.interval.messages': 'Long.MAX_VALUE',
          'num.replica.fetchers': '1',
          'replica.lag.time.max.ms': '30000',
          'min.insync.replicas': '2',
          'default.replication.factor': '3',
        };
      case 'recovering':
        return {
          'log.flush.interval.messages': '10000',
          'num.replica.fetchers': '2',
          'replica.lag.time.max.ms': '30000',
          'min.insync.replicas': '2',
          'default.replication.factor': '3',
        };
      case 'recovered':
        return {
          'log.flush.interval.messages': '10000',
          'num.replica.fetchers': '2',
          'replica.lag.time.max.ms': '30000',
          'min.insync.replicas': '2',
          'default.replication.factor': '3',
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported Kafka simulator command type: ${command.type}`);
    }

    const operation = command.operation ?? '';
    const parameters = command.parameters ?? {};

    switch (operation) {
      case 'cluster_metadata':
        return {
          metadata: await this.getClusterMetadata(),
          partitions: await this.getTopicPartitions(),
          consumerGroups: await this.getConsumerGroups(),
        };
      case 'leader_elect':
        this.transition('recovering');
        return { electedPartitions: true };
      case 'partition_reassign':
        this.transition('recovered');
        return { reassignedPartitions: true };
      case 'config_set':
        return { ok: true };
      case 'consumer_group_reset':
        return { ok: true };
      default:
        return { simulated: true, operation, parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'under_replicated_count') {
      const urps = await this.getUnderReplicatedPartitions();
      return this.compare(urps.length, check.expect.operator, check.expect.value);
    }

    if (stmt === 'consumer_lag') {
      const groups = await this.getConsumerGroups();
      const maxLag = Math.max(0, ...groups.map((g) => g.lag));
      return this.compare(maxLag, check.expect.operator, check.expect.value);
    }

    if (stmt === 'broker_count') {
      const meta = await this.getClusterMetadata();
      return this.compare(meta.brokers.length, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'kafka-simulator-admin',
        kind: 'capability_provider',
        name: 'Kafka Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: [
          'broker.partition.reassign',
          'broker.leader.elect',
          'broker.config.set',
          'consumer.group.reset',
        ],
        executionContexts: ['kafka_admin'],
        targetKinds: ['kafka'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }

  private async getBrokers(): Promise<KafkaBrokerInfo[]> {
    switch (this.state) {
      case 'degraded':
        return [
          { id: 0, host: '10.0.1.10', port: 9092, rack: 'rack-a', isController: true },
          { id: 1, host: '10.0.1.11', port: 9092, rack: 'rack-b', isController: false },
          { id: 2, host: '10.0.1.12', port: 9092, rack: 'rack-c', isController: false },
        ];
      case 'recovering':
        return [
          { id: 0, host: '10.0.1.10', port: 9092, rack: 'rack-a', isController: true },
          { id: 1, host: '10.0.1.11', port: 9092, rack: 'rack-b', isController: false },
          { id: 2, host: '10.0.1.12', port: 9092, rack: 'rack-c', isController: false },
        ];
      case 'recovered':
        return [
          { id: 0, host: '10.0.1.10', port: 9092, rack: 'rack-a', isController: true },
          { id: 1, host: '10.0.1.11', port: 9092, rack: 'rack-b', isController: false },
          { id: 2, host: '10.0.1.12', port: 9092, rack: 'rack-c', isController: false },
        ];
    }
  }
}
