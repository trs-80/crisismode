// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Action-template registry — owns the mapping between SRE-skills
 * `action_id` vocabulary and CrisisMode's typed recovery steps.
 *
 * Templates are data; this module provides the runtime registry plus
 * `templateToStep()` which expands a template + invocation args into
 * a `DiagnosisActionStep` or `SystemActionStep`.
 */

import type { ActionTemplate } from '../types/action-template.js';
import type {
  DiagnosisActionStep,
  SystemActionStep,
} from '../types/step-types.js';
import type { Command } from '../types/common.js';
import { BUILT_IN_TEMPLATES } from './action-templates.js';

export interface TemplateExpansionArgs {
  stepId: string;
  target: string;
  /** Action-specific params from the bundle's `proposed_action.params`. */
  params?: Record<string, unknown>;
  /** Optional Command override — when the template author wants the engine
   *  to run something specific. Most templates leave this empty and let the
   *  capability provider resolve the actual command. */
  command?: Command;
  /** Bundle `evidence_id`s that justified this step — recorded on the step
   *  for downstream forensic citations. */
  evidenceRefs?: string[];
}

class ActionTemplateRegistry {
  private templates = new Map<string, ActionTemplate>();

  register(template: ActionTemplate): void {
    if (this.templates.has(template.action_id)) {
      throw new Error(`Action template already registered: ${template.action_id}`);
    }
    if (template.step_type === 'system_action') {
      if (!template.risk_level) {
        throw new Error(
          `Template ${template.action_id} is system_action but missing risk_level`,
        );
      }
      if (!template.blast_radius) {
        throw new Error(
          `Template ${template.action_id} is system_action but missing blast_radius`,
        );
      }
      // Class 2+ mutating templates carry the full safety scaffold so the
      // existing validator (state preservation, rollback) accepts the
      // expanded plan without further patching.
      if (template.action_class >= 2) {
        if (template.risk_level === 'routine') {
          throw new Error(
            `Template ${template.action_id}: action_class >= 2 requires risk_level >= elevated`,
          );
        }
        if (!template.state_captures_before?.length) {
          throw new Error(
            `Template ${template.action_id}: action_class >= 2 requires state_captures_before`,
          );
        }
        if (!template.success_check) {
          throw new Error(
            `Template ${template.action_id}: action_class >= 2 requires success_check`,
          );
        }
        if (!template.rollback) {
          throw new Error(
            `Template ${template.action_id}: action_class >= 2 requires rollback`,
          );
        }
      }
    }
    this.templates.set(template.action_id, template);
  }

  get(action_id: string): ActionTemplate | null {
    return this.templates.get(action_id) ?? null;
  }

  has(action_id: string): boolean {
    return this.templates.has(action_id);
  }

  list(): ActionTemplate[] {
    return Array.from(this.templates.values());
  }

  listByDomain(skill_domain: string): ActionTemplate[] {
    return this.list().filter((t) => t.skill_domain === skill_domain);
  }

  clear(): void {
    this.templates.clear();
  }
}

const REGISTRY = new ActionTemplateRegistry();

/** Register a template. Throws on duplicate. */
export function registerActionTemplate(template: ActionTemplate): void {
  REGISTRY.register(template);
}

export function getActionTemplate(action_id: string): ActionTemplate | null {
  return REGISTRY.get(action_id);
}

export function hasActionTemplate(action_id: string): boolean {
  return REGISTRY.has(action_id);
}

export function listActionTemplates(): ActionTemplate[] {
  return REGISTRY.list();
}

export function listActionTemplatesByDomain(skill_domain: string): ActionTemplate[] {
  return REGISTRY.listByDomain(skill_domain);
}

/** Test-only — reset the global registry. */
export function resetActionTemplateRegistry(): void {
  REGISTRY.clear();
}

// ── Built-in templates ───────────────────────────────────────────────

let builtInsRegistered = false;

/**
 * Register all built-in templates. Idempotent — safe to call from
 * tests and CLI entry points without worrying about duplicate registration.
 */
export function registerBuiltInActionTemplates(): void {
  if (builtInsRegistered) return;
  for (const t of BUILT_IN_TEMPLATES) {
    REGISTRY.register(t);
  }
  builtInsRegistered = true;
}

/** Test-only — undo built-in registration so it can run again. */
export function resetBuiltInActionTemplates(): void {
  REGISTRY.clear();
  builtInsRegistered = false;
}

// ── Template expansion ──────────────────────────────────────────────

const NOOP_COMMAND: Command = { type: 'structured_command', operation: 'noop' };

/**
 * Expand a template + invocation args into a concrete recovery step.
 *
 * The expanded step is not yet wrapped in checkpoint / human_approval
 * gates — `bundle-to-plan.ts` (Phase 1) is responsible for assembling
 * the full plan with safety scaffolding.
 */
export function templateToStep(
  template: ActionTemplate,
  args: TemplateExpansionArgs,
): DiagnosisActionStep | SystemActionStep {
  if (template.step_type === 'diagnosis_action') {
    return buildDiagnosisStep(template, args);
  }
  return buildSystemActionStep(template, args);
}

function buildDiagnosisStep(
  template: ActionTemplate,
  args: TemplateExpansionArgs,
): DiagnosisActionStep {
  const step: DiagnosisActionStep = {
    stepId: args.stepId,
    type: 'diagnosis_action',
    name: template.display_name,
    description: template.description,
    executionContext: template.execution_context,
    target: args.target,
    command: args.command ?? NOOP_COMMAND,
    timeout: template.default_timeout,
  };
  // outputCapture is optional; templates that need it can pass via params
  // but the common case is read-and-discard.
  const captureName = typeof args.params?.outputCaptureName === 'string'
    ? args.params.outputCaptureName
    : undefined;
  if (captureName) {
    step.outputCapture = {
      name: captureName,
      format: 'table',
      availableTo: 'subsequent_steps',
    };
  }
  return step;
}

function buildSystemActionStep(
  template: ActionTemplate,
  args: TemplateExpansionArgs,
): SystemActionStep {
  // Type guard already enforced at register time, but re-check for safety.
  if (!template.risk_level || !template.blast_radius) {
    throw new Error(
      `Cannot build system_action without risk_level and blast_radius (${template.action_id})`,
    );
  }
  const step: SystemActionStep = {
    stepId: args.stepId,
    type: 'system_action',
    name: template.display_name,
    description: template.description,
    executionContext: template.execution_context,
    target: args.target,
    riskLevel: template.risk_level,
    requiredCapabilities: template.required_capabilities,
    command: args.command ?? NOOP_COMMAND,
    statePreservation: {
      before: template.state_captures_before ?? [],
      after: template.state_captures_after ?? [],
    },
    successCriteria: template.success_check ?? {
      description: `${template.display_name} reports completion`,
      check: {
        type: 'placeholder',
        expect: { operator: 'eq', value: true },
      },
    },
    blastRadius: template.blast_radius,
    timeout: template.default_timeout,
  };
  if (template.preconditions?.length) {
    step.preConditions = template.preconditions;
  }
  if (template.rollback) {
    step.rollback = template.rollback;
  }
  return step;
}
