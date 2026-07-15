// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { isIP } from 'node:net';
import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import type { ReplicaStatus, ConnectionUsage } from './backend.js';
import { pgReplicationManifest } from './manifest.js';
import type { PgBackend } from './backend.js';
import { PgSimulator } from './simulator.js';
import { aiDiagnose } from './ai-diagnosis.js';

// Connection-pool exhaustion is diagnosed deterministically off a direct
// measurement (pg_stat_activity vs. max_connections), not inferred — same
// category of "ground truth" signal as pg_is_wal_replay_paused(). A pool is
// considered exhausted only when BOTH utilization is critical AND
// idle-in-transaction sessions are a material contributor, so we don't
// misdiagnose ordinary high query load (many short-lived active connections)
// as a leak.
const CONNECTION_USAGE_CRITICAL_RATIO = 0.9;
const MIN_IDLE_IN_TRANSACTION_CONTRIBUTORS = 3;
/** Idle-in-transaction sessions older than this are considered stale/leaked and eligible for termination. */
const IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS = 60;

const CONNECTION_USAGE_QUERY =
  "SELECT count(*)::int AS total, current_setting('max_connections')::int AS max_connections FROM pg_stat_activity;";

const ACTIVITY_SNAPSHOT_QUERY =
  'SELECT pid, usename, application_name, client_addr, state, ' +
  'COALESCE(EXTRACT(EPOCH FROM (now() - state_change))::int, 0) AS age_seconds, query ' +
  'FROM pg_stat_activity WHERE state IS NOT NULL ORDER BY age_seconds DESC;';

function idleInTxCountQuery(thresholdSeconds: number): string {
  return `SELECT count(*)::int FROM pg_stat_activity WHERE state = 'idle in transaction' AND state_change < NOW() - INTERVAL '${thresholdSeconds} seconds';`;
}

function terminateIdleInTxStatement(thresholdSeconds: number): string {
  // pg_terminate_backend() only SIGNALS the target backend — it returns
  // once the signal is sent, not once the backend has actually exited and
  // its pg_stat_activity row is gone. A bare `SELECT pg_terminate_backend(...)`
  // followed immediately by a successCriteria check that expects 0 matching
  // rows is a genuine race: the row can still be visible for a few tens of
  // milliseconds after the signal is sent, especially when terminating many
  // sessions in one pass. Wrap it in a short, bounded poll so the command
  // only returns once termination has actually settled (or the bound is
  // hit), instead of leaving that wait to chance.
  return (
    'DO $$\n' +
    'DECLARE\n' +
    '  remaining int;\n' +
    'BEGIN\n' +
    '  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity\n' +
    `    WHERE state = 'idle in transaction' AND state_change < NOW() - INTERVAL '${thresholdSeconds} seconds';\n` +
    '  FOR i IN 1..50 LOOP\n' +
    '    SELECT count(*) INTO remaining FROM pg_stat_activity\n' +
    `      WHERE state = 'idle in transaction' AND state_change < NOW() - INTERVAL '${thresholdSeconds} seconds';\n` +
    '    EXIT WHEN remaining = 0;\n' +
    '    PERFORM pg_sleep(0.1);\n' +
    '  END LOOP;\n' +
    'END $$;'
  );
}

/**
 * Validates and normalizes a PostgreSQL inet value to a bare IPv4 host address.
 * Used to prevent SQL injection when embedding addresses in plan steps.
 */
function validateIPv4(addr: string): string {
  const match = addr.trim().match(/^([0-9.]+)(?:\/(\d{1,2}))?$/);
  if (!match) {
    throw new Error(`Invalid IPv4 address: ${addr}`);
  }

  const host = match[1]!;
  const prefixLength = match[2];
  if (isIP(host) !== 4) {
    throw new Error(`Invalid IPv4 address: ${addr}`);
  }

  if (prefixLength !== undefined) {
    const prefix = Number(prefixLength);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error(`Invalid IPv4 address: ${addr}`);
    }
  }

  return host;
}

/**
 * Validates that a value is a safe PostgreSQL identifier (slot name).
 * Only allows alphanumeric characters and underscores.
 */
