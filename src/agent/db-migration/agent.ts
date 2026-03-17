// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { dbMigrationManifest } from './manifest.js';
import type { DbMigrationBackend } from './backend.js';
import { DbMigrationSimulator } from './simulator.js';

export class DbMigrationAgent implements RecoveryAgent {
  manifest = dbMigrationManifest;
  backend: DbMigrationBackend;

  constructor(backend?: DbMigrationBackend) {
    this.backend = backend ?? new DbMigrationSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const migration = await this.backend.getMigrationStatus();
    const pool = await this.backend.getConnectionPoolStats();
    const queries = await this.backend.getActiveQueries();
    const locks = await this.backend.getTableLockInfo();
    const dbSize = await this.backend.getDatabaseSize();

    const migrationStuck = migration.status === 'failed' || migration.status === 'running';
    const poolCritical = pool.utilizationPct > 90;
    const poolWarning = pool.utilizationPct > 70;
    const locksCritical = locks.filter((l) => !l.granted).length > 0;
    const longQueries = queries.filter((q) => q.duration > 300);
    const queriesCritical = longQueries.length > 3;
    const queriesWarning = longQueries.length > 0;
    const spaceLow = dbSize.tablespaceFree < 10_737_418_240; // < 10GB

    const status = migrationStuck || poolCritical || locksCritical
      ? 'unhealthy'
      : poolWarning || queriesWarning || spaceLow
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'schema_migrations',
        status: migrationStuck ? 'critical' : 'healthy',
        detail: migrationStuck
          ? `Migration ${migration.version} (${migration.name}) is ${migration.status}. ${migration.error ?? ''}`
          : `Latest migration ${migration.version} completed successfully.`,
        observedAt,
      },
      {
        source: 'connection_pool',
        status: poolCritical ? 'critical' : poolWarning ? 'warning' : 'healthy',
        detail: `Connection pool: ${pool.active} active, ${pool.idle} idle, ${pool.waiting} waiting (${pool.utilizationPct.toFixed(1)}% of ${pool.maxConnections} max).`,
        observedAt,
      },
      {
        source: 'pg_locks',
        status: locksCritical ? 'critical' : 'healthy',
        detail: locksCritical
          ? `${locks.filter((l) => !l.granted).length} blocked lock(s) detected on ${[...new Set(locks.map((l) => l.relation))].join(', ')}.`
          : 'No blocked locks detected.',
        observedAt,
      },
      {
        source: 'pg_stat_activity',
        status: queriesCritical ? 'critical' : queriesWarning ? 'warning' : 'healthy',
        detail: longQueries.length > 0
          ? `${longQueries.length} long-running query(ies); longest running for ${Math.max(...queries.map((q) => q.duration))}s.`
          : 'No long-running queries detected.',
        observedAt,
      },
      {
        source: 'database_size',
        status: spaceLow ? 'warning' : 'healthy',
        detail: `Database size: ${(dbSize.totalBytes / 1_073_741_824).toFixed(1)}GB. Free space: ${(dbSize.tablespaceFree / 1_073_741_824).toFixed(1)}GB. Growth rate: ${(dbSize.growthRatePerHour / 1_048_576).toFixed(0)}MB/hr.`,
        observedAt,
      },
    ];

    const summary = status === 'healthy'
      ? 'Database migration health is healthy. Migrations, connection pool, locks, and queries are all within normal thresholds.'
      : status === 'recovering'
        ? 'Database health is recovering. At least one pressure indicator is above the healthy target.'
        : 'Database health is unhealthy. A stuck migration, connection pool exhaustion, or lock contention requires immediate action.';

    const recommendedActions = status === 'healthy'
      ? ['No action required. Continue monitoring database migration and connection pool health.']
      : status === 'recovering'
        ? ['Continue monitoring until connection pool utilization and query durations return to healthy thresholds.']
        : ['Run the DB migration recovery workflow in dry-run mode to determine the next safe mitigation step.'];

    return {
      status,
      confidence: 0.94,
      summary,
      observedAt,
      signals,
      recommendedActions,
    };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const migration = await this.backend.getMigrationStatus();
    const pool = await this.backend.getConnectionPoolStats();
    const queries = await this.backend.getActiveQueries();
    const locks = await this.backend.getTableLockInfo();
    const dbSize = await this.backend.getDatabaseSize();

    const blockedLocks = locks.filter((l) => !l.granted);
    const scenario = migration.status === 'failed' && blockedLocks.length > 0
      ? 'migration_lock_timeout'
      : pool.utilizationPct > 90
        ? 'connection_pool_exhaustion'
        : queries.some((q) => q.duration > 300)
          ? 'long_running_query_block'
          : 'migration_rollback_needed';

    const confidence = migration.status === 'failed' && blockedLocks.length > 0 ? 0.95 : 0.82;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'schema_migrations',
          observation: `Migration ${migration.version} (${migration.name}): ${migration.status}. ${migration.error ?? 'No error recorded.'}`,
          severity: migration.status === 'failed' ? 'critical' : migration.status === 'running' ? 'warning' : 'info',
          data: { migration },
        },
        {
          source: 'connection_pool',
          observation: `Pool utilization: ${pool.utilizationPct.toFixed(1)}% (${pool.active} active, ${pool.idle} idle, ${pool.waiting} waiting of ${pool.maxConnections} max).`,
          severity: pool.utilizationPct > 90 ? 'critical' : pool.utilizationPct > 70 ? 'warning' : 'info',
          data: { pool },
        },
        {
          source: 'pg_locks',
          observation: blockedLocks.length > 0
            ? `${blockedLocks.length} blocked lock(s). Lock holder PID ${blockedLocks[0]?.pid} on relation "${blockedLocks[0]?.relation}".`
            : 'No blocked locks.',
          severity: blockedLocks.length > 0 ? 'critical' : 'info',
          data: { locks },
        },
        {
          source: 'pg_stat_activity',
          observation: queries.length > 0
            ? `${queries.length} active query(ies). Longest: PID ${queries[0]?.pid} running for ${queries[0]?.duration}s${queries[0]?.waitEvent ? ` (waiting on ${queries[0].waitEvent})` : ''}.`
            : 'No active long-running queries.',
          severity: queries.some((q) => q.duration > 300) ? 'critical' : queries.length > 0 ? 'warning' : 'info',
          data: { queries },
        },
        {
          source: 'database_size',
          observation: `Total: ${(dbSize.totalBytes / 1_073_741_824).toFixed(1)}GB. Free: ${(dbSize.tablespaceFree / 1_073_741_824).toFixed(1)}GB. Growth: ${(dbSize.growthRatePerHour / 1_048_576).toFixed(0)}MB/hr.`,
          severity: dbSize.tablespaceFree < 10_737_418_240 ? 'warning' : 'info',
          data: { dbSize },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const now = new Date().toISOString();
    const instance = String(context.trigger.payload.instance || 'managed-db-primary');

    const steps: RecoveryStep[] = [
      // Step 1: Diagnosis — read migration status, connection pool, active queries
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Read migration status, connection pool, and active queries',
        executionContext: 'db_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'get_migration_status',
          parameters: { sections: ['migration', 'pool', 'queries', 'locks', 'size'] },
        },
        outputCapture: {
          name: 'current_db_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call about DB saturation / stuck migration
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Alert on-call about database saturation and stuck migration',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Database migration stuck with connection pool exhaustion on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_db_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint — capture current DB state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Capture pre-recovery database state',
        description: 'Snapshot connection pool, locks, migration version before mutations.',
        stateCaptures: [
          {
            name: 'connection_pool_snapshot',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_stat_activity',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'lock_snapshot',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_locks WHERE NOT granted',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'migration_version_snapshot',
            captureType: 'sql_query',
            statement: 'SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Kill blocking queries holding migration locks (elevated)
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Kill blocking queries holding migration locks',
        description: 'Terminate backend processes holding AccessExclusiveLock that block the migration and application queries.',
        executionContext: 'db_write',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['db.connections.terminate'],
        command: {
          type: 'sql',
          operation: 'kill_blocking_queries',
          statement: 'SELECT pg_terminate_backend(pid) FROM pg_locks WHERE NOT granted AND relation::regclass::text = $1',
          parameters: { relation: 'orders' },
        },
        preConditions: [
          {
            description: 'Database is accepting connections',
            check: {
              type: 'sql',
              statement: 'SELECT 1',
              expect: { operator: 'eq', value: 1 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'active_queries_before_kill',
              captureType: 'sql_query',
              statement: 'SELECT pid, query, state, wait_event FROM pg_stat_activity WHERE state != \'idle\'',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'active_queries_after_kill',
              captureType: 'sql_query',
              statement: 'SELECT pid, query, state, wait_event FROM pg_stat_activity WHERE state != \'idle\'',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'No blocked locks remain on the target relation',
          check: {
            type: 'sql',
            statement: 'active_locks',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Terminated queries will be retried by application connection pools automatically.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['application-pool', 'migration-runner'],
          maxImpact: 'blocking_queries_terminated',
          cascadeRisk: 'medium',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Free connection pool — terminate idle connections (routine)
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Terminate idle connections to free pool capacity',
        description: 'Close idle connections exceeding 5 minutes to reduce pool utilization.',
        executionContext: 'db_write',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['db.connections.terminate'],
        command: {
          type: 'sql',
          operation: 'terminate_idle_connections',
          statement: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = \'idle\' AND state_change < NOW() - INTERVAL \'5 minutes\'',
          parameters: {},
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Connection pool utilization below 70%',
          check: {
            type: 'structured_command',
            statement: 'connection_pool_utilization',
            expect: { operator: 'lt', value: 70 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Applications will re-establish connections via their connection pool.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['application-pool'],
          maxImpact: 'idle_connections_terminated',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Replanning checkpoint — check if migration can proceed or needs rollback
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess migration and pool state after lock release',
        description: 'Determine if the migration can be retried or if a rollback is required.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_cleanup_state',
            captureType: 'sql_query',
            statement: 'SELECT version, status FROM schema_migrations ORDER BY version DESC LIMIT 1',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'post_cleanup_pool',
            captureType: 'sql_query',
            statement: 'SELECT count(*) AS active_connections FROM pg_stat_activity WHERE state != \'idle\'',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Human approval gate for migration rollback
      {
        stepId: 'step-007',
        type: 'human_approval',
        name: 'Approve migration rollback',
        description: 'Migration rollback is a high-risk operation that may affect schema state. Requires explicit human approval before proceeding.',
        approvers: [
          { role: 'database_administrator', required: true },
          { role: 'engineering_lead', required: false },
        ],
        requiredApprovals: 1,
        presentation: {
          summary: `Migration failed and needs rollback on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. The failed migration is holding locks and exhausting the connection pool. Rollback will revert the schema to the previous known-good version.`,
          contextReferences: ['current_db_state', 'post_cleanup_state'],
          proposedActions: [
            'Roll back the failed migration to restore the previous schema version',
          ],
          riskSummary: 'Schema may be left in a partially-applied state. Application queries depending on new schema will fail until migration is re-applied. Data inserted during partial migration may need manual reconciliation.',
          alternatives: [
            { action: 'retry', description: 'Retry migration after locks are released' },
            { action: 'manual_fix', description: 'Manual DBA intervention to fix migration in place' },
          ],
        },
        timeout: 'PT30M',
        timeoutAction: 'escalate',
      },
      // Step 8: Rollback failed migration (high risk)
      {
        stepId: 'step-008',
        type: 'system_action',
        name: 'Rollback failed migration',
        description: 'Roll back the failed migration to restore the database to the last known good schema version.',
        executionContext: 'db_write',
        target: instance,
        riskLevel: 'high',
        requiredCapabilities: ['db.migration.rollback'],
        command: {
          type: 'sql',
          operation: 'rollback_migration',
          statement: 'ROLLBACK',
          parameters: { targetVersion: 'previous' },
        },
        preConditions: [
          {
            description: 'No active queries are running against the migration target table',
            check: {
              type: 'sql',
              statement: 'active_locks',
              expect: { operator: 'eq', value: 0 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'schema_before_rollback',
              captureType: 'sql_query',
              statement: 'SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 10',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P90D',
            },
            {
              name: 'table_definition_before_rollback',
              captureType: 'sql_query',
              statement: 'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P90D',
            },
          ],
          after: [
            {
              name: 'schema_after_rollback',
              captureType: 'sql_query',
              statement: 'SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 10',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P90D',
            },
          ],
        },
        successCriteria: {
          description: 'Migration status shows previous version as completed',
          check: {
            type: 'structured_command',
            statement: 'migration_status',
            expect: { operator: 'eq', value: 'completed' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Manual DBA intervention required if rollback fails. Restore from schema snapshot captured in statePreservation.',
        },
        blastRadius: {
          directComponents: [instance, 'migration-runner'],
          indirectComponents: ['application-pool', 'query-engine'],
          maxImpact: 'schema_reverted_to_previous_version',
          cascadeRisk: 'high',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 9: Conditional — if connections normalized, monitor; else escalate
      {
        stepId: 'step-009',
        type: 'conditional',
        name: 'Check if connections have normalized',
        condition: {
          description: 'Waiting connections have dropped to zero',
          check: {
            type: 'structured_command',
            statement: 'waiting_connections',
            expect: { operator: 'eq', value: 0 },
          },
        },
        thenStep: {
          stepId: 'step-009a',
          type: 'diagnosis_action',
          name: 'Continue monitoring — connections normalized',
          executionContext: 'db_read',
          target: instance,
          command: {
            type: 'structured_command',
            operation: 'get_migration_status',
            parameters: { sections: ['pool', 'queries'] },
          },
          outputCapture: {
            name: 'post_recovery_monitoring',
            format: 'structured',
            availableTo: 'subsequent_steps',
          },
          timeout: 'PT30S',
        },
        elseStep: {
          stepId: 'step-009b',
          type: 'human_notification',
          name: 'Escalate — connection pool still saturated',
          recipients: [
            { role: 'database_administrator', urgency: 'critical' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `Connection pool on ${instance} remains saturated after migration rollback`,
            detail: 'Automated recovery could not fully restore connection pool health. Manual DBA intervention is required.',
            contextReferences: ['post_cleanup_state', 'post_cleanup_pool'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 10: Recovery summary notification
      {
        stepId: 'step-010',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'database_administrator', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Database migration recovery completed on ${instance}`,
          detail: 'Blocking queries terminated, idle connections freed, failed migration rolled back. Monitor connection pool utilization and migration runner status.',
          contextReferences: ['current_db_state', 'post_cleanup_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: `rp-${now.replace(/[-:T]/g, '').slice(0, 14)}-db-mig-001`,
        agentName: 'db-migration-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'migration_lock_timeout',
        createdAt: now,
        estimatedDuration: 'PT15M',
        summary: `Recover managed database from stuck migration on ${instance}: kill blocking queries, free connections, rollback failed migration.`,
        supersedes: null,
      },
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'managed-database',
            role: 'primary',
            impactType: 'brief_query_disruption_and_schema_rollback',
          },
        ],
        affectedServices: ['migration-runner', 'application-pool', 'query-engine'],
        estimatedUserImpact: 'Brief query failures during lock release and connection pool reset. Schema reverted to previous version.',
        dataLossRisk: 'low',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Query terminations recover automatically via connection pooling. Migration rollback requires manual DBA re-application of the migration.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    executionState: ExecutionState,
  ): Promise<ReplanResult> {
    const completedSteps = executionState.completedSteps ?? [];
    const poolFreed = completedSteps.some((s) => s.stepId === 'step-005' && s.status === 'success');

    if (poolFreed) {
      // If connection pool recovered after freeing idle connections,
      // continue — the replanning checkpoint will determine next steps
      return { action: 'continue' };
    }

    return { action: 'continue' };
  }
}
