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
 * A missing `primary` counts as a simulator target too, because nothing was
 * pointed at. Note that `resolveTarget()` (config/resolve.ts) stamps
 * `{ host: 'aws', port: 0 }` on config-loaded targets that omit `primary`, so
 * in practice only directly-constructed targets reach here without one.
 */

import type { ResolvedTarget } from './schema.js';

/** The reserved host that selects the in-memory backend. */
export const SIMULATOR_HOST = 'simulator';

export function isSimulatorTarget(target: ResolvedTarget): boolean {
  return !target.primary || target.primary.host === SIMULATOR_HOST;
}
