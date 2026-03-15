// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * KafkaBackend — interface for querying Kafka cluster state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface KafkaBrokerInfo {
  id: number;
  host: string;
  port: number;
  rack: string;
  isController: boolean;
}

export interface KafkaTopicPartition {
  topic: string;
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  isUnderReplicated: boolean;
}

export interface KafkaConsumerGroup {
  groupId: string;
  state: 'Stable' | 'PreparingRebalance' | 'CompletingRebalance' | 'Empty' | 'Dead';
  members: number;
  lag: number;
}

export interface KafkaClusterMetadata {
  clusterId: string;
  controllerId: number;
  brokers: KafkaBrokerInfo[];
  topicCount: number;
  partitionCount: number;
}

export interface KafkaBackend extends ExecutionBackend {
  /** Get cluster-level metadata (brokers, controller, topic/partition counts) */
  getClusterMetadata(): Promise<KafkaClusterMetadata>;

  /** Get partition details, optionally filtered by topic */
  getTopicPartitions(topic?: string): Promise<KafkaTopicPartition[]>;

  /** Get all consumer groups with state and lag */
  getConsumerGroups(): Promise<KafkaConsumerGroup[]>;

  /** Get partitions where ISR < replicas */
  getUnderReplicatedPartitions(): Promise<KafkaTopicPartition[]>;

  /** Get broker configuration entries */
  getBrokerConfigs(brokerId: number): Promise<Record<string, string>>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
