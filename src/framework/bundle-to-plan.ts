// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Bundle → RecoveryPlan translation.
 *
 * Takes an incident-generator AdapterRequest and AdapterResponse
 * pair and produces a CrisisMode `RecoveryPlan` that the engine
 * can execute (dry-run or live).
 *
 * Translation rules (Phase 1):
 *   - Each `proposed_action` is looked up in the action-template
 *     registry. Unknown action_ids are pushed to `rejected[]`.
 *   - Steps emitted by templates with `mutation_type !== "none"` are
 *     preceded by a `human_approval` step, because the bundle's
 *     `action_policy.requires_human_approval_for_mutation` is
 *     always true per schema.
 *   - Each plan carries metadata stamped from the bundle so forensic
 *     records can be joined back to the original incident_session.
 *   - A default `rollbackStrategy` of `none` is emitted; Phase 3 will
 *     replace this with template-driven rollbacks for mutating actions.
 */

import { randomUUID } from 'node:crypto';

import {
  getActionTemplate,
  registerBuiltInActionTemplates,
  templateToStep,
} from './action-template-registry.js';
import type { ActionTemplate } from '../types/action-template.js';
import type {
  AdapterRequest,
  AdapterResponse,
  ProposedAction,
} from '../types/evidence-bundle.js';
import type { RecoveryPlan, RollbackStrategy } from '../types/recovery-plan.js';
import type {
  HumanApprovalStep,
  HumanNotificationStep,
  RecoveryStep,
} from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';

const ADAPTER_AGENT_NAME = 'bundle-adapter';
const ADAPTER_AGENT_VERSION = '0.1.0';

export interface BundleToPlanOptions {
  /** Override new Date() (testing). */
  now?: () => Date;
  /** Override randomUUID for planId (testing). */
  uuid?: () => string;
  /** Skip the automatic built-in template registration. */
  skipBuiltinRegistration?: boolean;
}

export interface BundleToPlanResult {
  plan: RecoveryPlan;
  /** action_ids that couldn't be expanded into steps (with reason). */
  rejected: string[];
  /** Non-fatal observations during translation. */
  warnings: string[];
  /**
   * Maps generated `stepId` → originating bundle `action_id`. The
   * action-policy validation hook reads this map to enforce policy
   * at execute time; consumers that don't run hooks can ignore it.
   */
  stepIdToActionId: Record<string, string>;
}

/**
 * Convert an AdapterResponse + the originating AdapterRequest into a
 * RecoveryPlan. Always returns a plan, even when the response is
 * `abstained` or has no proposed_actions — in that case the plan is
 * empty (zero steps) and a warning is recorded.
 */
