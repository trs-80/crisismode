// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerActionTemplate,
  getActionTemplate,
  hasActionTemplate,
  listActionTemplates,
  listActionTemplatesByDomain,
  resetBuiltInActionTemplates,
  registerBuiltInActionTemplates,
  templateToStep,
} from '../framework/action-template-registry.js';
import type { ActionTemplate } from '../types/action-template.js';

const READ_TEMPLATE: ActionTemplate = {
  action_id: 'test_inspect_x',
  display_name: 'Test read template',
  description: 'A test read-only template',
  skill_domain: 'test_domain',
  action_class: 0,
  mutation_type: 'none',
  step_type: 'diagnosis_action',
  target_kinds: ['linux'],
  required_capabilities: ['test.read'],
  execution_context: 'test_read',
  default_timeout: 'PT15S',
};

const MUTATING_TEMPLATE: ActionTemplate = {
  action_id: 'test_mutate_x',
  display_name: 'Test mutating template',
  description: 'A test mutating template',
  skill_domain: 'test_domain',
  action_class: 2,
  mutation_type: 'state_mutation',
  step_type: 'system_action',
  target_kinds: ['linux'],
  required_capabilities: ['test.write'],
  execution_context: 'test_write',
  default_timeout: 'PT60S',
  risk_level: 'elevated',
  blast_radius: {
    directComponents: ['test_target'],
    indirectComponents: [],
    maxImpact: 'test',
    cascadeRisk: 'low',
  },
  state_captures_before: [
    {
      name: 'before_state',
      captureType: 'command_output',
      captureCost: 'negligible',
      capturePolicy: 'required',
    },
  ],
  state_captures_after: [],
  success_check: {
    description: 'mutation reports success',
    check: { type: 'placeholder', expect: { operator: 'eq', value: true } },
  },
  rollback: {
    type: 'manual',
    description: 'Manual rollback required.',
  },
};

describe('action-template-registry', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('registers and retrieves a template', () => {
    registerActionTemplate(READ_TEMPLATE);
    expect(hasActionTemplate('test_inspect_x')).toBe(true);
    expect(getActionTemplate('test_inspect_x')?.display_name).toBe('Test read template');
  });

  it('returns null for unknown action_id', () => {
    expect(getActionTemplate('nonexistent')).toBeNull();
    expect(hasActionTemplate('nonexistent')).toBe(false);
  });

  it('throws on duplicate registration', () => {
    registerActionTemplate(READ_TEMPLATE);
    expect(() => registerActionTemplate(READ_TEMPLATE)).toThrow(/already registered/);
  });

  it('rejects system_action template missing risk_level', () => {
    const bad: ActionTemplate = { ...MUTATING_TEMPLATE, risk_level: undefined };
    expect(() => registerActionTemplate(bad)).toThrow(/risk_level/);
  });

  it('rejects system_action template missing blast_radius', () => {
    const bad: ActionTemplate = { ...MUTATING_TEMPLATE, blast_radius: undefined };
    expect(() => registerActionTemplate(bad)).toThrow(/blast_radius/);
  });

  it('lists templates by skill_domain', () => {
    registerActionTemplate(READ_TEMPLATE);
    registerActionTemplate(MUTATING_TEMPLATE);
    const matches = listActionTemplatesByDomain('test_domain');
    expect(matches).toHaveLength(2);
    expect(listActionTemplatesByDomain('other')).toHaveLength(0);
  });

  it('lists all registered templates', () => {
    registerActionTemplate(READ_TEMPLATE);
    expect(listActionTemplates()).toHaveLength(1);
    registerActionTemplate(MUTATING_TEMPLATE);
    expect(listActionTemplates()).toHaveLength(2);
  });
});

