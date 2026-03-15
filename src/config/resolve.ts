// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Resolves SiteConfig targets into hydrated ResolvedTarget objects.
 */

import type { SiteConfig, ResolvedTarget, TargetConfig } from './schema.js';
import { resolveCredentials } from './credentials.js';

export function resolveTargets(config: SiteConfig): ResolvedTarget[] {
  return config.targets.map(resolveTarget);
}

export function resolveTarget(target: TargetConfig): ResolvedTarget {
  return {
    name: target.name,
    kind: target.kind,
    agent: target.agent,
    primary: target.primary,
    replicas: target.replicas ?? [],
    credentials: resolveCredentials(target.credentials),
  };
}

export function findTarget(config: SiteConfig, name: string): TargetConfig | undefined {
  return config.targets.find((t) => t.name === name);
}

export function findTargetsByKind(config: SiteConfig, kind: string): TargetConfig[] {
  return config.targets.filter((t) => t.kind === kind);
}
