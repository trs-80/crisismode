// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import type { Command, RiskLevel, Urgency, TimeoutAction } from '../../types/common.js';
import type { AgentManifest } from '../../types/manifest.js';
import type { ParsedPlaybook, PlaybookCodeBlock, PlaybookStep } from './types.js';
import { RISK_ORDER } from '../risk.js';
import { MANIFEST_API_VERSION } from '../manifest-defaults.js';

function buildCommandFromCodeBlocks(codeBlocks: PlaybookCodeBlock[]): Command | null {
  if (codeBlocks.length === 0) return null;
  const block = codeBlocks[0]!;
  if (block.lang === 'sql') {
    return { type: 'sql', statement: block.content };
  }
  return { type: 'structured_command', operation: block.content };
}

function mapRiskToUrgency(risk?: string): Urgency {
  switch (risk) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'elevated':
      return 'medium';
    default:
      return 'low';
  }
}

function convertStep(playbook: ParsedPlaybook, step: PlaybookStep): RecoveryStep {
  const stepId = `${playbook.frontmatter.name}-step-${step.position}`;

  switch (step.type) {
    case 'diagnosis_action':
      return {
        stepId,
        type: 'diagnosis_action',
        name: step.title,
        description: step.description ?? step.body.trim(),
        executionContext: step.executionContext ?? 'default',
        target: step.target ?? 'primary',
        command: buildCommandFromCodeBlocks(step.codeBlocks) ?? { type: 'structured_command', operation: step.title },
        timeout: step.timeout ?? '60s',
      };

    case 'human_notification':
      return {
        stepId,
        type: 'human_notification',
        name: step.title,
        recipients: [{ role: 'oncall', urgency: mapRiskToUrgency(step.risk) }],
        message: {
          summary: step.message ?? step.title,
          detail: step.body.trim(),
          actionRequired: false,
        },
        channel: step.channel ?? 'default',
      };

    case 'checkpoint':
      return {
        stepId,
        type: 'checkpoint',
        name: step.title,
        description: step.description ?? step.body.trim(),
        stateCaptures: [
          {
            name: `checkpoint-${step.position}`,
            captureType: 'command_output',
            captureCost: 'negligible',
            capturePolicy: 'best_effort',
          },
        ],
      };

    case 'system_action':
      return {
        stepId,
        type: 'system_action',
        name: step.title,
        description: step.description ?? step.body.trim(),
        executionContext: step.executionContext ?? 'default',
        target: step.target ?? 'primary',
        riskLevel: (step.risk as RiskLevel) ?? 'routine',
        requiredCapabilities: step.capabilities ?? [],
        command: buildCommandFromCodeBlocks(step.codeBlocks) ?? { type: 'structured_command', operation: step.title },
        statePreservation: {
          // Author-declared captures are 'required': if the playbook says
          // state must be preserved, a failed capture blocks the step.
          before: (step.preserve ?? []).map((name) => ({
            name,
            captureType: 'command_output' as const,
            captureCost: 'negligible' as const,
            capturePolicy: 'required' as const,
          })),
          after: [],
        },
        successCriteria: step.success
          ? { description: step.success, check: { type: 'expression', expect: { operator: 'eq', value: true } } }
          : {
              description: 'Step completed',
              check: { type: 'expression', expect: { operator: 'eq', value: true } },
            },
        blastRadius: step.blastRadius
          ? {
              directComponents: [step.target ?? 'primary'],
              indirectComponents: [],
              maxImpact: `max_downtime_seconds: ${step.blastRadius.maxDowntimeSeconds ?? 0}`,
              cascadeRisk: 'low',
            }
          : {
              directComponents: [step.target ?? 'primary'],
              indirectComponents: [],
              maxImpact: 'minimal',
              cascadeRisk: 'none',
            },
        timeout: step.timeout ?? '300s',
        ...(step.precondition
          ? {
              preConditions: [
                {
                  description: step.precondition,
                  check: { type: 'expression', expect: { operator: 'eq', value: true } },
                },
              ],
            }
          : {}),
      };

    case 'human_approval':
      return {
        stepId,
        type: 'human_approval',
        name: step.title,
        description: step.description ?? step.body.trim(),
        approvers: [{ role: 'oncall', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: step.title,
          detail: step.body.trim(),
          proposedActions: [step.description ?? step.title],
          alternatives: [],
        },
        timeout: step.timeout ?? '15m',
        timeoutAction: (step.escalation ? 'escalate' : 'abort') as TimeoutAction,
        ...(step.escalation
          ? { escalateTo: { role: step.escalation, message: `Approval timeout for: ${step.title}` } }
          : {}),
      };

    case 'replanning_checkpoint':
      return {
        stepId,
        type: 'replanning_checkpoint',
        name: step.title,
        description: step.description ?? step.body.trim(),
        fastReplan: false,
        replanTimeout: step.timeout ?? '60s',
      };

    case 'conditional':
      return {
        stepId,
        type: 'conditional',
        name: step.title,
        condition: {
          description: step.condition ?? step.title,
          check: { type: 'expression', expect: { operator: 'eq', value: true } },
        },
        thenStep: {
          stepId: `${playbook.frontmatter.name}-step-${step.position}-then`,
          type: 'human_notification',
          name: step.onSuccess ?? 'Success action',
          recipients: [{ role: 'oncall', urgency: 'low' }],
          message: { summary: step.onSuccess ?? 'Condition met', detail: '', actionRequired: false },
          channel: 'default',
        },
        elseStep: step.onFailure
          ? {
              stepId: `${playbook.frontmatter.name}-step-${step.position}-else`,
              type: 'human_notification',
              name: step.onFailure,
              recipients: [{ role: 'oncall', urgency: 'high' }],
              message: { summary: step.onFailure, detail: '', actionRequired: true },
              channel: 'default',
            }
          : 'skip',
      };

    default:
      // Fallback: treat unknown types as diagnosis actions
      return {
        stepId,
        type: 'diagnosis_action',
        name: step.title,
        description: step.description ?? step.body.trim(),
        executionContext: step.executionContext ?? 'default',
        target: step.target ?? 'primary',
        command: buildCommandFromCodeBlocks(step.codeBlocks) ?? { type: 'structured_command', operation: step.title },
        timeout: step.timeout ?? '60s',
      };
  }
}

/**
 * Build a synthetic AgentManifest for a playbook so compiled plans can run
 * through the same validatePlan() safety checks as code-based agents
 * (no shortcuts). Derived entirely from the playbook's own declarations.
 */
export function buildPlaybookManifest(playbook: ParsedPlaybook): AgentManifest {
  const fm = playbook.frontmatter;

  // Execution contexts and their capability unions, as the compiled plan uses them
  const contextCapabilities = new Map<string, Set<string>>();
  let maxRiskIndex = RISK_ORDER.indexOf('routine');
  for (const step of playbook.steps) {
    if (step.type !== 'system_action' && step.type !== 'diagnosis_action') continue;
    const context = step.executionContext ?? 'default';
    const capabilities = contextCapabilities.get(context) ?? new Set<string>();
    for (const capability of step.capabilities ?? []) capabilities.add(capability);
    contextCapabilities.set(context, capabilities);

    const riskIndex = RISK_ORDER.indexOf((step.risk ?? 'routine') as RiskLevel);
    if (riskIndex > maxRiskIndex) maxRiskIndex = riskIndex;
  }

  const maxRiskLevel = RISK_ORDER[maxRiskIndex] ?? 'routine';

  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: 'AgentManifest',
    metadata: {
      name: fm.name,
      version: fm.version,
      description: fm.description,
      ...(fm.author !== undefined ? { authors: [fm.author] } : { authors: [] }),
      license: 'Apache-2.0',
      tags: fm.tags ?? [],
      plugin: {
        id: `${fm.name}.playbook`,
        kind: 'scenario_module',
        maturity: 'experimental',
        compatibilityMode: 'recovery_agent',
      },
    },
    spec: {
      targetSystems: fm.agent
        ? [{ technology: fm.agent, versionConstraint: '*', components: [] }]
        : [],
      triggerConditions: [],
      failureScenarios: [fm.description],
      executionContexts: [...contextCapabilities.entries()].map(([name, capabilities]) => ({
        name,
        type: 'playbook',
        privilege: 'operator',
        target: 'primary',
        capabilities: [...capabilities],
      })),
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: {
        maxRiskLevel,
        dataLossPossible: false,
        serviceDisruptionPossible: maxRiskLevel !== 'routine',
      },
      humanInteraction: {
        requiresApproval: true,
        minimumApprovalRole: 'sre',
        escalationPath: [],
      },
    },
  };
}

