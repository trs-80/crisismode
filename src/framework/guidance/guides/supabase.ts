// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * Supabase Postgres remediation paths, keyed to readiness rule ids.
 * Console paths must be re-verified by a human before verifiedOn is
 * updated — see CONTRIBUTING.md.
 */
export const supabaseGuides: RemediationGuide[] = [
  {
    id: 'supabase-pooler-mode',
    platform: 'supabase',
    title: 'Use the Supabase transaction pooler for serverless functions',
    applicableFindingTypes: ['serverless-pooling'],
    url: 'https://supabase.com/dashboard/project/_/settings/database',
    consoleSteps: [
      'Open the Supabase dashboard → your project → Project Settings → Database → Connection string.',
      'Pick the Transaction pooler connection string (port 6543) for serverless or edge deployments, where every invocation opens its own connection.',
      'Keep the Session pooler or direct connection (port 5432) for long-lived servers and for migrations.',
      'Set DATABASE_URL to the transaction-pooler URI in the serverless deployment and redeploy.',
      'If your Postgres driver uses prepared statements by default, disable them for the pooled connection (for example `?pgbouncer=true` or the driver\'s prepared-statement flag).',
    ],
    expectedAfter:
      'DATABASE_URL points at the pooler host on port 6543, and `crisismode readiness` no longer flags serverless-pooling.',
    caution:
      'Transaction mode does not support session-level features (LISTEN/NOTIFY, session-scoped prepared statements, advisory locks held across statements). Run migrations over the direct connection.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-connection-limits',
    platform: 'supabase',
    title: 'Fit your app inside the Supabase connection cap',
    applicableFindingTypes: ['connection-limit-tier', 'connection-headroom'],
    url: 'https://supabase.com/docs/guides/platform/compute-and-disk',
    consoleSteps: [
      'Open the Supabase dashboard → Project Settings → Database → Connection pooling to see the pool size and maximum client connections for your compute size.',
      'Compare that ceiling against the connection count CrisisMode reported — count every running instance, not just one.',
      'Lower the per-instance pool size in the app so (instances × pool size) stays under the cap with room to spare.',
      'Move serverless traffic to the transaction pooler so short invocations share connections instead of each holding one.',
      'If the cap is genuinely too small for the workload, upgrade compute (see the compute upgrade guide).',
    ],
    expectedAfter: 'Peak connection count stays below the cap, and connection-headroom reports ready.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-upgrade-compute',
    platform: 'supabase',
    title: 'Upgrade Supabase compute for a higher connection limit',
    applicableFindingTypes: ['connection-limit-tier'],
    url: 'https://supabase.com/dashboard/project/_/settings/compute-and-disk',
    consoleSteps: [
      'Open the Supabase dashboard → Project Settings → Compute and Disk.',
      'Read the current compute size and the connection limits documented for each size.',
      'Select the next compute size up and confirm the change.',
      'Wait for the restart to finish, then re-run `crisismode readiness` to confirm the new headroom.',
    ],
    expectedAfter: 'The reported maximum connections rises to the new compute size\'s limit.',
    caution:
      'Changing compute size restarts the database — connections drop for seconds to minutes. Larger compute bills at a higher hourly rate.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'supabase-pgvector-index',
    platform: 'supabase',
    title: 'Add an approximate vector index to your pgvector table',
    applicableFindingTypes: ['vector-index-missing', 'ivfflat-lists-mismatch'],
    url: 'https://supabase.com/docs/guides/database/extensions/pgvector',
    consoleSteps: [
      'Open the Supabase dashboard → SQL Editor.',
      'Confirm the table and vector column named in the readiness finding.',
      'Create an HNSW index whose operator class matches the distance function your queries use, e.g. `CREATE INDEX CONCURRENTLY ON items USING hnsw (embedding vector_cosine_ops);`.',
      'For an existing ivfflat index the report flagged, either recreate it with `lists` close to sqrt(row count) or replace it with an HNSW index.',
      'Run `EXPLAIN ANALYZE` on a representative similarity query and confirm it now uses an index scan.',
    ],
    expectedAfter:
      'EXPLAIN ANALYZE shows an index scan instead of a sequential scan, and the vector readiness rule reports ready.',
    caution:
      'Building the index on a large table takes time and IO; CONCURRENTLY avoids blocking writes but takes longer. If the operator class does not match the distance operator the query uses (vector_cosine_ops / vector_l2_ops / vector_ip_ops), the planner ignores the index.',
    verifiedOn: '2026-08-05',
  },
];
