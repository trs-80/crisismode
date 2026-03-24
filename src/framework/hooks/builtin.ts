// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { HookRegistration } from './types.js';
import type { HookRegistry } from './registry.js';

/**
 * Register all built-in safety hooks.
 *
 * These wrap the existing safety functions (blast radius validation,
 * forensic recording, etc.) as hooks. They run at low priority numbers
 * to ensure they execute before any community hooks.
 *
 * Built-in hooks are informational only — the actual safety enforcement
 * still happens inline in the engine. These hooks provide extension points
 * for observability and additional cross-cutting concerns.
 */
export function registerBuiltinHooks(registry: HookRegistry): void {
  for (const hook of BUILTIN_HOOKS) {
    registry.register(hook);
  }
}

const BUILTIN_HOOKS: HookRegistration[] = [
  {
    name: 'builtin:plan-validation-log',
    point: 'plan:validate',
    priority: 10,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.plan) {
        const stepCount = ctx.plan.steps.length;
        const scenario = ctx.plan.metadata.scenario;
        console.error(`[hooks] Validating plan: ${scenario} (${stepCount} steps)`);
      }
    },
  },
  {
    name: 'builtin:step-execution-log',
    point: 'step:before',
    priority: 10,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.step) {
        console.error(`[hooks] Executing step: ${ctx.step.name} (${ctx.step.type})`);
      }
    },
  },
  {
    name: 'builtin:step-failure-log',
    point: 'step:failed',
    priority: 10,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.step && ctx.stepResult) {
        console.error(`[hooks] Step failed: ${ctx.step.name} — ${ctx.stepResult.error ?? 'unknown error'}`);
      }
    },
  },
  {
    name: 'builtin:recovery-summary',
    point: 'recovery:complete',
    priority: 90,
    source: 'builtin',
    handler: async (ctx) => {
      if (ctx.executionState) {
        const { completedSteps } = ctx.executionState;
        const succeeded = completedSteps.filter((s) => s.status === 'success').length;
        const failed = completedSteps.filter((s) => s.status === 'failed').length;
        console.error(`[hooks] Recovery complete: ${succeeded} succeeded, ${failed} failed`);
      }
    },
  },
];
