// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from '../framework/hooks/registry.js';
import { registerBuiltinHooks } from '../framework/hooks/builtin.js';

function makeStep(name: string) {
  return {
    stepId: `step-${name}`,
    type: 'diagnosis_action' as const,
    name,
    executionContext: 'test',
    target: 'test-target',
    command: { type: 'structured_command' as const, operation: 'echo test' },
    timeout: '30s',
  };
}

describe('registerBuiltinHooks', () => {
  it('registers builtin hooks at expected points', () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry);

    const hooks = registry.list();
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every(h => h.source === 'builtin')).toBe(true);
  });

  it('builtin hooks cannot be removed', () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry);

    const hooks = registry.list();
    expect(hooks.length).toBeGreaterThan(0);

    for (const hook of hooks) {
      const removed = registry.unregister(hook.name);
      expect(removed).toBe(false);
    }
  });

  it('builtin logging hooks write to stderr on step:before', async () => {
    const registry = new HookRegistry();
    registerBuiltinHooks(registry);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const step = makeStep('restart-replica');
    await registry.fire('step:before', { step });

    expect(spy).toHaveBeenCalled();
    const messages = spy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(messages).toContain('restart-replica');

    spy.mockRestore();
  });
});
