// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * AgentRegistration — the contract for registering an agent with the registry.
 *
 * Each agent exports a lightweight registration descriptor containing its
 * manifest (cheap, just data) and an async factory that lazily imports the
 * heavy dependencies (drivers, clients) only when the agent is actually needed.
 */

import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { AgentManifest } from '../types/manifest.js';
import type { ResolvedTarget } from './schema.js';

export interface AgentInstance {
  agent: RecoveryAgent;
  backend: ExecutionBackend;
  target: ResolvedTarget;
}

export interface AgentRegistration {
  /** Target kind this agent handles (e.g. 'postgresql', 'redis', 'mysql') */
  kind: string;

  /** Unique agent name — must match manifest.metadata.name */
  name: string;

  /** Agent manifest (just data, no heavy imports) */
  manifest: AgentManifest;

  /** Where this registration originated — 'builtin' for core agents, 'plugin' for external */
  source?: 'builtin' | 'plugin';

  /**
   * Async factory — creates an agent + backend for a resolved target.
   * Use dynamic import() here to avoid eagerly loading drivers.
   */
  createAgent(target: ResolvedTarget): Promise<AgentInstance>;
}
