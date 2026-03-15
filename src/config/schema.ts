// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * TypeScript types for crisismode.yaml site configuration.
 */

import type { ExecutionMode } from '../framework/engine.js';

// ── Credential references ──

export interface EnvCredentialRef {
  type: 'env';
  key?: string;        // single env var (e.g. for tokens)
  username?: string;    // env var name for username
  password?: string;    // env var name for password
}

export interface K8sSecretCredentialRef {
  type: 'k8s-secret';
  name: string;
  namespace?: string;
  usernameKey?: string;
  passwordKey?: string;
}

export interface ValueCredentialRef {
  type: 'value';
  username?: string;
  password?: string;
  token?: string;
}

export type CredentialRef = EnvCredentialRef | K8sSecretCredentialRef | ValueCredentialRef;

// ── Host config ──

export interface HostConfig {
  host: string;
  port: number;
  database?: string;
}

// ── Target config ──

export interface TargetConfig {
  name: string;
  kind: string;
  /** Optional: pin this target to a specific agent by name (e.g. 'postgresql-replication-recovery') */
  agent?: string;
  /** Optional: target system version (e.g. '16.2'). Can be auto-discovered by backends that support it. */
  version?: string;
  primary: HostConfig;
  replicas?: HostConfig[];
  credentials?: CredentialRef;
}

// ── Site config ──

export interface SiteConfig {
  apiVersion: 'crisismode/v1';
  kind: 'SiteConfig';

  metadata: {
    name: string;
    environment?: 'production' | 'staging' | 'development';
  };

  hub?: {
    endpoint: string;
    credentials?: CredentialRef;
  };

  webhook?: {
    port: number;
    secret?: CredentialRef;
  };

  execution?: {
    mode: ExecutionMode;
  };

  targets: TargetConfig[];
}

// ── Resolved targets (credentials hydrated to actual values) ──

export interface ResolvedCredentials {
  username?: string;
  password?: string;
  token?: string;
}

export interface ResolvedTarget {
  name: string;
  kind: string;
  agent?: string;
  /** Target system version — from config or auto-discovered. */
  version?: string;
  primary: HostConfig;
  replicas: HostConfig[];
  credentials: ResolvedCredentials;
}
