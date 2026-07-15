// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { RECOVERY_PLAN_API_VERSION } from './plan-helpers.js';

/**
 * API version declared by every built-in agent manifest. Aliases the recovery
 * plan API version so the manifest and plan schemas stay in lockstep.
 */
export const MANIFEST_API_VERSION = RECOVERY_PLAN_API_VERSION;

/**
 * Compatibility mode declared by every built-in recovery-agent plugin.
 */
export const RECOVERY_AGENT_COMPATIBILITY_MODE = 'recovery_agent' as const;

/**
 * Metadata fields identical across every built-in agent manifest. Spread into
 * each manifest's `metadata` block. Returns fresh arrays per call so no two
 * manifests share a mutable `authors` reference.
 */
export function defaultManifestMetadata(): { authors: string[]; license: string } {
  return {
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
  };
}