export function playbookToPlan(playbook: ParsedPlaybook): RecoveryPlan {
  const fm = playbook.frontmatter;
  const planId = `${fm.name}-${Date.now()}`;

  const steps: RecoveryStep[] = playbook.steps.map((step) => convertStep(playbook, step));

  const affectedSystems = [];
  if (fm.agent) {
    affectedSystems.push({
      identifier: fm.agent,
      technology: fm.agent,
      role: 'target',
      impactType: 'recovery',
    });
  }
  if (fm.tags) {
    for (const tag of fm.tags) {
      affectedSystems.push({
        identifier: tag,
        technology: tag,
        role: 'related',
        impactType: 'indirect',
      });
    }
  }
  if (affectedSystems.length === 0) {
    affectedSystems.push({
      identifier: fm.name,
      technology: 'unknown',
      role: 'target',
      impactType: 'recovery',
    });
  }

  const rollbackStrategy = playbook.rollback
    ? { type: 'stepwise' as const, description: playbook.rollback }
    : { type: 'stepwise' as const, description: 'Revert each step individually' };

  return {
    apiVersion: 'crisismode.dev/v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId,
      agentName: fm.agent ?? fm.name,
      agentVersion: fm.version,
      scenario: fm.description,
      createdAt: new Date().toISOString(),
      estimatedDuration: fm.estimatedDuration ?? '30m',
      summary: fm.description,
      supersedes: null,
    },
    impact: {
      affectedSystems,
      affectedServices: fm.tags ?? [],
      estimatedUserImpact: fm.severity ? `Severity: ${fm.severity}` : 'Unknown',
      dataLossRisk: 'none',
    },
    steps,
    rollbackStrategy,
  };
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((curr, key) => {
    if (curr && typeof curr === 'object') return (curr as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

export function interpolateVariables(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, path: string) => {
    const value = resolvePath(context, path);
    return value !== undefined ? String(value) : `{${path}}`;
  });
}
