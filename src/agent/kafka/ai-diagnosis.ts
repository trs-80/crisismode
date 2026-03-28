// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AI-powered diagnosis for Kafka cluster issues.
 *
 * Uses the framework AI diagnosis toolkit to analyze raw cluster state
 * and produce a structured diagnosis with root cause analysis.
 *
 * Falls back to rule-based diagnosis if:
 * - ANTHROPIC_API_KEY is not set
 * - The API call fails or times out (10s max)
 * - The response can't be parsed
 */

import { aiDiagnose as frameworkAiDiagnose } from '../../framework/ai-diagnosis.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type {
  BrokerLiveness,
  KafkaClusterMetadata,
  KafkaConsumerGroup,
  KafkaTopicPartition,
} from './backend.js';

export interface KafkaSystemState {
  clusterMetadata: KafkaClusterMetadata;
  partitions: KafkaTopicPartition[];
  consumerGroups: KafkaConsumerGroup[];
  brokerConfigs: Record<string, string>;
  brokerLiveness: BrokerLiveness[];
}

const KAFKA_SYSTEM_PROMPT = `You are a Kafka cluster reliability expert integrated into an automated recovery framework. Your job is to analyze raw Kafka cluster state and produce a structured diagnosis.

You will receive data from the Kafka admin client: cluster metadata, partition assignments with ISR, consumer group states with lag, broker configuration, and broker liveness probes.

Respond with ONLY a JSON object matching this exact schema — no markdown, no explanation, no wrapping:

{
  "status": "identified" | "investigating" | "inconclusive",
  "scenario": "broker_down" | "under_replicated_partitions" | "consumer_lag_cascade" | "partition_leader_imbalance" | "isr_shrink" | null,
  "confidence": <number between 0 and 1>,
  "root_cause": "<one paragraph explaining the most likely root cause>",
  "findings": [
    {
      "source": "<data source name>",
      "observation": "<what you observed>",
      "severity": "critical" | "warning" | "info",
      "evidence": "<specific data points that support this finding>"
    }
  ],
  "recommendations": ["<ordered list of recovery actions>"]
}

Guidelines:
- Check broker liveness first — an unreachable broker is the highest-priority signal
- Partitions with leader=-1 are LEADERLESS and indicate the preferred leader's broker is offline
- If multiple partitions have ISR missing the SAME broker, that broker is likely down or degraded
- High consumer lag with zero URPs suggests consumer-side throughput issues (slow processing, insufficient fetchers)
- Multiple consumer groups in PreparingRebalance simultaneously often indicates a broker failure cascade
- Check num.replica.fetchers — a value of 1 under heavy load can cause ISR shrink
- Look at min.insync.replicas vs actual ISR size — if ISR < min.insync.replicas, producers will fail
- Be specific about root cause — don't just restate the symptoms`;

function buildUserMessage(state: KafkaSystemState): string {
  const deadBrokers = state.brokerLiveness.filter((b) => !b.reachable);
  const leaderlessCount = state.partitions.filter((p) => p.leader === -1).length;
  const urpCount = state.partitions.filter((p) => p.isUnderReplicated).length;

  return `Analyze this Kafka cluster state:

## Cluster Metadata
Cluster ID: ${state.clusterMetadata.clusterId}
Controller: broker-${state.clusterMetadata.controllerId}
Brokers: ${state.clusterMetadata.brokers.length} (${deadBrokers.length} unreachable)
Topics: ${state.clusterMetadata.topicCount}, Partitions: ${state.clusterMetadata.partitionCount}
Leaderless partitions: ${leaderlessCount}
Under-replicated partitions: ${urpCount}

## Broker Liveness
${JSON.stringify(state.brokerLiveness, null, 2)}

## Partition State
${JSON.stringify(state.partitions, null, 2)}

## Consumer Groups
${JSON.stringify(state.consumerGroups, null, 2)}

## Broker Configuration (controller)
${JSON.stringify(state.brokerConfigs, null, 2)}

Produce your diagnosis.`;
}

export async function aiDiagnose(state: KafkaSystemState): Promise<DiagnosisResult | null> {
  return frameworkAiDiagnose({
    systemPrompt: KAFKA_SYSTEM_PROMPT,
    userMessage: buildUserMessage(state),
  });
}
