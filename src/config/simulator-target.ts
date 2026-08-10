// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The one definition of "this target asks for the simulator".
 *
 * Owned here so live-registration.ts and simulator-registration.ts cannot
 * drift apart: both must agree on which targets are the demo/test path and
 * which name real infrastructure. The convention predates this module —
 * `primary.host === 'simulator'` is documented in config/schema.ts and
 * cli/service-targets.ts, and was already the discriminator in
 * live-registration.ts.
 *
 * The `!target.primary` arm is unreachable for config-loaded targets: every
 * target that comes through `resolveTarget()` (config/resolve.ts) has
 * `primary` populated, because that function stamps `{ host: 'aws', port: 0 }`
 * when the config omits it. The arm exists solely for `ResolvedTarget`s built
 * directly in code and in tests, which skip the resolver and may genuinely
 * have no `primary` — for those, nothing was pointed at, so the simulator is
 * the honest answer. Config-loaded targets that omit `primary` are a
 * different case and are handled downstream via `primaryDefaulted`, which is
 * how callers tell "no host configured" from "the host is literally `aws`".
 */

import type { ResolvedTarget } from './schema.js';

/** The reserved host that selects the in-memory backend. */
export const SIMULATOR_HOST = 'simulator';

export function isSimulatorTarget(target: ResolvedTarget): boolean {
  return !target.primary || target.primary.host === SIMULATOR_HOST;
}
