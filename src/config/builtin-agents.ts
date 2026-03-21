// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Built-in agent registrations.
 *
 * This is the ONE file you edit when adding a new agent to CrisisMode.
 * Each import pulls in only the manifest (data) and a lazy factory function —
 * heavy dependencies (pg driver, redis client, etc.) are loaded on demand.
 */

import type { AgentRegistration } from './agent-registration.js';
import { pgReplicationRegistration } from '../agent/pg-replication/registration.js';
import { redisMemoryRegistration } from '../agent/redis/registration.js';
import { etcdRecoveryRegistration } from '../agent/etcd/registration.js';
import { kafkaRecoveryRegistration } from '../agent/kafka/registration.js';
import { k8sRecoveryRegistration } from '../agent/kubernetes/registration.js';
import { cephStorageRegistration } from '../agent/ceph/registration.js';
import { flinkRecoveryRegistration } from '../agent/flink/registration.js';
import { deployRollbackRegistration } from '../agent/deploy-rollback/registration.js';
import { aiProviderRegistration } from '../agent/ai-provider/registration.js';
import { dbMigrationRegistration } from '../agent/db-migration/registration.js';
import { queueBacklogRegistration } from '../agent/queue-backlog/registration.js';
import { configDriftRegistration } from '../agent/config-drift/registration.js';
import { dnsRecoveryRegistration } from '../agent/dns/registration.js';
import { tlsRecoveryRegistration } from '../agent/tls/registration.js';
import { diskExhaustionRegistration } from '../agent/disk/registration.js';

export const builtinAgents: AgentRegistration[] = [
  // Infrastructure agents
  pgReplicationRegistration,
  redisMemoryRegistration,
  etcdRecoveryRegistration,
  kafkaRecoveryRegistration,
  k8sRecoveryRegistration,
  cephStorageRegistration,
  flinkRecoveryRegistration,
  dnsRecoveryRegistration,
  tlsRecoveryRegistration,
  diskExhaustionRegistration,
  // AI application recovery agents
  deployRollbackRegistration,
  aiProviderRegistration,
  dbMigrationRegistration,
  queueBacklogRegistration,
  configDriftRegistration,
];