export function adapterResponseToPlan(
  request: AdapterRequest,
  response: AdapterResponse,
  options: BundleToPlanOptions = {},
): BundleToPlanResult {
  if (!options.skipBuiltinRegistration) {
    registerBuiltInActionTemplates();
  }

  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;

  const rejected: string[] = [];
  const warnings: string[] = [];
  const steps: RecoveryStep[] = [];
  const stepIdToActionId: Record<string, string> = {};

  let stepCounter = 0;
  const nextStepId = (): string => {
    stepCounter += 1;
    return `bundle-step-${String(stepCounter).padStart(3, '0')}`;
  };

  for (const action of response.proposed_actions) {
    const template = getActionTemplate(action.action_id);
    if (!template) {
      rejected.push(`${action.action_id} (no template registered)`);
      continue;
    }

    if (action.action_class !== template.action_class) {
      warnings.push(
        `${action.action_id}: response.action_class=${action.action_class} but template.action_class=${template.action_class}; using template`,
      );
    }
    if (action.mutation_type !== template.mutation_type) {
      warnings.push(
        `${action.action_id}: response.mutation_type=${action.mutation_type} but template.mutation_type=${template.mutation_type}; using template`,
      );
    }

    const target = pickTarget(action, template);
    if (!target) {
      rejected.push(`${action.action_id} (no target could be inferred)`);
      continue;
    }

    if (template.mutation_type !== 'none') {
      const approvalId = nextStepId();
      steps.push(buildApprovalStep(approvalId, action, template));
      stepIdToActionId[approvalId] = action.action_id;
    }

    const stepId = nextStepId();
    const step = templateToStep(template, {
      stepId,
      target,
      params: action.params,
      evidenceRefs: action.evidence_refs,
    });
    // Stamp the bundle session and supporting evidence into the step
    // description so the forensic record carries provenance.
    step.description = annotateProvenance(step.description, request, action);
    steps.push(step);
    stepIdToActionId[stepId] = action.action_id;
  }

  if (steps.length === 0) {
    warnings.push('No executable steps produced from bundle');
  }

  // The existing plan validator requires a human_notification step
  // whenever any step is elevated+. Inject one at the start so plans
  // produced from bundles pass validation without further patching.
  if (hasElevatedOrHigher(steps)) {
    const notification = buildNotificationStep(nextStepId(), request, response);
    steps.unshift(notification);
    // stepIdToActionId is only for bundle-originated steps; the
    // notification has no action_id, so we don't add it to the map.
  }

  const plan: RecoveryPlan = {
    apiVersion: 'crisismode/v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: uuid(),
      agentName: ADAPTER_AGENT_NAME,
      agentVersion: ADAPTER_AGENT_VERSION,
      scenario: scenarioLabel(request, response),
      createdAt: now().toISOString(),
      estimatedDuration: estimateDuration(steps),
      summary: buildSummary(request, response, steps.length),
      supersedes: null,
    },
    impact: {
      affectedSystems: deriveAffectedSystems(request, response),
      affectedServices: request.skill_domains,
      estimatedUserImpact:
        response.proposed_actions.length === 0
          ? 'No user impact — diagnostic-only plan.'
          : 'Bundle-driven recovery; impact bounded by action_policy.',
      dataLossRisk:
        steps.some((s) => s.type === 'system_action') ? 'low-to-unknown' : 'none',
    },
    steps,
    rollbackStrategy: deriveRollbackStrategy(steps),
  };

  return { plan, rejected, warnings, stepIdToActionId };
}

// ── helpers ──────────────────────────────────────────────────────────

function pickTarget(action: ProposedAction, template: ActionTemplate): string | null {
  if (typeof action.params.target === 'string' && action.params.target.length > 0) {
    return action.params.target;
  }
  // Fall back to the first declared target_kind as a generic identifier.
  if (template.target_kinds.length > 0) {
    return template.target_kinds[0];
  }
  return null;
}

function buildApprovalStep(
  stepId: string,
  action: ProposedAction,
  template: ActionTemplate,
): HumanApprovalStep {
  return {
    stepId,
    type: 'human_approval',
    name: `Approve: ${template.display_name}`,
    description:
      `Bundle action_policy requires human approval for any mutation. ` +
      `Action ${action.action_id} would ${template.description.toLowerCase()}`,
    approvers: [{ role: 'on_call', required: true }],
    requiredApprovals: 1,
    presentation: {
      summary: `Approve ${action.action_id} (${template.mutation_type})`,
      detail: action.summary,
      contextReferences: action.evidence_refs,
      proposedActions: [action.action_id],
      riskSummary: `class ${action.action_class} / ${template.mutation_type}`,
      alternatives: [
        { action: 'abort', description: 'Reject and abort the recovery plan.' },
      ],
    },
    timeout: 'PT15M',
    timeoutAction: 'pause',
  };
}

function annotateProvenance(
  existing: string | undefined,
  request: AdapterRequest,
  action: ProposedAction,
): string {
  const tag =
    `[bundle: incident_session=${request.incident_session_id}, case=${request.case_id}, ` +
    `evidence=${action.evidence_refs.length ? action.evidence_refs.join(',') : 'none'}]`;
  return existing && existing.length > 0 ? `${existing}\n${tag}` : tag;
}

function scenarioLabel(request: AdapterRequest, response: AdapterResponse): string {
  if (response.primary_hypothesis_id) {
    const h = response.hypotheses_ranked.find(
      (x) => x.hypothesis_id === response.primary_hypothesis_id,
    );
    if (h) return h.summary.slice(0, 120);
  }
  return `bundle:${request.case_id}`;
}

function buildSummary(
  request: AdapterRequest,
  response: AdapterResponse,
  stepCount: number,
): string {
  if (response.state === 'abstained') {
    return `Bundle ${request.case_id}: abstained (${response.abstention.reason ?? 'no reason given'})`;
  }
  return `Bundle ${request.case_id}: ${stepCount} step(s) from ${response.proposed_actions.length} proposed action(s)`;
}

