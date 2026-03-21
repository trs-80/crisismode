// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared comparison helper for evaluateCheck() implementations.
 * Every simulator and live client uses this to compare actual vs expected values.
 */
export function compareCheckValue(actual: unknown, operator: string, expected: unknown): boolean {
  const a = Number(actual);
  const e = Number(expected);

  if (Number.isNaN(a) || Number.isNaN(e)) {
    const sa = String(actual);
    const se = String(expected);
    switch (operator) {
      case 'eq': return sa === se;
      case 'neq': return sa !== se;
      default: return false;
    }
  }

  switch (operator) {
    case 'eq': return a === e;
    case 'neq': return a !== e;
    case 'gt': return a > e;
    case 'gte': return a >= e;
    case 'lt': return a < e;
    case 'lte': return a <= e;
    default: return false;
  }
}
