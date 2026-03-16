// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Resolves credential references to actual values.
 * Validates that referenced environment variables exist at load time.
 */

import type { CredentialRef, ResolvedCredentials } from './schema.js';

export interface CredentialWarning {
  field: string;
  envVar: string;
  message: string;
}

/**
 * Validate credential references at load time.
 * Returns warnings for any env vars that are missing.
 */
export function validateCredentials(ref: CredentialRef | undefined): CredentialWarning[] {
  if (!ref) return [];

  const warnings: CredentialWarning[] = [];

  if (ref.type === 'env') {
    if (ref.username && !process.env[ref.username]) {
      warnings.push({
        field: 'username',
        envVar: ref.username,
        message: `Environment variable "${ref.username}" is not set (referenced by credential username)`,
      });
    }
    if (ref.password && !process.env[ref.password]) {
      warnings.push({
        field: 'password',
        envVar: ref.password,
        message: `Environment variable "${ref.password}" is not set (referenced by credential password)`,
      });
    }
    if (ref.key && !process.env[ref.key]) {
      warnings.push({
        field: 'token',
        envVar: ref.key,
        message: `Environment variable "${ref.key}" is not set (referenced by credential token)`,
      });
    }
  }

  if (ref.type === 'k8s-secret') {
    // K8s secrets fall back to env vars — warn if those aren't set
    if (ref.usernameKey && !process.env[ref.usernameKey]) {
      warnings.push({
        field: 'username',
        envVar: ref.usernameKey,
        message: `Environment variable "${ref.usernameKey}" is not set (K8s secret fallback for username)`,
      });
    }
    if (ref.passwordKey && !process.env[ref.passwordKey]) {
      warnings.push({
        field: 'password',
        envVar: ref.passwordKey,
        message: `Environment variable "${ref.passwordKey}" is not set (K8s secret fallback for password)`,
      });
    }
  }

  return warnings;
}

export function resolveCredentials(ref: CredentialRef | undefined): ResolvedCredentials {
  if (!ref) return {};

  switch (ref.type) {
    case 'env':
      return resolveEnvCredentials(ref);
    case 'value':
      return {
        username: ref.username,
        password: ref.password,
        token: ref.token,
      };
    case 'k8s-secret':
      // K8s secrets are resolved at runtime via the K8s API.
      // For now, fall back to env vars with a conventional naming pattern.
      return {
        username: ref.usernameKey ? process.env[ref.usernameKey] : undefined,
        password: ref.passwordKey ? process.env[ref.passwordKey] : undefined,
      };
  }
}

function resolveEnvCredentials(ref: { key?: string; username?: string; password?: string }): ResolvedCredentials {
  return {
    username: ref.username ? process.env[ref.username] : undefined,
    password: ref.password ? process.env[ref.password] : undefined,
    token: ref.key ? process.env[ref.key] : undefined,
  };
}
