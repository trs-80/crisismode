// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { HookPoint, HookContext, HookResult, HookRegistration } from './types.js';

/**
 * Registry for lifecycle hooks. Hooks are fired at specific points during
 * plan execution and can observe or abort the pipeline.
 *
 * Hook handlers are called in priority order (lower runs first).
 * Errors in handlers are caught and logged — they never break execution.
 */
export class HookRegistry {
  private hooks: Map<HookPoint, HookRegistration[]> = new Map();

  /**
   * Register a hook handler for a lifecycle point.
   * Re-registering a hook with the same name replaces the previous one.
   */
  register(registration: HookRegistration): void {
    // Remove any existing hook with the same name (replacement semantics)
    for (const [point, list] of this.hooks) {
      const filtered = list.filter((h) => h.name !== registration.name);
      if (filtered.length === 0) {
        this.hooks.delete(point);
      } else if (filtered.length !== list.length) {
        this.hooks.set(point, filtered);
      }
    }

    const list = this.hooks.get(registration.point) ?? [];
    list.push(registration);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(registration.point, list);
  }

  /**
   * Remove a hook by name. Returns false if the hook is builtin
   * (builtin hooks cannot be removed) or if no hook was found.
   */
  unregister(name: string): boolean {
    let found = false;
    for (const list of this.hooks.values()) {
      const hook = list.find((h) => h.name === name);
      if (hook) {
        if (hook.source === 'builtin') {
          return false;
        }
        found = true;
      }
    }

    if (!found) return false;

    for (const [point, list] of this.hooks) {
      const filtered = list.filter((h) => h.name !== name);
      if (filtered.length === 0) {
        this.hooks.delete(point);
      } else if (filtered.length !== list.length) {
        this.hooks.set(point, filtered);
      }
    }

    return true;
  }

  /**
   * Remove all non-builtin hooks. Builtin hooks are preserved.
   */
  clear(): void {
    for (const [point, list] of this.hooks) {
      const builtins = list.filter((h) => h.source === 'builtin');
      if (builtins.length === 0) {
        this.hooks.delete(point);
      } else {
        this.hooks.set(point, builtins);
      }
    }
  }

  /**
   * Fire all hooks registered for the given point, in priority order.
   * Returns the first abort result, or a non-abort result if all pass.
   */
  async fire(point: HookPoint, context: HookContext): Promise<HookResult> {
    const list = this.hooks.get(point);
    if (!list || list.length === 0) {
      return {};
    }

    for (const registration of list) {
      try {
        const result = await registration.handler(context);
        if (result?.abort) {
          return result;
        }
      } catch (err) {
        console.error(`Hook "${registration.name}" threw at "${point}":`, err);
      }
    }

    return {};
  }

  /**
   * List all registered hooks, optionally filtered by point.
   */
  list(point?: HookPoint): ReadonlyArray<Omit<HookRegistration, 'handler'>> {
    const result: Omit<HookRegistration, 'handler'>[] = [];
    for (const [hookPoint, list] of this.hooks) {
      if (point && hookPoint !== point) continue;
      for (const { handler: _h, ...rest } of list) {
        result.push(rest);
      }
    }
    return result;
  }
}
