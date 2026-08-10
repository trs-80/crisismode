// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Illustrative catalog entry for the simulator demo.
 *
 * This is a FIXTURE, not an approval anyone granted: `jane.chen@example.com`
 * is fictional and the approval expired on 2026-05-15. It lives here, behind
 * the demo path, precisely so it can never act as a standing production
 * approval — `src/framework/catalog.ts` ships with no built-in entry and only
 * honors catalogs installed via `configureCatalogSource`.
 *
 * The demo installs it to show the catalog check running, and to show it
 * failing closed on an expired approval.
 */

import type { CatalogEntry } from '../types/catalog-entry.js';
import { RECOVERY_PLAN_API_VERSION } from '../framework/plan-helpers.js';

export const DEMO_CATALOG_ENTRY: CatalogEntry = {
  apiVersion: RECOVERY_PLAN_API_VERSION,
  kind: 'CatalogEntry',
  metadata: {
    catalogId: 'pg-replication-standard-recovery',
    name: 'Standard PostgreSQL Replication Recovery (demo fixture)',
    description:
      'Illustrative pre-authorized recovery for PostgreSQL replication lag cascades. Fictional approver, expired approval — for demonstration only.',
    approvedBy: 'jane.chen@example.com (fictional demo approver)',
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