function deriveAffectedSystems(
  request: AdapterRequest,
  response: AdapterResponse,
): RecoveryPlan['impact']['affectedSystems'] {
  // Derive from evidence_items adapters when no richer source exists.
  const systems = new Map<string, RecoveryPlan['impact']['affectedSystems'][number]>();
  for (const item of request.evidence_items) {
    const id = item.adapter_id.split('.')[0] ?? item.adapter_id;
    if (!systems.has(id)) {
      systems.set(id, {
        identifier: id,
        technology: id,
        role: 'observed',
        impactType:
          response.proposed_actions.length > 0 ? 'recovery_target' : 'observation_only',
      });
    }
  }
  return Array.from(systems.values());
}

// Bound the cumulative timeout sum to a sensible ceiling so a
// pathological bundle can't claim "60 hours" estimated duration.
const MAX_ESTIMATED_SECONDS = 3600;

function estimateDuration(steps: RecoveryStep[]): string {
  let totalSec = 0;
  for (const step of steps) {
    if (step.type === 'human_approval' || step.type === 'replanning_checkpoint' || step.type === 'checkpoint' || step.type === 'human_notification') {
      continue;
    }
    const t = ('timeout' in step ? step.timeout : undefined) as string | undefined;
    if (!t) continue;
    totalSec += parseIsoDurationToSeconds(t);
  }
  totalSec = Math.min(totalSec, MAX_ESTIMATED_SECONDS);
  if (totalSec === 0) return 'PT0S';
  return `PT${totalSec}S`;
}

function parseIsoDurationToSeconds(iso: string): number {
  // Minimal parser for the subset we emit: PT<n>S, PT<n>M, PT<n>H.
  const match = /^PT(\d+)([SMH])$/i.exec(iso);
  if (!match) return 0;
  const value = Number(match[1]);
  switch (match[2].toUpperCase()) {
    case 'S': return value;
    case 'M': return value * 60;
    case 'H': return value * 3600;
    default: return 0;
  }
}

function deriveRollbackStrategy(steps: RecoveryStep[]): RollbackStrategy {
  const hasMutation = steps.some((s) => s.type === 'system_action');
  if (!hasMutation) {
    return {
      type: 'none',
      description: 'Read-only plan; no rollback required.',
    };
  }
  const hasPerStepRollback = steps.some(
    (s) => s.type === 'system_action' && s.rollback !== undefined,
  );
  if (hasPerStepRollback) {
    return {
      type: 'stepwise',
      description:
        'Stepwise rollback: each mutating step carries its own rollback directive from its action template. Stop on first failure and execute rollbacks in reverse order.',
    };
  }
  return {
    type: 'stepwise',
    description:
      'Stop on first failure; mutating steps are routine-risk and can be undone by manual reversal of the underlying action.',
  };
}

function hasElevatedOrHigher(steps: RecoveryStep[]): boolean {
  return steps.some(
    (s) => s.type === 'system_action' && riskExceedsRoutine(s.riskLevel),
  );
}

function riskExceedsRoutine(risk: RiskLevel): boolean {
  return risk === 'elevated' || risk === 'high' || risk === 'critical';
}

function buildNotificationStep(
  stepId: string,
  request: AdapterRequest,
  response: AdapterResponse,
): HumanNotificationStep {
  const summary = response.primary_hypothesis_id
    ? `Bundle-driven recovery initiating for ${request.case_id}`
    : `Bundle-driven recovery initiating for ${request.case_id} (no primary hypothesis)`;
  return {
    stepId,
    type: 'human_notification',
    name: 'Notify on-call before elevated+ recovery actions',
    recipients: [{ role: 'on_call', urgency: 'high' }],
    message: {
      summary,
      detail:
        `Plan derived from incident-generator bundle ` +
        `incident_session=${request.incident_session_id}, case=${request.case_id}. ` +
        `${response.proposed_actions.length} proposed action(s); ` +
        `${response.unsafe_actions_avoided.length} unsafe action(s) avoided.`,
      contextReferences: response.evidence_refs.map((r) => r.evidence_id),
      actionRequired: false,
    },
    channel: 'auto',
  };
}
