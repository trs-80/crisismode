// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  BrokerLiveness,
  KafkaBackend,
  KafkaBrokerInfo,
  KafkaClusterMetadata,
  KafkaConsumerGroup,
  KafkaTopicPartition,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';
export type KafkaScenario = 'urp' | 'broker_down' | 'consumer_lag_cascade';

// ---------------------------------------------------------------------------
// Scenario data tables
// ---------------------------------------------------------------------------

const ALL_BROKERS: KafkaBrokerInfo[] = [
  { id: 0, host: '10.0.1.10', port: 9092, rack: 'rack-a', isController: true, isAlive: true },
  { id: 1, host: '10.0.1.11', port: 9092, rack: 'rack-b', isController: false, isAlive: true },
  { id: 2, host: '10.0.1.12', port: 9092, rack: 'rack-c', isController: false, isAlive: true },
];

const BROKER_DOWN_BROKER_2_DEAD: KafkaBrokerInfo = {
  id: 2, host: '10.0.1.12', port: 9092, rack: 'rack-c', isController: false, isAlive: false,
};

interface ScenarioData {
  brokers: Record<SimulatorState, KafkaBrokerInfo[]>;
  partitions: Record<SimulatorState, KafkaTopicPartition[]>;
  consumerGroups: Record<SimulatorState, KafkaConsumerGroup[]>;
  brokerConfigs: Record<SimulatorState, Record<string, string>>;
  liveness: Record<SimulatorState, Record<number, BrokerLiveness>>;
}

function ts(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

const HEALTHY_LIVENESS: Record<number, BrokerLiveness> = {
  0: { brokerId: 0, reachable: true, lastSeen: ts(0), diskUsagePercent: 42, cpuLoadPercent: 35, networkErrorRate: 0 },
  1: { brokerId: 1, reachable: true, lastSeen: ts(0), diskUsagePercent: 38, cpuLoadPercent: 28, networkErrorRate: 0 },
  2: { brokerId: 2, reachable: true, lastSeen: ts(0), diskUsagePercent: 45, cpuLoadPercent: 32, networkErrorRate: 0 },
};

// --- URP scenario (original behavior) ---

const URP_DATA: ScenarioData = {
  brokers: {
    degraded: [...ALL_BROKERS],
    recovering: [...ALL_BROKERS],
    recovered: [...ALL_BROKERS],
  },
  partitions: {
    degraded: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0], isUnderReplicated: true },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1], isUnderReplicated: true },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0], isUnderReplicated: true },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
    ],
    recovering: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1], isUnderReplicated: true },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 0, 2], isUnderReplicated: false },
    ],
    recovered: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
    ],
  },
  consumerGroups: {
    degraded: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 45_000 },
      { groupId: 'event-aggregator', state: 'PreparingRebalance', members: 3, lag: 12_000 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 500 },
    ],
    recovering: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 8_000 },
      { groupId: 'event-aggregator', state: 'CompletingRebalance', members: 3, lag: 3_500 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 200 },
    ],
    recovered: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 50 },
      { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 30 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 10 },
    ],
  },
  brokerConfigs: {
    degraded: {
      'log.flush.interval.messages': 'Long.MAX_VALUE',
      'num.replica.fetchers': '1',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
    recovering: {
      'log.flush.interval.messages': '10000',
      'num.replica.fetchers': '2',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
    recovered: {
      'log.flush.interval.messages': '10000',
      'num.replica.fetchers': '2',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
  },
  liveness: {
    degraded: { ...HEALTHY_LIVENESS },
    recovering: { ...HEALTHY_LIVENESS },
    recovered: { ...HEALTHY_LIVENESS },
  },
};

// --- Broker-down scenario ---

const BROKER_DOWN_DATA: ScenarioData = {
  brokers: {
    degraded: [ALL_BROKERS[0], ALL_BROKERS[1], BROKER_DOWN_BROKER_2_DEAD],
    recovering: [...ALL_BROKERS],
    recovered: [...ALL_BROKERS],
  },
  partitions: {
    degraded: [
      // Partitions formerly led by broker 2 are now leaderless
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'orders', partition: 1, leader: -1, replicas: [2, 1, 0], isr: [1, 0], isUnderReplicated: true },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1], isUnderReplicated: true },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0], isUnderReplicated: true },
      { topic: 'events', partition: 2, leader: -1, replicas: [2, 0, 1], isr: [0, 1], isUnderReplicated: true },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'logs', partition: 1, leader: -1, replicas: [2, 1, 0], isr: [1, 0], isUnderReplicated: true },
    ],
    recovering: [
      // Unclean election done — leaders reassigned but some partitions still catching up
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'orders', partition: 1, leader: 1, replicas: [2, 1, 0], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [2, 0, 1], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1], isUnderReplicated: true },
      { topic: 'logs', partition: 1, leader: 1, replicas: [2, 1, 0], isr: [1, 0, 2], isUnderReplicated: false },
    ],
    recovered: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'orders', partition: 1, leader: 1, replicas: [2, 1, 0], isr: [2, 1, 0], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [2, 0, 1], isr: [2, 0, 1], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [2, 1, 0], isr: [2, 1, 0], isUnderReplicated: false },
    ],
  },
  consumerGroups: {
    degraded: [
      { groupId: 'order-processor', state: 'PreparingRebalance', members: 4, lag: 120_000 },
      { groupId: 'event-aggregator', state: 'PreparingRebalance', members: 3, lag: 85_000 },
      { groupId: 'log-shipper', state: 'PreparingRebalance', members: 2, lag: 40_000 },
    ],
    recovering: [
      { groupId: 'order-processor', state: 'CompletingRebalance', members: 4, lag: 25_000 },
      { groupId: 'event-aggregator', state: 'CompletingRebalance', members: 3, lag: 15_000 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 2_000 },
    ],
    recovered: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 80 },
      { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 40 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 15 },
    ],
  },
  brokerConfigs: { ...URP_DATA.brokerConfigs },
  liveness: {
    degraded: {
      0: HEALTHY_LIVENESS[0],
      1: HEALTHY_LIVENESS[1],
      2: { brokerId: 2, reachable: false, lastSeen: ts(10), diskUsagePercent: 0, cpuLoadPercent: 0, networkErrorRate: 1.0 },
    },
    recovering: { ...HEALTHY_LIVENESS },
    recovered: { ...HEALTHY_LIVENESS },
  },
};

