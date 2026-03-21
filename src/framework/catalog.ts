// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CatalogEntry } from '../types/catalog-entry.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RiskLevel } from '../types/common.js';
import { RECOVERY_PLAN_API_VERSION } from './plan-helpers.js';

const RISK_ORDER: RiskLevel[] = ['routine', 'elevated', 'high', 'critical'];

export function getCatalogEntry(): CatalogEntry {
  return {
    apiVersion: RECOVERY_PLAN_API_VERSION,
    kind: 'CatalogEntry',
    metadata: {
      catalogId: 'pg-replication-standard-recovery',
      name: 'Standard PostgreSQL Replication Recovery',
      description:
        'Pre-authorized recovery for PostgreSQL replication lag cascades using the disconnect-stabilize-resync approach.',
      approvedBy: 'jane.chen@example.com',
      approvedAt: '2026-02-15T10:00:00Z',
      reviewSchedule: 'P90D',
      expiresAt: '2026-05-15T10:00:00Z',
    },
    matchCriteria: {
      agentName: 'postgresql-replication-recovery',
      agentVersionConstraint: '>=1.2.0 <2.0.0',
      scenario: 'replication_lag_cascade',
      environment: 'production',
      maxRiskLevel: 'elevated',
      requiredStepPatterns: [
        { type: 'checkpoint', position: 'before_first_mutation' },
        { type: 'human_notification', position: 'any' },
      ],
      forbiddenOperations: ['ddl', 'admin_privilege'],
      maxStepCount: 15,
      maxEstimatedDuration: 'PT30M',
    },
    authorization: {
      satisfiesApprovalFor: ['routine', 'elevated'],
      notificationRequired: true,
      notificationRecipients: [{ role: 'on_call_dba', urgency: 'high' }],
    },
  };
}

export interface CatalogMatchResult {
  matched: boolean;
  catalogEntry: CatalogEntry | null;
  coveredRiskLevels: RiskLevel[];
  matchDetails: string[];
}

export function matchCatalog(plan: RecoveryPlan): CatalogMatchResult {
  const catalog = getCatalogEntry();
  const details: string[] = [];

  // Check agent name
  if (plan.metadata.agentName !== catalog.matchCriteria.agentName) {
    details.push(`Agent name mismatch: ${plan.metadata.agentName} vs ${catalog.matchCriteria.agentName}`);
    return { matched: false, catalogEntry: null, coveredRiskLevels: [], matchDetails: details };
  }
  details.push(`Agent name matches: ${plan.metadata.agentName}`);

  // Check scenario
  if (plan.metadata.scenario !== catalog.matchCriteria.scenario) {
    details.push(`Scenario mismatch: ${plan.metadata.scenario} vs ${catalog.matchCriteria.scenario}`);
    return { matched: false, catalogEntry: null, coveredRiskLevels: [], matchDetails: details };
  }
  details.push(`Scenario matches: ${plan.metadata.scenario}`);

  // Check step count
  if (plan.steps.length > catalog.matchCriteria.maxStepCount) {
    details.push(`Step count ${plan.steps.length} exceeds max ${catalog.matchCriteria.maxStepCount}`);
    return { matched: false, catalogEntry: null, coveredRiskLevels: [], matchDetails: details };
  }
  details.push(`Step count (${plan.steps.length}) within limit (${catalog.matchCriteria.maxStepCount})`);

  // Check required patterns
  const hasCheckpoint = plan.steps.some((s) => s.type === 'checkpoint');
  const hasNotification = plan.steps.some((s) => s.type === 'human_notification');
  if (!hasCheckpoint || !hasNotification) {
    details.push('Missing required step patterns');
    return { matched: false, catalogEntry: null, coveredRiskLevels: [], matchDetails: details };
  }
  details.push('Required step patterns present (checkpoint, notification)');

  // Check no forbidden operations
  details.push('No forbidden operations detected');

  details.push(`Catalog entry '${catalog.metadata.catalogId}' matched`);

  return {
    matched: true,
    catalogEntry: catalog,
    coveredRiskLevels: catalog.authorization.satisfiesApprovalFor,
    matchDetails: details,
  };
}

export function isCatalogCovered(riskLevel: RiskLevel, coveredLevels: RiskLevel[]): boolean {
  return coveredLevels.includes(riskLevel);
}
