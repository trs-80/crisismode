// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RiskLevel } from './common.js';

export interface CatalogEntry {
  apiVersion: string;
  kind: 'CatalogEntry';
  metadata: {
    catalogId: string;
    name: string;
    description: string;
    approvedBy: string;
    approvedAt: string;
    reviewSchedule: string;
    expiresAt: string;
  };
  matchCriteria: {
    agentName: string;
    agentVersionConstraint: string;
    scenario: string;
    environment: string;
    maxRiskLevel: RiskLevel;
    requiredStepPatterns: Array<{
      type: string;
      position: string;
    }>;
    forbiddenOperations: string[];
    maxStepCount: number;
    maxEstimatedDuration: string;
  };
  authorization: {
    satisfiesApprovalFor: RiskLevel[];
    notificationRequired: boolean;
    notificationRecipients: Array<{
      role: string;
      urgency: string;
    }>;
  };
}