// --- Consumer lag cascade scenario ---

const LAG_CASCADE_DATA: ScenarioData = {
  brokers: {
    degraded: [...ALL_BROKERS],
    recovering: [...ALL_BROKERS],
    recovered: [...ALL_BROKERS],
  },
  partitions: {
    degraded: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
    ],
    recovering: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
    ],
    recovered: [
      { topic: 'orders', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'orders', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
      { topic: 'events', partition: 0, leader: 0, replicas: [0, 2, 1], isr: [0, 2, 1], isUnderReplicated: false },
      { topic: 'events', partition: 1, leader: 1, replicas: [1, 0, 2], isr: [1, 0, 2], isUnderReplicated: false },
      { topic: 'events', partition: 2, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'metrics', partition: 0, leader: 1, replicas: [1, 0], isr: [1, 0], isUnderReplicated: false },
      { topic: 'logs', partition: 0, leader: 0, replicas: [0, 1, 2], isr: [0, 1, 2], isUnderReplicated: false },
      { topic: 'logs', partition: 1, leader: 1, replicas: [1, 2, 0], isr: [1, 2, 0], isUnderReplicated: false },
    ],
  },
  consumerGroups: {
    degraded: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 210_000 },
      { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 150_000 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 80_000 },
    ],
    recovering: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 18_000 },
      { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 9_000 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 1_500 },
    ],
    recovered: [
      { groupId: 'order-processor', state: 'Stable', members: 4, lag: 60 },
      { groupId: 'event-aggregator', state: 'Stable', members: 3, lag: 25 },
      { groupId: 'log-shipper', state: 'Stable', members: 2, lag: 10 },
    ],
  },
  brokerConfigs: {
    degraded: {
      'log.flush.interval.messages': '10000',
      'num.replica.fetchers': '1',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
    recovering: {
      'log.flush.interval.messages': '10000',
      'num.replica.fetchers': '4',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
    recovered: {
      'log.flush.interval.messages': '10000',
      'num.replica.fetchers': '4',
      'replica.lag.time.max.ms': '30000',
      'min.insync.replicas': '2',
      'default.replication.factor': '3',
    },
  },
  liveness: {
    degraded: { ...HEALTHY_LIVENESS },
    recovering: { ...HEALTHY_LIVENESS },
    recovered: { ...HEALTHY_LIVENESS },
  },
};

const SCENARIO_DATA: Record<KafkaScenario, ScenarioData> = {
  urp: URP_DATA,
  broker_down: BROKER_DOWN_DATA,
  consumer_lag_cascade: LAG_CASCADE_DATA,
};

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export class KafkaSimulator implements KafkaBackend {
  private state: SimulatorState = 'degraded';
  private readonly scenario: KafkaScenario;

  constructor(scenario: KafkaScenario = 'urp') {
    this.scenario = scenario;
  }

  getScenario(): KafkaScenario {
    return this.scenario;
  }

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  private data(): ScenarioData {
    return SCENARIO_DATA[this.scenario];
  }

  async getClusterMetadata(): Promise<KafkaClusterMetadata> {
    const brokers = this.data().brokers[this.state];
    const aliveBrokers = brokers.filter((b) => b.isAlive);
    return {
      clusterId: 'kafka-cluster-001',
      controllerId: 0,
      brokers,
      topicCount: 5,
      partitionCount: 24,
    };
  }

  async getTopicPartitions(_topic?: string): Promise<KafkaTopicPartition[]> {
    return this.data().partitions[this.state];
  }

  async getConsumerGroups(): Promise<KafkaConsumerGroup[]> {
    return this.data().consumerGroups[this.state];
  }

  async getUnderReplicatedPartitions(): Promise<KafkaTopicPartition[]> {
    const partitions = await this.getTopicPartitions();
    return partitions.filter((p) => p.isUnderReplicated);
  }

  async getBrokerConfigs(_brokerId: number): Promise<Record<string, string>> {
    return this.data().brokerConfigs[this.state];
  }

  async getBrokerLiveness(brokerId: number): Promise<BrokerLiveness> {
    const livenessMap = this.data().liveness[this.state];
    return livenessMap[brokerId] ?? {
      brokerId,
      reachable: false,
      lastSeen: ts(60),
      diskUsagePercent: 0,
      cpuLoadPercent: 0,
      networkErrorRate: 1.0,
    };
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
      case 'unclean_leader_elect':
        this.transition('recovering');
        return { electedPartitions: true, electionType: 'unclean' };
      case 'partition_reassign':
        this.transition('recovered');
        return { reassignedPartitions: true };
      case 'config_set':
        return { ok: true };
      case 'increase_replica_fetchers':
        this.transition('recovering');
        return { ok: true, newValue: parameters.count ?? 4 };
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
      return this.compare(meta.brokers.filter((b) => b.isAlive).length, check.expect.operator, check.expect.value);
    }

    if (stmt === 'leaderless_partition_count') {
      const partitions = await this.getTopicPartitions();
      const leaderless = partitions.filter((p) => p.leader === -1).length;
      return this.compare(leaderless, check.expect.operator, check.expect.value);
    }

    if (stmt.startsWith('broker_liveness:')) {
      const brokerId = Number(stmt.split(':')[1]);
      const liveness = await this.getBrokerLiveness(brokerId);
      return this.compare(liveness.reachable ? 1 : 0, check.expect.operator, check.expect.value);
    }

    if (stmt === 'consumer_group_rebalancing_count') {
      const groups = await this.getConsumerGroups();
      const rebalancing = groups.filter((g) => g.state !== 'Stable').length;
      return this.compare(rebalancing, check.expect.operator, check.expect.value);
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
}
