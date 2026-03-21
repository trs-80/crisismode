// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Local health agents — always-on system checks that run without explicit config.
 *
 * Some agents monitor local system health (DNS resolvers, disk usage) and don't
 * require user-configured targets. These are injected into every scan automatically,
 * giving users immediate value without running `crisismode init`.
 */

import type { TargetConfig } from '../config/schema.js';

/** Targets that are always injected into scans (local system health checks). */
export const LOCAL_HEALTH_TARGETS: TargetConfig[] = [
  {
    name: 'local-dns',
    kind: 'dns',
    primary: { host: 'auto', port: 53 },
  },
  {
    name: 'local-disk',
    kind: 'disk',
    primary: { host: 'auto', port: 0 },
  },
];

/**
 * Merge local health targets into an existing target list,
 * skipping any kinds the user has already configured.
 */
export function mergeLocalTargets(userTargets: TargetConfig[]): TargetConfig[] {
  const configuredKinds = new Set(userTargets.map((t) => t.kind));

  const newLocals = LOCAL_HEALTH_TARGETS.filter((lt) => !configuredKinds.has(lt.kind));

  return [...userTargets, ...newLocals];
}

/** Agent kinds that are available but require explicit configuration (not auto-injected). */
const CONFIG_ONLY_KINDS = ['tls'];

/**
 * Return a list of agent kinds the user hasn't configured yet.
 * Used to print a helpful hint after scan results.
 */
export function unconfiguredAgentHints(configuredKinds: Set<string>): string[] {
  const hints: string[] = [];

  for (const kind of CONFIG_ONLY_KINDS) {
    if (!configuredKinds.has(kind)) {
      hints.push(kind);
    }
  }

  return hints;
}