describe('registerBuiltInActionTemplates', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('registers all built-ins on first call', () => {
    registerBuiltInActionTemplates();
    const templates = listActionTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(7);
    const ids = templates.map((t) => t.action_id);
    expect(ids).toContain('inspect_service_logs');
    expect(ids).toContain('inspect_database_pool');
    expect(ids).toContain('inspect_k8s_pods');
    expect(ids).toContain('capture_state_snapshot');
  });

  it('is idempotent', () => {
    registerBuiltInActionTemplates();
    const first = listActionTemplates().length;
    registerBuiltInActionTemplates();
    expect(listActionTemplates()).toHaveLength(first);
  });

  it('seeds a mix of class 0/1 and class 2/3 templates', () => {
    registerBuiltInActionTemplates();
    const classes = new Set(listActionTemplates().map((t) => t.action_class));
    expect(classes.has(0)).toBe(true);
    expect(classes.has(1)).toBe(true);
    expect(classes.has(2) || classes.has(3)).toBe(true);
  });

  it('class 2+ built-ins carry full safety scaffolding', () => {
    registerBuiltInActionTemplates();
    const mutators = listActionTemplates().filter((t) => t.action_class >= 2);
    expect(mutators.length).toBeGreaterThan(0);
    for (const t of mutators) {
      expect(t.step_type).toBe('system_action');
      expect(['elevated', 'high', 'critical']).toContain(t.risk_level);
      expect(t.state_captures_before?.length).toBeGreaterThan(0);
      expect(t.success_check).toBeDefined();
      expect(t.rollback).toBeDefined();
    }
  });

  it('every built-in target_kinds matches an existing CrisisMode kind family', () => {
    registerBuiltInActionTemplates();
    const allowedKinds = new Set([
      'linux',
      'kubernetes',
      'service',
      'postgresql',
      'mysql',
      'redis',
      'kafka',
      'dns',
    ]);
    for (const t of listActionTemplates()) {
      for (const k of t.target_kinds) {
        expect(allowedKinds.has(k)).toBe(true);
      }
    }
  });
});

describe('templateToStep', () => {
  beforeEach(() => {
    resetBuiltInActionTemplates();
  });

  it('expands a read template into a DiagnosisActionStep', () => {
    registerActionTemplate(READ_TEMPLATE);
    const step = templateToStep(READ_TEMPLATE, {
      stepId: 'step-1',
      target: 'svc-checkout',
    });
    expect(step.type).toBe('diagnosis_action');
    if (step.type !== 'diagnosis_action') return;
    expect(step.stepId).toBe('step-1');
    expect(step.target).toBe('svc-checkout');
    expect(step.executionContext).toBe('test_read');
    expect(step.timeout).toBe('PT15S');
    expect(step.outputCapture).toBeUndefined();
  });

  it('honors outputCaptureName param', () => {
    registerActionTemplate(READ_TEMPLATE);
    const step = templateToStep(READ_TEMPLATE, {
      stepId: 'step-1',
      target: 'svc',
      params: { outputCaptureName: 'pool_metrics' },
    });
    if (step.type !== 'diagnosis_action') throw new Error('wrong step type');
    expect(step.outputCapture?.name).toBe('pool_metrics');
  });

  it('expands a mutating template into a SystemActionStep with safety scaffolding', () => {
    registerActionTemplate(MUTATING_TEMPLATE);
    const step = templateToStep(MUTATING_TEMPLATE, {
      stepId: 'step-1',
      target: 'pg-primary',
    });
    expect(step.type).toBe('system_action');
    if (step.type !== 'system_action') return;
    expect(step.riskLevel).toBe('elevated');
    expect(step.requiredCapabilities).toEqual(['test.write']);
    expect(step.blastRadius.directComponents).toEqual(['test_target']);
    expect(step.statePreservation.before).toHaveLength(1);
    expect(step.statePreservation.before[0].name).toBe('before_state');
    expect(step.successCriteria.description).toContain('reports success');
    expect(step.rollback?.type).toBe('manual');
  });

  it('accepts a Command override', () => {
    registerActionTemplate(READ_TEMPLATE);
    const step = templateToStep(READ_TEMPLATE, {
      stepId: 'step-1',
      target: 'svc',
      command: { type: 'sql', statement: 'SELECT 1' },
    });
    if (step.type !== 'diagnosis_action') throw new Error('wrong step type');
    expect(step.command.type).toBe('sql');
    expect(step.command.statement).toBe('SELECT 1');
  });

  it('produces steps that pass the type-system shape check', () => {
    registerBuiltInActionTemplates();
    for (const t of listActionTemplates()) {
      const step = templateToStep(t, { stepId: `s-${t.action_id}`, target: 'tgt' });
      expect(step.stepId).toBe(`s-${t.action_id}`);
      expect(step.name).toBe(t.display_name);
      expect(step.target).toBe('tgt');
      expect(step.timeout).toBe(t.default_timeout);
    }
  });
});
