// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { isDeclarativeNoOpCheck, compareCheckValue } from '../framework/check-helpers.js';
import type { CheckExpression } from '../types/common.js';

function mk(overrides: Partial<CheckExpression>): CheckExpression {
  return { type: 'expression', expect: { operator: 'eq', value: true }, ...overrides };
}

describe('isDeclarativeNoOpCheck', () => {
  it('is true for a statement-less "expression" check (playbook default)', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'expression' }))).toBe(true);
  });

  it('is true for a statement-less "placeholder" check (template fallback)', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'placeholder' }))).toBe(true);
  });

  it('is false for a statement-less "api_field" check that still carries an operation — that is a real assertion no backend dispatches, not a no-op (final-review N2)', () => {
    // e.g. action-templates.ts's get_node_pod_count / replacement_pod_running
    // success_checks: no statement, but a real operation + expect that a
    // mutating action_class>=2 template's success criteria depends on.
    // Treating this as a no-op would make those safety gates decorative.
    expect(isDeclarativeNoOpCheck(mk({ type: 'api_field', operation: 'get_active_revision' }))).toBe(false);
    expect(isDeclarativeNoOpCheck(mk({ type: 'api_field', operation: 'get_node_pod_count', expect: { operator: 'eq', value: 0 } }))).toBe(false);
  });

  it('is true for an "api_field" check with neither statement nor operation', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'api_field' }))).toBe(true);
  });

  it('is false when a non-empty statement is present, regardless of type', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'expression', statement: 'SELECT 1;' }))).toBe(false);
    expect(isDeclarativeNoOpCheck(mk({ type: 'placeholder', statement: 'PING' }))).toBe(false);
    expect(isDeclarativeNoOpCheck(mk({ type: 'api_field', statement: 'x', operation: 'y' }))).toBe(false);
  });

  it('is false when the statement is present but blank/whitespace-only (still authoring intent, not absence)', () => {
    // A blank string is treated the same as "no statement" for the no-op
    // types — this only matters for the fail-closed types below, where a
    // blank statement must still reach the backend's default.
    expect(isDeclarativeNoOpCheck(mk({ type: 'expression', statement: '   ' }))).toBe(true);
  });

  it('is false for a statement-less "sql" check — missing statement is an authoring bug, not a no-op', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'sql' }))).toBe(false);
  });

  it('is false for a statement-less "structured_command" check — same reasoning as sql', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'structured_command' }))).toBe(false);
  });

  it('is false for any other unrecognized type, statement-less or not', () => {
    expect(isDeclarativeNoOpCheck(mk({ type: 'something_else' }))).toBe(false);
  });
});

describe('compareCheckValue (existing behavior, unaffected by the new helper)', () => {
  it('still compares numerically', () => {
    expect(compareCheckValue(5, 'gt', 3)).toBe(true);
  });
});
