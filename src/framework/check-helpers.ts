// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CheckExpression } from '../types/common.js';

/**
 * True when a check is a "declaratively unevaluable" no-op by construction,
 * rather than a real assertion a backend failed to recognize.
 *
 * `playbookToPlan()` (src/framework/playbook/runtime.ts) emits `type:
 * 'expression'` checks with no `statement` when a playbook step declares no
 * author-written precondition/success/condition text. The action-template
 * registry and built-in templates (src/framework/action-template-registry.ts,
 * src/framework/action-templates.ts) emit `type: 'placeholder'` and `type:
 * 'api_field'` checks the same way — `operation` describes intent, but there
 * is no `statement` for a backend to evaluate. These are the plan author's
 * explicit no-op: there was nothing to assert, not a bug.
 *
 * This is deliberately narrow: a missing `statement` on a `sql` or
 * `structured_command` check is NOT covered here — for those types a missing
 * statement is a plan-authoring bug, and must still reach the backend's
 * fail-closed default rather than being waved through.
 *
 * Every engine call site that evaluates a precondition, success criterion, or
 * conditional MUST route through this check before calling
 * `backend.evaluateCheck()`, treating a `true` result as "passed" — asking
 * the backend to answer a question it was never given the data to answer
 * would either hit an unrelated matched branch by accident or the fail-closed
 * default, neither of which reflects the author's intent.
 */
export function isDeclarativeNoOpCheck(check: CheckExpression): boolean {
  const hasStatement = typeof check.statement === 'string' && check.statement.trim().length > 0;
  if (hasStatement) return false;
  return check.type === 'expression' || check.type === 'placeholder' || check.type === 'api_field';
}

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
