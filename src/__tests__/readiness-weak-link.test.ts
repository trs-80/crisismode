// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { rankWeakLink, FANOUT_ASSUMPTIONS } from '../readiness/weak-link.js';
import type { CapacityCeiling, CeilingsResult } from '../readiness/types.js';

const ceiling = (over: Partial<CapacityCeiling>): CapacityCeiling => ({
  id: 'x', title: 'X', value: 100, unit: 'connections',
  evidenceClasses: ['declared'], evidence: [], caveat: 'at most', ...over,
});
const result = (ceilings: CapacityCeiling[]): CeilingsResult => ({ ceilings, omitted: [] });

describe('rankWeakLink', () => {
  it('converts db-throughput per fan-out assumption {1,3,10}', () => {
    const v = rankWeakLink(result([ceiling({ id: 'db-throughput', value: 2000, unit: 'queries/s', evidenceClasses: ['declared', 'measured'] })]));
    expect(FANOUT_ASSUMPTIONS).toEqual([1, 3, 10]);
    expect(v.conditional).toEqual([
      { queriesPerRequest: 1, bindingCeilingId: 'db-throughput', requestsPerSec: 2000 },
      { queriesPerRequest: 3, bindingCeilingId: 'db-throughput', requestsPerSec: 667 },
      { queriesPerRequest: 10, bindingCeilingId: 'db-throughput', requestsPerSec: 200 },
    ]);
    expect(v.binding).toBe('db-throughput');
    expect(v.note).toContain('conditional');
  });

  it('typical-class ceilings never determine the verdict', () => {
    const v = rankWeakLink(result([
      ceiling({ id: 'db-throughput', value: 2000, unit: 'queries/s', evidenceClasses: ['declared', 'measured'] }),
      ceiling({ id: 'node-typical', value: null, unit: 'requests/s', rangeLow: 10, rangeHigh: 20, evidenceClasses: ['typical'] }),
    ]));
    expect(v.binding).toBe('db-throughput');
    expect(v.conditional.every((c) => c.bindingCeilingId !== 'node-typical')).toBe(true);
  });

  it('no convertible ceilings -> binding null with explanatory note', () => {
    const v = rankWeakLink(result([ceiling({ id: 'redis-clients', value: 10000, unit: 'connections' })]));
    expect(v.binding).toBeNull();
    expect(v.conditional).toEqual([]);
    expect(v.note).toContain('no ceiling convertible');
  });

  it('note always states constraint migration', () => {
    const v = rankWeakLink(result([ceiling({ id: 'db-throughput', value: 300, unit: 'queries/s' })]));
    expect(v.note).toContain('next');
  });
});
