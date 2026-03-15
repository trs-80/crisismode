// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Resolves credential references to actual values.
 */

import type { CredentialRef, ResolvedCredentials } from './schema.js';

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
