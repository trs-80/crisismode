// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RiskLevel } from './common.js';

export interface AgentManifest {
  apiVersion: string;
  kind: 'AgentManifest';
  metadata: {
    name: string;
    version: string;
    description: string;
    authors: string[];
    license: string;
    tags: string[];
  };
  spec: {
    targetSystems: TargetSystem[];
    triggerConditions: TriggerCondition[];
    failureScenarios: string[];
    executionContexts: ExecutionContextDeclaration[];
    observabilityDependencies: {
      required: string[];
      optional: string[];
    };
    riskProfile: {
      maxRiskLevel: RiskLevel;
      dataLossPossible: boolean;
      serviceDisruptionPossible: boolean;
    };
    humanInteraction: {
      requiresApproval: boolean;
      minimumApprovalRole: string;
      escalationPath: string[];
    };
  };
}

export interface TargetSystem {
  technology: string;
  versionConstraint: string;
  components: string[];
}

export interface TriggerCondition {
  type: 'alert' | 'health_check' | 'manual';
  source?: string;
  matchLabels?: Record<string, string>;
  name?: string;
  status?: string;
  description?: string;
}

export interface ExecutionContextDeclaration {
  name: string;
  type: string;
  privilege: string;
  target: string;
  allowedOperations?: string[];
}
