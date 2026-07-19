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

// ── AWS target config ──

export interface AwsTargetConfig {
  region: string;
  bucket?: string;       // aws-s3
  table?: string;        // aws-dynamodb
  instanceId?: string;   // aws-rds
  profile?: string;      // optional AWS profile override
}

// ── Kind-specific target options ──

export interface QueueTargetOptions {
  /** BullMQ queue names. Empty/absent = discover at connect time. */
  queueNames?: string[];
  /** BullMQ key prefix (default 'bull'). */
  keyPrefix?: string;
  /** Connect with TLS (set by derivation when the source URL scheme is rediss:). */
  tls?: boolean;
}

export interface ConfigDriftExpectation {
  /** Environment variable name or config file path */
  path: string;
  /** Expected value (null = should not be set) */
  expected: string | null;
  source: 'env' | 'file';
  masked?: boolean;
}

export interface ConfigDriftTargetOptions {
  /** Path to the env template file (default: auto-detect .env.example / .env.template). */
  envExamplePath?: string;
  /** Full value expectations declared in crisismode.yaml. */
  expectations?: ConfigDriftExpectation[];
}

// ── Target config ──

export interface TargetConfig {
  name: string;
  kind: string;
  /** Optional: pin this target to a specific agent by name (e.g. 'postgresql-replication-recovery') */
  agent?: string;
  /** Optional: target system version (e.g. '16.2'). Can be auto-discovered by backends that support it. */
  version?: string;
  primary?: HostConfig;
  replicas?: HostConfig[];
  credentials?: CredentialRef;
  /** AWS-specific config for aws-s3, aws-dynamodb, aws-rds target kinds. */
  aws?: AwsTargetConfig;
  /** BullMQ options for message-queue targets. */
  queue?: QueueTargetOptions;
  /** Drift-check options for application-config targets. */
  configDrift?: ConfigDriftTargetOptions;
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

  /** Declared infrastructure facts that cannot be probed (capacity ceilings). */
  network?: {
    /** Declared egress link speed in Mbps — used as a declared ceiling, never measured. */
    egressMbps?: number;
  } | undefined;

  targets: TargetConfig[];
}

// ── Resolved targets (credentials hydrated to actual values) ──

export interface ResolvedCredentials {
  username?: string | undefined;
  password?: string | undefined;
  token?: string | undefined;
}

export interface ResolvedTarget {
  name: string;
  kind: string;
  agent?: string | undefined;
  /** Target system version — from config or auto-discovered. */
  version?: string | undefined;
  primary: HostConfig;
  replicas: HostConfig[];
  credentials: ResolvedCredentials;
  /** AWS-specific config — passed through from TargetConfig. */
  aws?: AwsTargetConfig | undefined;
  /** BullMQ options for message-queue targets. */
  queue?: QueueTargetOptions | undefined;
  /** Drift-check options for application-config targets. */
  configDrift?: ConfigDriftTargetOptions | undefined;
}
