// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Action-policy validation hook — enforces an incident-generator
 * `action_policy` against a translated `RecoveryPlan` at the
 * `plan:validate` lifecycle point.
 *
 * Why a hook rather than inline validation in bundle-to-plan?
 *   - bundle-to-plan generates plans. Plans can also be edited,
 *     persisted, replayed, or arrive from other sources before
 *     execution. A validation hook guarantees policy is checked at
 *     the engine boundary, no matter where the plan came from.
 *   - Hooks compose with existing safety checks (state preservation,
 *     blast radius, capability declarations) without touching engine
 *     code.
 *
 * Usage:
 *   ```ts
 *   const { plan, stepIdToActionId } = adapterResponseToPlan(req, res);
 *   const hook = createActionPolicyHook(req.action_policy, stepIdToActionId);
 *   hookRegistry.register(hook);
 *   // hookRegistry will abort plan:validate if the plan violates policy.
 *   ```
 */

import type { ActionPolicy } from '../../types/evidence-bundle.js';
import type { HookRegistration } from './types.js';
import {
  getActionTemplate,
  registerBuiltInActionTemplates,
} from '../action-template-registry.js';

export interface ActionPolicyHookOptions {
  /** Override the registration name (e.g. when applying multiple policies). */
  name?: string;
  /** Priority. Defaults to 50 — runs before community hooks, after built-ins. */
  priority?: number;
}

/**
 * Build a hook that enforces `policy` on plans whose steps are
 * mapped back to bundle action_ids via `stepIdToActionId`.
 *
 * The hook abstains (no abort) when the plan being validated has no
 * steps in `stepIdToActionId` — that is, when it's not a bundle-derived
 * plan. This makes the hook safe to leave registered globally.
 */
export function createActionPolicyHook(
  policy: ActionPolicy,
  stepIdToActionId: Record<string, string>,
  options: ActionPolicyHookOptions = {},
): HookRegistration {
  return {
    name: options.name ?? 'bundle:action-policy',
    point: 'plan:validate',
    priority: options.priority ?? 50,
    source: 'plugin',
    handler: async (ctx) => {
      const plan = ctx.plan;
      if (!plan) return;

      // Abstain on non-bundle plans: at least one step must map to
      // an action_id for this hook to apply.
      const knownSteps = plan.steps.filter((s) => s.stepId in stepIdToActionId);
      if (knownSteps.length === 0) return;

      registerBuiltInActionTemplates();

      const allowedIds = new Set(policy.allowed_action_ids);
      const allowedClasses = new Set<number>(policy.allowed_action_classes);
      const violations: string[] = [];

      // ── 1. Per-step action policy checks ──
      for (const step of knownSteps) {
        const actionId = stepIdToActionId[step.stepId];
        const template = getActionTemplate(actionId);
        if (!template) {
          violations.push(`${step.stepId}: unknown action template "${actionId}"`);
          continue;
        }
        if (template.action_class > policy.max_action_class) {
          violations.push(
            `${step.stepId} (${actionId}): action_class ${template.action_class} > max ${policy.max_action_class}`,
          );
        }
        if (!allowedClasses.has(template.action_class)) {
          violations.push(
            `${step.stepId} (${actionId}): action_class ${template.action_class} not in allowed_action_classes`,
          );
        }
        if (allowedIds.size > 0 && !allowedIds.has(actionId)) {
          violations.push(
            `${step.stepId} (${actionId}): not in allowed_action_ids whitelist`,
          );
        }
        if (
          !policy.proposed_actions_allowed &&
          step.type === 'system_action' &&
          template.mutation_type !== 'none'
        ) {
          violations.push(
            `${step.stepId} (${actionId}): mutating system_action when policy.proposed_actions_allowed=false`,
          );
        }
      }

      // ── 2. Approval-gate check for mutating steps ──
      // Every mutating system_action that maps to a bundle action_id
      // must be preceded somewhere in the plan by a human_approval
      // step. We check ordering: an approval at index i counts for
      // any mutating step at index > i.
      if (policy.requires_human_approval_for_mutation) {
        const steps = plan.steps;
        let seenApproval = false;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step.type === 'human_approval') {
            seenApproval = true;
            continue;
          }
          if (!(step.stepId in stepIdToActionId)) continue;
          const actionId = stepIdToActionId[step.stepId];
          const template = getActionTemplate(actionId);
          if (!template) continue;
          if (template.mutation_type === 'none') continue;
          if (step.type !== 'system_action') continue;
          if (!seenApproval) {
            violations.push(
              `${step.stepId} (${actionId}): mutating step lacks a preceding human_approval gate`,
            );
          }
        }
      }

      if (violations.length > 0) {
        return {
          abort: true,
          reason:
            'action_policy violations: ' +
            violations.join('; '),
        };
      }
    },
  };
}