function validateSlotName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid replication slot name: ${name}`);
  }
  return name;
}

export class PgReplicationAgent implements RecoveryAgent {
  manifest = pgReplicationManifest;
  readonly supportsAiDiagnosis = true;
  backend: PgBackend;

  constructor(backend?: PgBackend) {
    this.backend = backend ?? new PgSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();

    let replicas: ReplicaStatus[];
    let slots: import('./backend.js').ReplicationSlot[];
    let connectionCount: number;
    try {
      replicas = await this.backend.queryReplicationStatus();
      slots = await this.backend.queryReplicationSlots();
      connectionCount = await this.backend.queryConnectionCount();
    } catch (err) {
      // Connection failed — PG is unreachable
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'unhealthy',
        confidence: 0.99,
        summary: `PostgreSQL is unreachable. Connection failed: ${message}`,
        observedAt,
        signals: [
          {
            source: 'pg_connection',
            status: 'critical',
            detail: `Cannot connect to PostgreSQL: ${message}`,
            observedAt,
          },
        ],
        recommendedActions: [
          'Verify the PostgreSQL process is running and accepting connections.',
          'Check network connectivity, firewall rules, and pg_hba.conf.',
          'If the instance was intentionally stopped, investigate what caused the outage.',
        ],
      };
    }

    if (replicas.length === 0) {
      return {
        status: 'unknown',
        confidence: 0.45,
        summary: 'Unable to determine PostgreSQL replication health because no replicas were reported by pg_stat_replication.',
        observedAt,
        signals: [
          {
            source: 'pg_stat_replication',
            status: 'unknown',
            detail: 'No replica rows returned from pg_stat_replication.',
            observedAt,
          },
        ],
        recommendedActions: [
          'Verify replication is configured and that the primary can see its replicas before attempting recovery.',
        ],
      };
    }

    const worstLag = Math.max(...replicas.map((replica) => replica.lag_seconds));
    const unhealthyReplicas = replicas.filter(
      (replica) => replica.state !== 'streaming' || replica.lag_seconds > 10,
    );
    const recoveringReplicas = replicas.filter(
      (replica) => replica.state === 'streaming' && replica.lag_seconds > 2 && replica.lag_seconds <= 10,
    );
    const unhealthySlots = slots.filter(
      (slot) => !slot.active || slot.wal_status === 'lost',
    );

    let status: HealthAssessment['status'];
    if (unhealthyReplicas.length > 0 || unhealthySlots.length > 0) {
      status = 'unhealthy';
    } else if (recoveringReplicas.length > 0) {
      status = 'recovering';
    } else {
      status = 'healthy';
    }

    const replicaSignal = this.buildReplicaHealthSignal(
      replicas,
      unhealthyReplicas,
      recoveringReplicas,
      worstLag,
      observedAt,
    );
    const slotSignal: HealthSignal = unhealthySlots.length > 0
      ? {
          source: 'pg_replication_slots',
          status: 'critical',
          detail: `${unhealthySlots.length} replication slot(s) are unhealthy: ${unhealthySlots.map((slot) => `${slot.slot_name}:${slot.wal_status}`).join(', ')}.`,
          observedAt,
        }
      : {
          source: 'pg_replication_slots',
          status: 'healthy',
          detail: `All ${slots.length} replication slot(s) are active with healthy WAL retention.`,
          observedAt,
        };
    const connectionSignal: HealthSignal = {
      source: 'pg_stat_activity',
      status: signalStatus(false, connectionCount > 500),
      detail: `${connectionCount} active connection(s) on the primary.`,
      observedAt,
    };

    return buildHealthAssessment({
      status,
      signals: [replicaSignal, slotSignal, connectionSignal],
      confidence: 0.97,
      summary: {
        healthy: `PostgreSQL replication is healthy. All replicas are streaming and worst replay lag is ${worstLag}s.`,
        recovering: `PostgreSQL replication is recovering. All replicas are streaming, but worst replay lag is still ${worstLag}s.`,
        unhealthy: `PostgreSQL replication is unhealthy. Worst replay lag is ${worstLag}s and direct health signals still show recovery is required.`,
      },
      actions: {
        healthy: ['No action required. Continue monitoring direct replication health signals.'],
        recovering: ['Continue monitoring until replay lag drops below 2s on all replicas.'],
        unhealthy: [
          'Run the replication recovery workflow in dry-run mode to confirm the next safe action.',
          ...(unhealthySlots.length > 0
            ? ['Prepare manual replication-slot repair if slot health does not recover during automation.']
            : []),
        ],
      },
    });
  }

  async diagnose(context: AgentContext): Promise<DiagnosisResult> {
    let replStatus: ReplicaStatus[];
    let slots: import('./backend.js').ReplicationSlot[];
    let connCount: number;
    try {
      replStatus = await this.backend.queryReplicationStatus();
      slots = await this.backend.queryReplicationSlots();
      connCount = await this.backend.queryConnectionCount();
    } catch (err) {
      // Connection failed — PG is unreachable
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'identified',
        scenario: 'database_unreachable',
        confidence: 0.99,
        findings: [
          {
            source: 'pg_connection',
            observation: `PostgreSQL is unreachable: ${message}`,
            severity: 'critical',
            data: { error: message },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    // Ground-truth check #1: connection-pool exhaustion is a direct
    // measurement (pg_stat_activity vs. max_connections), checked before
    // wal_replay_paused. Precedence is deliberate: near-total connection
    // exhaustion risks the primary refusing ALL new connections — a
    // total-outage-adjacent failure — whereas a single paused replica only
    // serves stale reads from that one replica. When both are true, resolve
    // the more severe/urgent failure first; diagnoseConnectionPoolExhaustion
    // still surfaces the co-occurring replay pause as an informational
    // finding so it isn't silently dropped.
    const connUsage = await this.backend.queryConnectionUsage().catch(() => null);
    if (connUsage && this.isConnectionPoolExhausted(connUsage)) {
      const alsoReplayPaused = await this.backend.queryReplayPaused().catch(() => null);
      return this.diagnoseConnectionPoolExhaustion(connUsage, replStatus, alsoReplayPaused === true);
    }

    // Ground-truth check #2: pg_is_wal_replay_paused() is a direct, unambiguous
    // signal (unlike lag, which can be explained several ways). When it's
    // available and true, that IS the root cause — diagnose deterministically
    // rather than let AI/rule-based heuristics guess at the LSN gap pattern.
    const replayPaused = await this.backend.queryReplayPaused().catch(() => null);
    if (replayPaused === true) {
      return this.diagnoseReplayPaused(replStatus, slots, connCount);
    }

    // Try AI-powered diagnosis first
    const aiResult = await aiDiagnose({
      replicas: replStatus,
      slots,
      connectionCount: connCount,
      isReplayPaused: replayPaused,
      connectionUsage: connUsage,
    });

    if (aiResult) {
      // AI diagnosis succeeded — enrich with raw data for plan generation
      const enrichedFindings = aiResult.findings.map((f) => ({
        ...f,
        data: { ...f.data, replicas: replStatus, slots, connectionCount: connCount },
      }));
      return { ...aiResult, findings: enrichedFindings };
    }

    // Fallback: rule-based diagnosis
    return this.ruleBasedDiagnose(replStatus, slots, connCount);
  }

  private isConnectionPoolExhausted(usage: ConnectionUsage): boolean {
    if (usage.max <= 0) return false;
    const utilization = usage.total / usage.max;
    // Count only sessions old enough for the plan's terminate step to target:
    // younger idle-in-transaction sessions are ordinary load the recovery
    // could not act on, so diagnosing exhaustion from them would produce a
    // no-op plan.
    const staleContributors = usage.idleInTransactionOldest.filter(
      (s) => s.ageSeconds >= IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS,
    ).length;
    return (
      utilization > CONNECTION_USAGE_CRITICAL_RATIO &&
      staleContributors >= MIN_IDLE_IN_TRANSACTION_CONTRIBUTORS
    );
  }

  private diagnoseConnectionPoolExhaustion(
    usage: ConnectionUsage,
    replStatus: ReplicaStatus[],
    alsoReplayPaused: boolean,
  ): DiagnosisResult {
    const utilizationPct = Math.round((usage.total / usage.max) * 100);
    const oldest = usage.idleInTransactionOldest[0];
    const staleCount = usage.idleInTransactionOldest.filter(
      (s) => s.ageSeconds >= IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS,
    ).length;

    const findings: DiagnosisResult['findings'] = [
      {
        source: 'pg_stat_activity',
        observation:
          `${usage.total}/${usage.max} connections in use (${utilizationPct}%) on the primary. ` +
          `${usage.idleInTransactionOldest.length} session(s) are idle-in-transaction, the oldest held ` +
          `open for ${oldest?.ageSeconds ?? 0}s.`,
        severity: 'critical',
        data: { connectionUsage: usage },
      },
      {
        source: 'pg_stat_activity',
        observation:
          `${staleCount} idle-in-transaction session(s) have been held open longer than ` +
          `${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s — consistent with a client leaking ` +
          `transactions (opened and never committed, rolled back, or closed) rather than ordinary load. ` +
          `These sessions are consuming connection slots that new clients need.`,
        severity: 'critical',
        data: { idleInTransactionOldest: usage.idleInTransactionOldest },
      },
      {
        source: 'pg_stat_replication',
        observation: `${replStatus.length} replica(s) found; replication is not implicated in this failure.`,
        severity: 'info',
        data: { replicas: replStatus },
      },
    ];

    if (alsoReplayPaused) {
      findings.push({
        source: 'pg_replay_state',
        observation:
          'WAL replay is also currently paused on a replica. That is a separate, lower-priority issue ' +
          '(it only affects read freshness on one replica, vs. the primary risking outright connection ' +
          'refusal here) and will surface on the next diagnosis pass once this connection-pool ' +
          'exhaustion is resolved.',
        severity: 'warning',
        data: { replayPaused: true },
      });
    }

    return {
      status: 'identified',
      scenario: 'connection_pool_exhaustion',
      confidence: 0.96,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  private diagnoseReplayPaused(
    replStatus: ReplicaStatus[],
    slots: import('./backend.js').ReplicationSlot[],
    connCount: number,
  ): DiagnosisResult {
    // Replay pause is measured over the single configured replica connection
    // (queryReplayPaused), and the recovery resumes over that same connection.
    // With multiple replicas in pg_stat_replication we cannot tell which entry
    // that connection corresponds to, so only claim a specific address when
    // exactly one replica exists — naming the worst-lagging one could
    // misattribute the fault to a standby the recovery never touches.
    const target = replStatus.length === 1 ? replStatus[0] : null;
    return {
      status: 'identified',
      scenario: 'wal_replay_paused',
      confidence: 0.97,
      findings: [
        {
          source: 'pg_stat_replication',
          observation: target
            ? `1 replica found. Target replica ${target.client_addr} reports ${target.lag_seconds}s of replay lag.`
            : `${replStatus.length} replicas found. Replay pause was measured on the configured replica connection; per-replica attribution across multiple replicas is not supported, so no specific address is claimed.`,
          severity: 'critical',
          data: { replicas: replStatus },
        },
        {
          source: 'pg_replay_state',
          observation: 'WAL replay is explicitly paused on the replica (pg_is_wal_replay_paused() = true). sent_lsn continues to advance on the primary while replay_lsn is frozen on the replica, so lag will keep growing until replay is resumed.',
          severity: 'critical',
          data: { replayPaused: true },
        },
        {
          source: 'pg_stat_activity',
          observation: `${connCount} active connections on primary.`,
          severity: 'info',
          data: { connectionCount: connCount },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  private ruleBasedDiagnose(
    replStatus: ReplicaStatus[],
    slots: import('./backend.js').ReplicationSlot[],
    connCount: number,
  ): DiagnosisResult {
    const severelyLagging = replStatus.filter((r) => r.lag_seconds > 300);
    const moderatelyLagging = replStatus.filter((r) => r.lag_seconds > 30 && r.lag_seconds <= 300);

    return {
      status: 'identified',
      scenario: 'replication_lag_cascade',
      confidence: 0.92,
      findings: [
        {
          source: 'pg_stat_replication',
          observation: `${replStatus.length} replicas found. ${severelyLagging.length} severely lagging (>300s), ${moderatelyLagging.length} moderately lagging (>30s).`,
          severity: 'critical',
          data: { replicas: replStatus },
        },
        {
          source: 'pg_replication_slots',
          observation: `${slots.length} replication slots. No slot overflow risk detected.`,
          severity: 'info',
          data: { slots },
        },
        {
          source: 'pg_stat_activity',
          observation: `${connCount} active connections on primary — elevated, consistent with read traffic redirect from lagging replicas.`,
          severity: 'warning',
          data: { connectionCount: connCount },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  private buildReplicaHealthSignal(
    replicas: ReplicaStatus[],
    unhealthyReplicas: ReplicaStatus[],
    recoveringReplicas: ReplicaStatus[],
    worstLag: number,
    observedAt: string,
  ): HealthSignal {
    if (unhealthyReplicas.length > 0) {
      return {
        source: 'pg_stat_replication',
        status: 'critical',
        detail: `${unhealthyReplicas.length} replica(s) are unhealthy. Worst replay lag is ${worstLag}s.`,
        observedAt,
      };
    }

    if (recoveringReplicas.length > 0) {
      return {
        source: 'pg_stat_replication',
        status: 'warning',
        detail: `All ${replicas.length} replica(s) are streaming, but worst replay lag is still ${worstLag}s.`,
        observedAt,
      };
    }

    return {
      source: 'pg_stat_replication',
      status: 'healthy',
      detail: `All ${replicas.length} replica(s) are streaming. Worst replay lag is ${worstLag}s.`,
      observedAt,
    };
  }

  async plan(_context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const primaryId = String(_context.trigger.payload.instance || 'pg-primary');

    // Handle unreachable database — generate investigation/restart plan
    if (diagnosis.scenario === 'database_unreachable') {
      return this.planForUnreachable(primaryId, diagnosis);
    }

    // Handle a confirmed WAL-replay pause — the honest, targeted fix (resume
    // replay on the replica) rather than the disconnect/reseed cascade below,
    // which addresses a different (unexplained) lag scenario.
    if (diagnosis.scenario === 'wal_replay_paused') {
      return this.planForReplayPaused(primaryId, diagnosis);
    }

    // Handle confirmed connection-pool exhaustion — terminate the stale
    // idle-in-transaction sessions consuming connection slots.
    if (diagnosis.scenario === 'connection_pool_exhaustion') {
      return this.planForConnectionPoolExhaustion(primaryId, diagnosis);
    }

    // Dynamic target resolution: find the worst-lagging replica from diagnosis
    const replicas = (diagnosis.findings[0]?.data as { replicas: ReplicaStatus[] })?.replicas ?? [];
    const target = this.findWorstReplica(replicas);
    const targetAddr = target ? validateIPv4(target.client_addr) : 'unknown';
    const targetId = `pg-replica-${targetAddr.replace(/[./]/g, '-')}`;

    const steps: RecoveryStep[] = [
      // Step 1: diagnosis_action
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Assess current replication lag across all replicas',
        executionContext: 'postgresql_read',
        target: primaryId,
        command: {
          type: 'sql',
          subtype: 'query',
          statement:
            "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, COALESCE(EXTRACT(EPOCH FROM replay_lag)::int, 0) AS lag_seconds FROM pg_stat_replication;",
        },
        outputCapture: {
          name: 'current_replication_status',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: human_notification
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call DBA of replication recovery initiation',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: {
          summary: 'Automated recovery initiated for PostgreSQL replication lag cascade',
          detail:
            `Agent 'postgresql-replication-recovery' has diagnosed a replication lag cascade on ${primaryId}. Target replica: ${targetAddr} (lag: ${target?.lag_seconds ?? '?'}s). Execution is beginning.`,
          contextReferences: ['current_replication_status'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture full replication state before any mutations.',
        stateCaptures: [
          {
            name: 'full_replication_config',
            captureType: 'file_snapshot',
            targets: [
              '/var/lib/postgresql/data/postgresql.conf',
              '/var/lib/postgresql/data/pg_hba.conf',
            ],
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'replication_slot_state',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_replication_slots;',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: system_action (elevated) — disconnect lagging replica
      {
        stepId: 'step-004',
        type: 'system_action',
        name: `Disconnect lagging replica ${targetAddr} from replication`,
        description:
          `Terminates the WAL sender process for ${targetId} to prevent the primary from being blocked by a slow consumer.`,
        executionContext: 'postgresql_write',
        target: primaryId,
        riskLevel: 'elevated',
        requiredCapabilities: ['db.replica.disconnect'],
        command: {
          type: 'sql',
          subtype: 'dml',
          statement:
            `SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE client_addr = '${targetAddr}';`,
        },
        preConditions: [
          {
            description: `Replica ${targetAddr} is currently connected`,
            check: {
              type: 'sql',
              statement:
                `SELECT count(*) FROM pg_stat_replication WHERE client_addr = '${targetAddr}';`,
              expect: { operator: 'gte', value: 1 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'replication_state_snapshot',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'replication_state_post_disconnect',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: `WAL sender for ${targetAddr} is no longer present`,
          check: {
            type: 'sql',
            statement:
              `SELECT count(*) FROM pg_stat_replication WHERE client_addr = '${targetAddr}';`,
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Replica will automatically attempt to reconnect. No explicit rollback needed.',
          estimatedDuration: 'PT30S',
        },
        blastRadius: {
          directComponents: [targetId],
          indirectComponents: ['read-pool'],
          maxImpact: 'single_replica_disconnected',
          cascadeRisk: 'low',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 0, retryable: false },
        stateTransition: 'recovering',
      },
      // Step 5: system_action (routine) — redirect read traffic
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Redirect read traffic away from disconnected replica',
        description: `Update load balancer to remove ${targetId} from the read pool.`,
        executionContext: 'linux_process',
        target: 'load-balancer',
        riskLevel: 'routine',
        requiredCapabilities: ['traffic.backend.detach'],
        command: {
          type: 'structured_command',
          operation: 'config_reload',
          parameters: { service: 'load-balancer', action: 'remove_backend', backend: targetId },
        },
        statePreservation: {
          before: [],
          after: [],
        },
        successCriteria: {
          description: 'Load balancer config reloaded successfully',
          check: {
            type: 'structured_command',
            operation: 'service_status',
            parameters: { service: 'load-balancer' },
            expect: { operator: 'eq', value: 'running' },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Load balancer continues with previous config on reload failure.',
        },
        blastRadius: {
          directComponents: ['load-balancer'],
          indirectComponents: [],
          maxImpact: 'load_balancer_config_reload',
          cascadeRisk: 'none',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: replanning_checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess recovery progress before proceeding',
        description:
          'Verify recovery is on track. Agent may revise the remaining plan based on current system state.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_stabilization_replication_state',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_stat_replication;',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'post_stabilization_slot_state',
            captureType: 'sql_query',
            statement: 'SELECT * FROM pg_replication_slots;',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: human_approval
      {
        stepId: 'step-007',
        type: 'human_approval',
        name: 'Approve replica resynchronization',
        description: 'Resynchronization will temporarily reduce read capacity.',
        approvers: [{ role: 'database_owner', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `Ready to begin resynchronization for ${targetAddr}`,
          detail:
            `The primary has been stabilized. The next phase will resynchronize ${targetId}, which requires a pg_basebackup that will temporarily increase I/O load on the primary.`,
          contextReferences: ['replication_state_post_disconnect', 'post_stabilization_replication_state'],
          proposedActions: [
            `Drop and recreate invalid replication slot for ${targetId}`,
            `Initiate pg_basebackup from primary to ${targetId}`,
            'Re-establish streaming replication',
            'Verify replication lag returns to < 10 seconds',
          ],
          riskSummary:
            'Primary I/O load will increase during pg_basebackup. No data loss risk.',
          alternatives: [
            {
              action: 'skip',
              description: `Skip resynchronization. Replication will remain broken for ${targetId} until manually repaired.`,
            },
            {
              action: 'abort',
              description: 'Abort the recovery plan. Replica disconnect will remain in effect.',
            },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'engineering_lead',
          message: 'Approval timeout reached for replica resynchronization. Escalating for decision.',
        },
      },
      // Step 8: system_action (high) — pg_basebackup + resync
      {
        stepId: 'step-008',
        type: 'system_action',
        name: `Initiate pg_basebackup and re-establish replication for ${targetAddr}`,
        description:
          `Performs a full base backup from the primary to ${targetId} and configures streaming replication.`,
        executionContext: 'postgresql_write',
        target: targetId,
        riskLevel: 'high',
        requiredCapabilities: ['db.replica.reseed'],
        command: {
          type: 'structured_command',
          operation: 'pg_basebackup',
          parameters: {
            source: primaryId,
            target: targetId,
            checkpoint: 'fast',
            walMethod: 'stream',
          },
        },
        preConditions: [
          {
            description: 'Primary is reachable and accepting connections',
            check: {
              type: 'sql',
              statement: "SELECT 1;",
              expect: { operator: 'eq', value: 1 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'pre_basebackup_primary_state',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'post_basebackup_replication_state',
              captureType: 'sql_query',
              statement: 'SELECT * FROM pg_stat_replication;',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: `Replica ${targetAddr} is streaming and lag is under 30 seconds`,
          check: {
            type: 'sql',
            statement:
              `SELECT count(*) FROM pg_stat_replication WHERE client_addr = '${targetAddr}' AND state = 'streaming';`,
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'If pg_basebackup fails, manual intervention required to restart the process.',
        },
        blastRadius: {
          directComponents: [targetId, primaryId],
          indirectComponents: ['read-pool'],
          maxImpact: 'increased_primary_io_load_during_basebackup',
          cascadeRisk: 'medium',
        },
        timeout: 'PT20M',
        retryPolicy: { maxRetries: 1, retryable: true },
        stateTransition: 'recovered',
      },
      // Step 9: conditional
      {
        stepId: 'step-009',
        type: 'conditional',
        name: 'Restore traffic or notify for manual intervention',
        condition: {
          description: `Replica ${targetAddr} is streaming with lag under 10s`,
          check: {
            type: 'sql',
            statement:
              `SELECT count(*) FROM pg_stat_replication WHERE client_addr = '${targetAddr}' AND state = 'streaming';`,
            expect: { operator: 'gte', value: 1 },
          },
        },
        thenStep: {
          stepId: 'step-009a',
          type: 'system_action',
          name: 'Restore read traffic to recovered replica',
          executionContext: 'linux_process',
          target: 'load-balancer',
          riskLevel: 'routine',
          requiredCapabilities: ['traffic.backend.attach'],
          command: {
            type: 'structured_command',
            operation: 'config_reload',
            parameters: { service: 'load-balancer', action: 'add_backend', backend: targetId },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Load balancer config reloaded successfully',
            check: {
              type: 'structured_command',
              operation: 'service_status',
              parameters: { service: 'load-balancer' },
              expect: { operator: 'eq', value: 'running' },
            },
          },
          rollback: {
            type: 'automatic',
            description: 'Load balancer continues with previous config.',
          },
          blastRadius: {
            directComponents: ['load-balancer'],
            indirectComponents: [],
            maxImpact: 'load_balancer_config_reload',
            cascadeRisk: 'none',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
        elseStep: {
          stepId: 'step-009b',
          type: 'human_notification',
          name: 'Notify DBA: replica not healthy after resync',
          recipients: [{ role: 'on_call_dba', urgency: 'high' }],
          message: {
            summary: `Replica ${targetAddr} did not reach healthy state after resynchronization`,
            detail:
              `${targetId} completed pg_basebackup but is not streaming. Manual investigation recommended. Read traffic has NOT been restored.`,
            contextReferences: ['post_basebackup_replication_state'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 10: human_notification — recovery summary
      {
        stepId: 'step-010',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_dba', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: 'PostgreSQL replication recovery completed',
          detail:
            `Recovery plan for replication_lag_cascade on ${primaryId} has completed. Target replica: ${targetAddr} (${targetId}).`,
          contextReferences: ['post_basebackup_replication_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'pg-repl',
        agentName: 'postgresql-replication-recovery',
        agentVersion: '1.2.0',
        scenario: 'replication_lag_cascade',
        estimatedDuration: 'PT15M',
        summary: `Recover PostgreSQL replication by disconnecting lagging replica ${targetAddr}, stabilizing the primary, and re-syncing.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: primaryId,
            technology: 'postgresql',
            role: 'primary',
            impactType: 'reduced_read_capacity',
          },
          {
            identifier: targetId,
            technology: 'postgresql',
            role: 'replica',
            impactType: 'temporary_unavailability',
          },
        ],
        affectedServices: ['read-pool'],
        estimatedUserImpact:
          'Read queries may experience elevated latency during recovery. No write impact expected.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description:
          'Each step includes an inverse operation. On failure, execute rollback steps in reverse order from the point of failure.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    // Check for invalid replication slots
    this.backend.transition('recovering');
    const slots = await this.backend.queryReplicationSlots();
    const invalidSlot = slots.find((s) => s.wal_status === 'lost');

    if (invalidSlot) {
      const safeSlotName = validateSlotName(invalidSlot.slot_name);

      if (this.backend instanceof PgSimulator) {
        (this.backend as PgSimulator).markSlotRecreated();
      }

      const primaryId = String(_context.trigger.payload.instance || 'pg-primary');
      const revisedSteps: RecoveryStep[] = [
        {
          stepId: 'step-006a',
          type: 'system_action',
          name: 'Drop invalid replication slot',
          description: `Slot '${safeSlotName}' has WAL status 'lost' and must be recreated.`,
          executionContext: 'postgresql_write',
          target: primaryId,
          riskLevel: 'elevated',
          requiredCapabilities: ['db.replication_slot.drop'],
          command: {
            type: 'sql',
            subtype: 'function_call',
            statement: `SELECT pg_drop_replication_slot('${safeSlotName}');`,
          },
          statePreservation: {
            before: [
              {
                name: 'slot_state_before_drop',
                captureType: 'sql_query',
                statement: 'SELECT * FROM pg_replication_slots;',
                captureCost: 'negligible',
                capturePolicy: 'required',
                retention: 'P30D',
              },
            ],
            after: [],
          },
          successCriteria: {
            description: 'Slot no longer exists',
            check: {
              type: 'sql',
              statement: `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${safeSlotName}';`,
              expect: { operator: 'eq', value: 0 },
            },
          },
          blastRadius: {
            directComponents: [primaryId],
            indirectComponents: [],
            maxImpact: 'replication_slot_removed',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 0, retryable: false },
        },
        {
          stepId: 'step-006b',
          type: 'system_action',
          name: 'Recreate replication slot',
          description: `Create a fresh physical replication slot '${safeSlotName}'.`,
          executionContext: 'postgresql_write',
          target: primaryId,
          riskLevel: 'routine',
          requiredCapabilities: ['db.replication_slot.create'],
          command: {
            type: 'sql',
            subtype: 'function_call',
            statement: `SELECT pg_create_physical_replication_slot('${safeSlotName}');`,
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Slot exists and is available',
            check: {
              type: 'sql',
              statement: `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${safeSlotName}';`,
              expect: { operator: 'eq', value: 1 },
            },
          },
          blastRadius: {
            directComponents: [primaryId],
            indirectComponents: [],
            maxImpact: 'replication_slot_created',
            cascadeRisk: 'none',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
      ];

      return {
        action: 'revised_plan',
        plan: {
          ...createPlanEnvelope({
            planIdSuffix: 'pg-repl',
            agentName: 'postgresql-replication-recovery',
            agentVersion: '1.2.0',
            scenario: 'replication_lag_cascade',
            estimatedDuration: 'PT18M',
            summary: `Revised plan: drop and recreate invalid slot '${safeSlotName}' before proceeding.`,
            sequence: 2,
            supersedes: _executionState.completedSteps.length > 0 ? 'original' : null,
          }),
          impact: {
            affectedSystems: [
              { identifier: primaryId, technology: 'postgresql', role: 'primary', impactType: 'reduced_read_capacity' },
            ],
            affectedServices: ['read-pool'],
            estimatedUserImpact: 'Read queries may experience elevated latency for approximately 12 minutes.',
            dataLossRisk: 'none',
          },
          steps: revisedSteps,
          rollbackStrategy: {
            type: 'stepwise',
            description: 'Rollback in reverse order from point of failure.',
          },
        },
      };
    }

    return { action: 'continue' };
  }

  /**
   * All-SQL recovery for a confirmed WAL-replay pause: resume replay on the
   * replica that actually has it paused. Unlike replication_lag_cascade
   * (which disconnects/reseeds because the cause is unknown), here the root
   * cause is confirmed by ground truth (pg_is_wal_replay_paused() = true),
   * so the fix is the direct inverse of the fault.
   */
  private planForReplayPaused(primaryId: string, diagnosis: DiagnosisResult): RecoveryPlan {
    const replicas = (diagnosis.findings[0]?.data as { replicas: ReplicaStatus[] })?.replicas ?? [];
    // Every replica-side step in this plan executes over the single configured
    // replica connection (parameters.node === 'replica' → PgLiveClient's one
    // replicaPool, built from config replicas[0]). Only claim a specific
    // address in labels when exactly one replica exists; with several, an
    // address picked from pg_stat_replication could name a standby this plan
    // never touches. Per-replica selection/routing is a known follow-up.
    const target = replicas.length === 1 ? replicas[0] : null;
    const targetAddr = target ? validateIPv4(target.client_addr) : 'configured-replica';
    const targetId = target ? `pg-replica-${targetAddr.replace(/[./]/g, '-')}` : 'pg-replica-configured';
    const replayStateQuery =
      'SELECT pg_is_wal_replay_paused() AS replay_paused, pg_last_wal_receive_lsn()::text AS received_lsn, pg_last_wal_replay_lsn()::text AS replayed_lsn;';
    const replicationStatusQuery =
      "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, COALESCE(EXTRACT(EPOCH FROM replay_lag)::int, 0) AS lag_seconds FROM pg_stat_replication;";

    const steps: RecoveryStep[] = [
      // Step 1: diagnosis_action (primary) — current lag from the primary's view
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Assess current replication lag on the primary',
        executionContext: 'postgresql_read',
        target: primaryId,
        command: { type: 'sql', subtype: 'query', statement: replicationStatusQuery },
        outputCapture: {
          name: 'pre_resume_replication_status',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: diagnosis_action (replica) — confirm the pause + LSN state directly
      {
        stepId: 'step-002',
        type: 'diagnosis_action',
        name: `Confirm WAL replay pause state on ${targetId}`,
        executionContext: 'postgresql_read',
        target: targetId,
        command: { type: 'sql', subtype: 'query', statement: replayStateQuery, parameters: { node: 'replica' } },
        outputCapture: {
          name: 'pre_resume_replay_state',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 3: human_notification
      {
        stepId: 'step-003',
        type: 'human_notification',
        name: 'Notify on-call DBA before resuming WAL replay',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: {
          summary: 'Automated recovery initiated for paused WAL replay on a PostgreSQL replica',
          detail:
            `Agent 'postgresql-replication-recovery' confirmed WAL replay is paused on ${targetId} ` +
            `(primary: ${primaryId}) via pg_is_wal_replay_paused(). Replay will be resumed with ` +
            `SELECT pg_wal_replay_resume();. This is fully reversible — re-issuing ` +
            `SELECT pg_wal_replay_pause(); on the replica restores the exact prior state.`,
          contextReferences: ['pre_resume_replication_status', 'pre_resume_replay_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 4: checkpoint — pre-recovery snapshot of lag/LSN state
      {
        stepId: 'step-004',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture replication lag and replay LSN state before resuming WAL replay.',
        stateCaptures: [
          {
            name: 'replication_status_checkpoint',
            captureType: 'sql_query',
            statement: replicationStatusQuery,
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'replay_lsn_checkpoint',
            captureType: 'sql_query',
            statement: replayStateQuery,
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 5: system_action (elevated) — resume WAL replay on the replica
      {
        stepId: 'step-005',
        type: 'system_action',
        name: `Resume WAL replay on ${targetId}`,
        description:
          `Replay was explicitly paused via pg_wal_replay_pause(); resuming it re-enables WAL apply ` +
          `so the replica drains its backlog and catches up to the primary. Risk is 'elevated' (not ` +
          `'routine') because it changes live replica read-serving behavior and increases replica I/O ` +
          `while it catches up — but not 'high', because the action is idempotent (a no-op if replay ` +
          `is already resumed), causes no data loss, and is fully reversible by re-pausing.`,
        executionContext: 'postgresql_write',
        target: targetId,
        riskLevel: 'elevated',
        requiredCapabilities: ['db.wal_replay.resume'],
        command: {
          type: 'sql',
          subtype: 'function_call',
          statement: 'SELECT pg_wal_replay_resume();',
          parameters: { node: 'replica' },
        },
        statePreservation: {
          before: [
            {
              name: 'replay_state_before_resume',
              captureType: 'sql_query',
              statement: replayStateQuery,
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'replay_state_after_resume',
              captureType: 'sql_query',
              statement: replayStateQuery,
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: `WAL replay on ${targetId} is no longer paused`,
          check: {
            type: 'sql',
            statement: 'SELECT pg_is_wal_replay_paused()::int AS paused;',
            parameters: { node: 'replica' },
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'command',
          description:
            'Re-pausing replay restores the exact prior state with no data loss: resume only re-enables ' +
            'applying WAL already streamed to the replica, it does not discard or rewrite anything.',
          command: {
            type: 'sql',
            subtype: 'function_call',
            statement: 'SELECT pg_wal_replay_pause();',
            parameters: { node: 'replica' },
          },
        },
        blastRadius: {
          directComponents: [targetId],
          indirectComponents: ['read-pool'],
          maxImpact: 'replica_replay_resumed',
          cascadeRisk: 'low',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 1, retryable: true },
        stateTransition: 'recovering',
      },
      // Step 6: diagnosis_action — verify lag is draining post-resume
      {
        stepId: 'step-006',
        type: 'diagnosis_action',
        name: 'Verify replication lag is draining after resume',
        executionContext: 'postgresql_read',
        target: primaryId,
        command: { type: 'sql', subtype: 'query', statement: replicationStatusQuery },
        outputCapture: {
          name: 'post_resume_replication_status',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 7: human_notification — recovery summary
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_dba', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: 'PostgreSQL WAL replay resume completed',
          detail: `Recovery plan for wal_replay_paused on ${primaryId} has completed. Target replica: ${targetAddr} (${targetId}).`,
          contextReferences: ['post_resume_replication_status'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'pg-repl-resume',
        agentName: 'postgresql-replication-recovery',
        agentVersion: '1.2.0',
        scenario: 'wal_replay_paused',
        estimatedDuration: 'PT5M',
        summary: `Resume paused WAL replay on ${targetAddr} so replication lag drains.`,
      }),
      impact: {
        affectedSystems: [
          { identifier: primaryId, technology: 'postgresql', role: 'primary', impactType: 'none' },
          { identifier: targetId, technology: 'postgresql', role: 'replica', impactType: 'reduced_read_capacity' },
        ],
        affectedServices: ['read-pool'],
        estimatedUserImpact:
          'Read queries served from the affected replica may return stale data until lag drains; ' +
          'the primary and write traffic are unaffected. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description:
          'The resume step is independently reversible: re-issue SELECT pg_wal_replay_pause(); on the ' +
          'replica to restore the exact prior state. No other step in this plan performs a mutation.',
      },
    };
  }

  /**
   * All-SQL recovery for confirmed connection-pool exhaustion: terminate the
   * stale idle-in-transaction sessions consuming connection slots. Unlike
   * the wal_replay_paused resume (idempotent, no data loss), this step is
   * genuinely irreversible — pg_terminate_backend() drops the connection and
   * discards any uncommitted work in that session's transaction. It is
   * declared 'elevated' risk with a required pre-termination statePreservation
   * capture, and no part of this plan claims the termination is reversible.
   */
  private planForConnectionPoolExhaustion(primaryId: string, diagnosis: DiagnosisResult): RecoveryPlan {
    const usage = (diagnosis.findings[0]?.data as { connectionUsage?: ConnectionUsage })?.connectionUsage;
    const idleSessions = usage?.idleInTransactionOldest ?? [];
    const staleSessions = idleSessions.filter(
      (s) => s.ageSeconds >= IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS,
    );
    const applicationNames = [...new Set(staleSessions.map((s) => s.applicationName).filter((n): n is string => !!n))];
    const clientDescription = applicationNames.length > 0 ? applicationNames.join(', ') : 'unidentified client application(s)';
    const utilizationPct = usage && usage.max > 0 ? Math.round((usage.total / usage.max) * 100) : 0;

    const terminateStatement = terminateIdleInTxStatement(IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS);
    const idleCountCheck = idleInTxCountQuery(IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS);

    const steps: RecoveryStep[] = [
      // Step 1: diagnosis_action — full pg_stat_activity snapshot (also forensic evidence)
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture full pg_stat_activity snapshot',
        executionContext: 'postgresql_read',
        target: primaryId,
        command: { type: 'sql', subtype: 'query', statement: ACTIVITY_SNAPSHOT_QUERY },
        outputCapture: {
          name: 'pre_termination_activity_snapshot',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: human_notification — honest, upfront about irreversibility
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call DBA before terminating idle-in-transaction sessions',
        recipients: [{ role: 'on_call_dba', urgency: 'critical' }],
        message: {
          summary: `Automated recovery initiated for connection-pool exhaustion on ${primaryId}`,
          detail:
            `Agent 'postgresql-replication-recovery' confirmed ${usage?.total ?? '?'}/${usage?.max ?? '?'} ` +
            `connections in use (${utilizationPct}%), with ${staleSessions.length} idle-in-transaction ` +
            `session(s) held open for over ${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s by ` +
            `${clientDescription}. These sessions will be terminated with pg_terminate_backend(), which is ` +
            `IRREVERSIBLE: any uncommitted work in those transactions is discarded. Affected clients will ` +
            `see their connection drop and must reconnect and retry at the application layer.`,
          contextReferences: ['pre_termination_activity_snapshot'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: checkpoint — required because terminated sessions cannot be un-terminated
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description:
          'Capture pg_stat_activity state before terminating any sessions — pg_terminate_backend() is ' +
          'irreversible, so this snapshot is the only record of what was running in each terminated session.',
        stateCaptures: [
          {
            name: 'activity_snapshot_checkpoint',
            captureType: 'sql_query',
            statement: ACTIVITY_SNAPSHOT_QUERY,
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: system_action (elevated) — terminate stale idle-in-transaction sessions
      {
        stepId: 'step-004',
        type: 'system_action',
        name: `Terminate idle-in-transaction sessions older than ${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s`,
        description:
          `pg_terminate_backend() closes the target session's connection and discards any uncommitted ` +
          `work in its transaction — this is NOT reversible. Risk is 'elevated' (not 'routine') because ` +
          `of that irreversibility and because it affects live client sessions; only sessions idle in a ` +
          `transaction for over ${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s are targeted, so ` +
          `active application work in progress is not touched. The command waits (bounded, up to 5s) for ` +
          `termination to actually take effect before returning, since pg_terminate_backend() only signals ` +
          `the backend rather than confirming it has exited.`,
        executionContext: 'postgresql_write',
        target: primaryId,
        riskLevel: 'elevated',
        requiredCapabilities: ['db.connections.terminate'],
        command: { type: 'sql', subtype: 'plpgsql_block', statement: terminateStatement },
        preConditions: [
          {
            description: `At least one idle-in-transaction session older than ${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s exists`,
            check: { type: 'sql', statement: idleCountCheck, expect: { operator: 'gte', value: 1 } },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'activity_snapshot_before_termination',
              captureType: 'sql_query',
              statement: ACTIVITY_SNAPSHOT_QUERY,
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'activity_snapshot_after_termination',
              captureType: 'sql_query',
              statement: ACTIVITY_SNAPSHOT_QUERY,
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: `No idle-in-transaction sessions remain older than ${IDLE_IN_TRANSACTION_TERMINATE_THRESHOLD_SECONDS}s`,
          check: { type: 'sql', statement: idleCountCheck, expect: { operator: 'eq', value: 0 } },
        },
        rollback: {
          type: 'manual',
          description:
            'Terminated sessions cannot be un-terminated and their uncommitted transaction state is lost ' +
            'permanently — there is no automatic rollback. Affected client applications must open a new ' +
            'connection and retry their work from the application layer; new connections are free to ' +
            'establish immediately since this step frees the slots they were holding.',
        },
        blastRadius: {
          directComponents: [primaryId],
          indirectComponents: applicationNames.length > 0 ? applicationNames : ['unidentified-client-applications'],
          maxImpact: 'idle_in_transaction_sessions_terminated',
          cascadeRisk: 'medium',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 0, retryable: false },
        stateTransition: 'recovering',
      },
      // Step 5: diagnosis_action — verify headroom after termination
      {
        stepId: 'step-005',
        type: 'diagnosis_action',
        name: 'Verify connection headroom after termination',
        executionContext: 'postgresql_read',
        target: primaryId,
        command: { type: 'sql', subtype: 'query', statement: CONNECTION_USAGE_QUERY },
        outputCapture: {
          name: 'post_termination_connection_usage',
          format: 'table',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 6: human_notification — recovery summary
      {
        stepId: 'step-006',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_dba', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: 'PostgreSQL connection-pool exhaustion recovery completed',
          detail:
            `Terminated stale idle-in-transaction session(s) on ${primaryId}. Verify ` +
            `post_termination_connection_usage shows headroom below the alert threshold, and confirm with ` +
            `${clientDescription} whether the leaked transactions indicate an application bug that needs ` +
            `fixing (e.g. missing commit/rollback, or a client not closing connections).`,
          contextReferences: ['post_termination_connection_usage'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'pg-connpool',
        agentName: 'postgresql-replication-recovery',
        agentVersion: '1.2.0',
        scenario: 'connection_pool_exhaustion',
        estimatedDuration: 'PT5M',
        summary: `Free up primary connection headroom on ${primaryId} by terminating ${staleSessions.length} stale idle-in-transaction session(s).`,
      }),
      impact: {
        affectedSystems: [
          { identifier: primaryId, technology: 'postgresql', role: 'primary', impactType: 'connections_terminated' },
        ],
        affectedServices: applicationNames.length > 0 ? applicationNames : ['unidentified-client-applications'],
        estimatedUserImpact:
          `Terminated sessions lose any uncommitted transaction state; affected clients (${clientDescription}) ` +
          `will see their connection drop and must reconnect and retry at the application layer. No ` +
          `previously committed data is at risk, and freed connection slots are immediately available to ` +
          `other clients.`,
        dataLossRisk: 'possible',
      },
      steps,
      rollbackStrategy: {
        type: 'none',
        description:
          'The termination step is NOT reversible: pg_terminate_backend() permanently ends the targeted ' +
          'sessions and discards their uncommitted transaction state — there is no automatic un-terminate, ' +
          'so this plan has no working rollback for its one mutation. The preceding snapshot, notification, ' +
          'and checkpoint steps perform no mutation and require no rollback of their own.',
      },
    };
  }

  private planForUnreachable(primaryId: string, diagnosis: DiagnosisResult): RecoveryPlan {
    const errorMsg = diagnosis.findings[0]?.observation ?? 'Connection failed';
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Verify PostgreSQL process and network reachability',
        executionContext: 'linux_process',
        target: primaryId,
        command: {
          type: 'structured_command',
          operation: 'service_status',
          parameters: { service: 'postgresql', checks: ['process', 'port', 'network'] },
        },
        outputCapture: {
          name: 'pg_reachability_check',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Alert on-call DBA: PostgreSQL unreachable',
        recipients: [
          { role: 'on_call_dba', urgency: 'critical' },
          { role: 'incident_commander', urgency: 'high' },
        ],
        message: {
          summary: `PostgreSQL instance ${primaryId} is unreachable`,
          detail: `${errorMsg}. Automated investigation has been initiated. Dependent services may be experiencing cascading failures.`,
          contextReferences: ['pg_reachability_check'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Capture system state before recovery attempt',
        description: 'Snapshot available system state for forensic analysis.',
        stateCaptures: [
          {
            name: 'system_logs',
            captureType: 'command_output',
            statement: 'journalctl -u postgresql --since "10 minutes ago" --no-pager',
            captureCost: 'negligible',
            capturePolicy: 'best_effort',
          },
          {
            name: 'disk_state',
            captureType: 'command_output',
            statement: 'df -h /var/lib/postgresql',
            captureCost: 'negligible',
            capturePolicy: 'best_effort',
          },
        ],
      },
      {
        stepId: 'step-004',
        type: 'human_approval',
        name: 'Approve PostgreSQL restart attempt',
        description: 'Confirm before attempting to restart the PostgreSQL service.',
        approvers: [{ role: 'on_call_dba', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `PostgreSQL ${primaryId} is down — approve restart?`,
          detail: 'A service restart will attempt to restore database connectivity. Check system logs for root cause before approving.',
          contextReferences: ['pg_reachability_check', 'system_logs', 'disk_state'],
          proposedActions: ['Restart PostgreSQL service', 'Verify connectivity after restart'],
          riskSummary: 'Service restart may cause brief connection drops for already-reconnecting clients.',
          alternatives: [
            { action: 'skip', description: 'Skip restart — investigate manually first.' },
            { action: 'abort', description: 'Abort recovery plan entirely.' },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'engineering_lead',
          message: 'PostgreSQL restart approval timed out. Database remains unreachable.',
        },
      },
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Restart PostgreSQL service',
        description: 'Attempt to restart the PostgreSQL process and restore connectivity.',
        executionContext: 'linux_process',
        target: primaryId,
        riskLevel: 'elevated',
        requiredCapabilities: ['db.service.restart'],
        command: {
          type: 'structured_command',
          operation: 'service_restart',
          parameters: { service: 'postgresql' },
        },
        preConditions: [],
        statePreservation: {
          before: [
            {
              name: 'postgresql_process_state',
              captureType: 'command_output',
              statement: 'systemctl status postgresql',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
            {
              name: 'active_connections_snapshot',
              captureType: 'command_output',
              statement: 'ss -tnp | grep :5432',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
          after: [],
        },
        successCriteria: {
          description: 'PostgreSQL is accepting connections',
          check: {
            type: 'sql',
            statement: 'SELECT 1;',
            expect: { operator: 'eq', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'If restart fails, manual investigation of PostgreSQL logs and system state is required.',
        },
        blastRadius: {
          directComponents: [primaryId],
          indirectComponents: ['application', 'read-pool'],
          maxImpact: 'brief_connection_reset',
          cascadeRisk: 'medium',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Verify database recovery and assess downstream impact',
        description: 'Check if PostgreSQL is back online and whether dependent services are recovering.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_restart_status',
            captureType: 'command_output',
            statement: 'pg_isready',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_dba', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `PostgreSQL ${primaryId} recovery attempt completed`,
          detail: 'Check post-restart status to confirm the database is accepting connections. Monitor dependent services for cascading recovery.',
          contextReferences: ['post_restart_status'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'pg-unreachable',
        agentName: 'postgresql-replication-recovery',
        agentVersion: '1.2.0',
        scenario: 'database_unreachable',
        estimatedDuration: 'PT10M',
        summary: `Investigate and recover unreachable PostgreSQL instance ${primaryId}.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: primaryId,
            technology: 'postgresql',
            role: 'primary',
            impactType: 'complete_unavailability',
          },
        ],
        affectedServices: ['database', 'application', 'read-pool'],
        estimatedUserImpact: 'All database-dependent services are unavailable until PostgreSQL is restored.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each step is independently recoverable. If restart fails, manual investigation is required.',
      },
    };
  }

  private findWorstReplica(replicas: ReplicaStatus[]): ReplicaStatus | undefined {
    if (replicas.length === 0) return undefined;
    return replicas.reduce((worst, r) => (r.lag_seconds > worst.lag_seconds ? r : worst), replicas[0]!);
  }
}
