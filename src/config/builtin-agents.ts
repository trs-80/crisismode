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

export const builtinAgents: AgentRegistration[] = [
  pgReplicationRegistration,
  redisMemoryRegistration,
];
