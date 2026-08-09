// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared scaffolding for running the AI-explainer plan fixtures through the
 * real plan validator.
 *
 * `explainPlan` never validates the plan it is handed, so nothing in those
 * tests would notice a fixture that violates the repo's safety contract
 * (CLAUDE.md "Safety Rules", enforced by src/framework/validator.ts). A fixture
 * that does is worse than untidy: it is the shape a contributor copies, and it
 * is the shape the real engine would refuse to execute. This module exists so
 * each fixture can be asserted valid mechanically instead of by review.
 *
 * Not a test file (no `.test.ts` suffix), so vitest does not collect it.
 */

import type { AgentManifest } from '../types/manifest.js';
import type { RiskLevel } from '../types/common.js';

/**
 * The minimum manifest that lets `validatePlan` judge a plan on its own merits.
 *
 * `validatePlan` cross-checks a plan against its agent's manifest — declared
 * scenario, declared execution contexts, and the agent's maximum risk level —
 * so a manifest is required even when the question being asked is only about
 * the plan. Everything here is therefore derived from the plan under test: it
 * grants exactly what the plan needs and nothing more, so the checks that
 * remain meaningful are the plan-safety ones.
 *
 * `capabilities` is deliberately left off each execution context. That field is
 * only read by the opt-in `requireExecutableCapabilities` check, which asks a
 * different question (can this spoke actually run the plan?) and is not what
 * these fixtures are for.
 */
export function safetyManifestFor(options: {
  scenario: string;
  executionContexts: string[];
  maxRiskLevel: RiskLevel;
}): AgentManifest {
  return {
    apiVersion: 'crisismode.io/v1alpha1',
    kind: 'AgentManifest',
    metadata: {
      name: 'ai-explainer-fixture-agent',
      version: '0.0.0',
      description: 'Manifest scaffold for validating AI-explainer plan fixtures',
      authors: ['CrisisMode Contributors'],
      license: 'Apache-2.0',
      tags: ['test-fixture'],
      plugin: {
        type: 'agent',
        sdkVersion: '^0.4.0',
        entrypoint: 'test-fixture',
      },
    },
    spec: {
      targetSystems: [],
      triggerConditions: [],
      failureScenarios: [options.scenario],
      executionContexts: options.executionContexts.map((name) => ({
        name,
        type: 'test-fixture',
        privilege: 'read_write',
        target: 'fixture-target',
      })),
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: {
        maxRiskLevel: options.maxRiskLevel,
        dataLossPossible: false,
        serviceDisruptionPossible: true,
      },
      humanInteraction: {
        requiresApproval: true,
        minimumApprovalRole: 'sre-oncall',
        escalationPath: ['sre-oncall'],
      },
    },
  } as unknown as AgentManifest;
}
