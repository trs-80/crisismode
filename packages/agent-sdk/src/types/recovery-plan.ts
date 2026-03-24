// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryStep } from './step-types.js';

export interface RecoveryPlan {
  apiVersion: string;
  kind: 'RecoveryPlan';
  metadata: {
    planId: string;
    agentName: string;
    agentVersion: string;
    scenario: string;
    createdAt: string;
    estimatedDuration: string;
    summary: string;
    supersedes: string | null;
  };
  impact: PlanImpact;
  steps: RecoveryStep[];
  rollbackStrategy: RollbackStrategy;
}

export interface PlanImpact {
  affectedSystems: AffectedSystem[];
  affectedServices: string[];
  estimatedUserImpact: string;
  dataLossRisk: string;
}

export interface AffectedSystem {
  identifier: string;
  technology: string;
  role: string;
  impactType: string;
}

export interface RollbackStrategy {
  type: 'stepwise' | 'checkpoint' | 'full' | 'none';
  description: string;
}
