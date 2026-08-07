// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * Neon Postgres remediation paths, keyed to readiness rule ids. Console
 * paths must be re-verified by a human before verifiedOn is updated — see
 * CONTRIBUTING.md.
 */
export const neonGuides: RemediationGuide[] = [
  {
    id: 'neon-pooled-connection',
    platform: 'neon',
    title: 'Switch Neon to the pooled connection endpoint',
    applicableFindingTypes: ['serverless-pooling'],
    url: 'https://neon.com/docs/connect/connection-pooling',
    consoleSteps: [
      'Open the Neon console → your project → Dashboard → Connect (Connection Details).',
      'Enable the connection pooling option — the host in the connection string gains a `-pooler` suffix.',
      'Set DATABASE_URL to the pooled connection string in the serverless deployment and redeploy.',
      'Keep the unpooled (direct) connection string for migrations and for anything that needs a session-scoped feature.',
    ],
    expectedAfter:
      'DATABASE_URL\'s host ends in `-pooler`, and `crisismode readiness` no longer flags serverless-pooling.',
    caution:
      'The pooled endpoint runs PgBouncer in transaction mode: session-level features and some prepared-statement modes are unavailable. Run migrations over the direct endpoint.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'neon-compute-size',
    platform: 'neon',
    title: 'Raise Neon compute size to lift the connection limit',
    applicableFindingTypes: ['connection-limit-tier', 'connection-headroom'],
    url: 'https://neon.com/docs/introduction/autoscaling',
    consoleSteps: [
      'Open the Neon console → your project → Settings → Compute.',
      'Read the autoscaling minimum and maximum compute units — Postgres max_connections scales with compute size, so a small minimum caps connections even when traffic is low.',
      'Raise the minimum (and, if needed, the maximum) compute units, then save.',
      'If the workload is bursty and serverless, prefer the pooled endpoint over larger compute — it is cheaper for the same connection count.',
      'Re-run `crisismode readiness` to confirm the new headroom.',
    ],
    expectedAfter: 'The reported maximum connections rises, and connection-headroom reports ready.',
    caution:
      'Compute bills by the hour: the autoscaling minimum sets your floor cost and the maximum sets the ceiling.',
    verifiedOn: '2026-08-05',
  },
];
