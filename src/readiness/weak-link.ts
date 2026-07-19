// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Weak-link verdict: rank the ceilings convertible to requests/sec. No
 * fan-out is measured in v1, so every conversion is CONDITIONAL on an
 * assumed queries-per-request from FANOUT_ASSUMPTIONS. `typical`-class
 * ceilings never participate in the verdict.
 */

import type { CeilingsResult } from './types.js';

/** Default conditional fan-out set from the spec (queries per request). */
export const FANOUT_ASSUMPTIONS: readonly number[] = [1, 3, 10];

export interface ConditionalBinding {
  queriesPerRequest: number;
  bindingCeilingId: string;
  requestsPerSec: number;
}

export interface WeakLinkVerdict {
  /** Ceiling id that binds across ALL assumptions, or null when it varies / nothing is convertible. */
  binding: string | null;
  conditional: ConditionalBinding[];
  note: string;
}

const MIGRATION_NOTE =
  'Fixing the first bottleneck promotes the next one — re-run after any change.';

export function rankWeakLink(result: CeilingsResult): WeakLinkVerdict {
  // v1: only queries/s ceilings are convertible to requests/s (÷ fan-out).
  const convertible = result.ceilings.filter(
    (c) => c.unit === 'queries/s' && c.value !== null && !c.evidenceClasses.includes('typical'),
  );

  if (convertible.length === 0) {
    return {
      binding: null,
      conditional: [],
      note: `no ceiling convertible to requests/s yet (needs a measured or declared throughput input). ${MIGRATION_NOTE}`,
    };
  }

  const conditional: ConditionalBinding[] = FANOUT_ASSUMPTIONS.map((q) => {
    let best = convertible[0]!;
    let bestRps = Math.round((best.value ?? 0) / q);
    for (const c of convertible.slice(1)) {
      const rps = Math.round((c.value ?? 0) / q);
      if (rps < bestRps) {
        best = c;
        bestRps = rps;
      }
    }
    return { queriesPerRequest: q, bindingCeilingId: best.id, requestsPerSec: bestRps };
  });

  const ids = new Set(conditional.map((c) => c.bindingCeilingId));
  return {
    binding: ids.size === 1 ? conditional[0]!.bindingCeilingId : null,
    conditional,
    note: `conditional — queries-per-request is assumed, not measured. ${MIGRATION_NOTE}`,
  };
}
