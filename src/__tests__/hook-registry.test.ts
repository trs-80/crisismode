// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from '../framework/hooks/registry.js';
import type { HookContext } from '../framework/hooks/types.js';

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

describe('HookRegistry', () => {
  it('fires a registered hook and receives the context', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register({
      name: 'test-hook',
      point: 'step:before',
      priority: 10,
      handler,
    });

    const ctx: HookContext = { step: makeStep('check-health') };
    await registry.fire('step:before', ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(ctx);
  });

  it('fires hooks in priority order (lowest first)', async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.register({
      name: 'hook-30',
      point: 'step:before',
      priority: 30,
      handler: async () => { order.push(30); },
    });
    registry.register({
      name: 'hook-10',
      point: 'step:before',
      priority: 10,
      handler: async () => { order.push(10); },
    });
    registry.register({
      name: 'hook-20',
      point: 'step:before',
      priority: 20,
      handler: async () => { order.push(20); },
    });

    await registry.fire('step:before', {});

    expect(order).toEqual([10, 20, 30]);
  });

  it('stops remaining hooks when one aborts', async () => {
    const registry = new HookRegistry();
    const secondHandler = vi.fn();

    registry.register({
      name: 'aborter',
      point: 'step:before',
      priority: 10,
      handler: async () => ({ abort: true, reason: 'test' }),
    });
    registry.register({
      name: 'after-abort',
      point: 'step:before',
      priority: 20,
      handler: secondHandler,
    });

    const result = await registry.fire('step:before', {});

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('test');
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it('catches handler errors without aborting and continues to next hook', async () => {
    const registry = new HookRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secondHandler = vi.fn();

    registry.register({
      name: 'broken-hook',
      point: 'step:before',
      priority: 10,
      handler: async () => { throw new Error('boom'); },
    });
    registry.register({
      name: 'good-hook',
      point: 'step:before',
      priority: 20,
      handler: secondHandler,
    });

    const result = await registry.fire('step:before', {});

    expect(result.abort).toBeFalsy();
    expect(secondHandler).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('removes a hook by name via unregister', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register({
      name: 'removable',
      point: 'step:before',
      priority: 10,
      handler,
    });

    registry.unregister('removable');
    await registry.fire('step:before', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('prevents removal of builtin hooks', async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register({
      name: 'core-hook',
      point: 'step:before',
      priority: 10,
      handler,
      source: 'builtin',
    });

    const removed = registry.unregister('core-hook');
    expect(removed).toBe(false);

    await registry.fire('step:before', {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it('lists all registered hooks and filters by point', () => {
    const registry = new HookRegistry();
    const noop = async () => {};

    registry.register({ name: 'h1', point: 'step:before', priority: 10, handler: noop });
    registry.register({ name: 'h2', point: 'step:after', priority: 10, handler: noop });
    registry.register({ name: 'h3', point: 'step:before', priority: 20, handler: noop });

    const all = registry.list();
    expect(all).toHaveLength(3);

    const beforeOnly = registry.list('step:before');
    expect(beforeOnly).toHaveLength(2);
    expect(beforeOnly.every(h => h.point === 'step:before')).toBe(true);
  });

  it('replaces hook with same name on re-registration', async () => {
    const registry = new HookRegistry();
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    registry.register({
      name: 'my-hook',
      point: 'step:before',
      priority: 10,
      handler: handlerA,
    });
    registry.register({
      name: 'my-hook',
      point: 'step:before',
      priority: 10,
      handler: handlerB,
    });

    await registry.fire('step:before', {});

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it('clear removes non-builtin hooks but keeps builtin ones', async () => {
    const registry = new HookRegistry();
    const builtinHandler = vi.fn();
    const userHandler = vi.fn();

    registry.register({
      name: 'builtin-hook',
      point: 'step:before',
      priority: 10,
      handler: builtinHandler,
      source: 'builtin',
    });
    registry.register({
      name: 'user-hook',
      point: 'step:before',
      priority: 20,
      handler: userHandler,
      source: 'user',
    });

    registry.clear();
    await registry.fire('step:before', {});

    expect(builtinHandler).toHaveBeenCalledOnce();
    expect(userHandler).not.toHaveBeenCalled();
  });

  it('returns empty result when firing a point with no hooks', async () => {
    const registry = new HookRegistry();
    const result = await registry.fire('step:before', {});

    expect(result).toEqual({});
  });
});
