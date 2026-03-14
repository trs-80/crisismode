import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { pgReplicationManifest } from './manifest.js';
import { PgSimulator } from './simulator.js';

export class PgReplicationAgent implements RecoveryAgent {
  manifest = pgReplicationManifest;
  simulator = new PgSimulator();

  async diagnose(context: AgentContext): Promise<DiagnosisResult> {
    const replStatus = this.simulator.queryReplicationStatus();
    const slots = this.simulator.queryReplicationSlots();
    const connCount = this.simulator.queryConnectionCount();

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

  async plan(_context: AgentContext, _diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const now = new Date().toISOString();
    const steps: RecoveryStep[] = [
      // Step 1: diagnosis_action
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Assess current replication lag across all replicas',
        executionContext: 'postgresql_read',
        target: 'pg-primary-us-east-1',
        command: {
          type: 'sql',
          subtype: 'query',
          statement:
            "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, (extract(epoch FROM now() - pg_last_xact_replay_timestamp()))::int AS lag_seconds FROM pg_stat_replication;",
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
            "Agent 'postgresql-replication-recovery' has diagnosed a replication lag cascade on pg-primary-us-east-1. A recovery plan has been approved and execution is beginning.",
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
        name: 'Disconnect lagging replica from replication',
        description:
          'Terminates the WAL sender process for pg-replica-us-east-1b to prevent the primary from being blocked by a slow consumer.',
        executionContext: 'postgresql_write',
        target: 'pg-primary-us-east-1',
        riskLevel: 'elevated',
        command: {
          type: 'sql',
          subtype: 'dml',
          statement:
            "SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming';",
        },
        preConditions: [
          {
            description: 'Replica is currently connected and streaming',
            check: {
              type: 'sql',
              statement:
                "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming';",
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
          description: 'WAL sender process for the target replica is no longer present',
          check: {
            type: 'sql',
            statement:
              "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52';",
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Replica will automatically attempt to reconnect. No explicit rollback needed.',
          estimatedDuration: 'PT30S',
        },
        blastRadius: {
          directComponents: ['pg-replica-us-east-1b'],
          indirectComponents: ['user-api-read-pool'],
          maxImpact: 'single_replica_disconnected',
          cascadeRisk: 'low',
        },
        timeout: 'PT60S',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 5: system_action (routine) — redirect read traffic
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Redirect read traffic away from disconnected replica',
        description: 'Update HAProxy to remove pg-replica-us-east-1b from the read pool.',
        executionContext: 'linux_process',
        target: 'haproxy-us-east-1',
        riskLevel: 'routine',
        command: {
          type: 'structured_command',
          operation: 'config_reload',
          parameters: { service: 'haproxy', action: 'remove_backend', backend: 'pg-replica-us-east-1b' },
        },
        statePreservation: {
          before: [],
          after: [],
        },
        successCriteria: {
          description: 'HAProxy config reloaded successfully',
          check: {
            type: 'structured_command',
            operation: 'service_status',
            parameters: { service: 'haproxy' },
            expect: { operator: 'eq', value: 'running' },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'HAProxy continues with previous config on reload failure.',
        },
        blastRadius: {
          directComponents: ['haproxy-us-east-1'],
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
          summary: 'Ready to begin replica resynchronization',
          detail:
            'The primary has been stabilized and remaining replicas are catching up. The next phase will resynchronize pg-replica-us-east-1b, which requires a pg_basebackup that will temporarily increase I/O load on the primary.',
          contextReferences: ['replication_state_post_disconnect', 'post_stabilization_replication_state'],
          proposedActions: [
            'Drop and recreate invalid replication slot for pg-replica-us-east-1b',
            'Initiate pg_basebackup from primary to pg-replica-us-east-1b',
            'Re-establish streaming replication',
            'Verify replication lag returns to < 10 seconds',
          ],
          riskSummary:
            'Read capacity reduced by ~33% for estimated 8-12 minutes. Primary I/O load will increase during pg_basebackup. No data loss risk.',
          alternatives: [
            {
              action: 'skip',
              description:
                'Skip resynchronization. Replication will remain broken for pg-replica-us-east-1b until manually repaired.',
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
          message:
            'Approval timeout reached for replica resynchronization. Escalating for decision.',
        },
      },
      // Step 8: system_action (high) — pg_basebackup + resync
      {
        stepId: 'step-008',
        type: 'system_action',
        name: 'Initiate pg_basebackup and re-establish replication',
        description:
          'Performs a full base backup from the primary to pg-replica-us-east-1b and configures streaming replication.',
        executionContext: 'postgresql_write',
        target: 'pg-replica-us-east-1b',
        riskLevel: 'high',
        command: {
          type: 'structured_command',
          operation: 'pg_basebackup',
          parameters: {
            source: 'pg-primary-us-east-1',
            target: 'pg-replica-us-east-1b',
            slot: 'replica_us_east_1b',
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
              statement:
                'SELECT * FROM pg_stat_replication; SELECT * FROM pg_replication_slots;',
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
          description: 'Replica is streaming and lag is under 30 seconds',
          check: {
            type: 'sql',
            statement:
              "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming';",
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description:
            'If pg_basebackup fails, the replica data directory may be in an inconsistent state. Manual intervention required to restart the process or restore from a known good backup.',
        },
        blastRadius: {
          directComponents: ['pg-replica-us-east-1b', 'pg-primary-us-east-1'],
          indirectComponents: ['user-api-read-pool', 'reporting-service'],
          maxImpact: 'increased_primary_io_load_during_basebackup',
          cascadeRisk: 'medium',
        },
        timeout: 'PT20M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 9: conditional
      {
        stepId: 'step-009',
        type: 'conditional',
        name: 'Restore traffic or notify for manual intervention',
        condition: {
          description: 'Replica is streaming and lag is under threshold',
          check: {
            type: 'sql',
            statement:
              "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming' AND (extract(epoch FROM replay_lag))::int < 10;",
            expect: { operator: 'gte', value: 1 },
          },
        },
        thenStep: {
          stepId: 'step-009a',
          type: 'system_action',
          name: 'Restore read traffic to recovered replica',
          executionContext: 'linux_process',
          target: 'haproxy-us-east-1',
          riskLevel: 'routine',
          command: {
            type: 'structured_command',
            operation: 'config_reload',
            parameters: { service: 'haproxy', action: 'add_backend', backend: 'pg-replica-us-east-1b' },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'HAProxy config reloaded successfully',
            check: {
              type: 'structured_command',
              operation: 'service_status',
              parameters: { service: 'haproxy' },
              expect: { operator: 'eq', value: 'running' },
            },
          },
          rollback: {
            type: 'automatic',
            description: 'HAProxy continues with previous config.',
          },
          blastRadius: {
            directComponents: ['haproxy-us-east-1'],
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
            summary: 'Replica did not reach healthy state after resynchronization',
            detail:
              'pg-replica-us-east-1b completed pg_basebackup but replication lag has not dropped below threshold. Manual investigation is recommended. Read traffic has NOT been restored to this replica.',
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
            'Recovery plan for replication_lag_cascade on pg-primary-us-east-1 has completed. The lagging replica (pg-replica-us-east-1b) was disconnected, the primary was stabilized, and the replica was resynchronized via pg_basebackup. All replicas are now streaming with lag under threshold.',
          contextReferences: ['post_basebackup_replication_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      apiVersion: 'v0.2.1',
      kind: 'RecoveryPlan',
      metadata: {
        planId: `rp-${now.replace(/[-:T]/g, '').slice(0, 14)}-pg-repl-001`,
        agentName: 'postgresql-replication-recovery',
        agentVersion: '1.2.0',
        scenario: 'replication_lag_cascade',
        createdAt: now,
        estimatedDuration: 'PT15M',
        summary:
          'Recover PostgreSQL replication by disconnecting lagging replicas, stabilizing the primary, and re-syncing replicas sequentially.',
        supersedes: null,
      },
      impact: {
        affectedSystems: [
          {
            identifier: 'pg-primary-us-east-1',
            technology: 'postgresql',
            role: 'primary',
            impactType: 'reduced_read_capacity',
          },
          {
            identifier: 'pg-replica-us-east-1b',
            technology: 'postgresql',
            role: 'replica',
            impactType: 'temporary_unavailability',
          },
        ],
        affectedServices: ['user-api', 'reporting-service'],
        estimatedUserImpact:
          'Read queries may experience elevated latency for approximately 10 minutes. No write impact expected.',
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
    // Simulate discovering an invalid replication slot
    this.simulator.transition('recovering');
    const slots = this.simulator.queryReplicationSlots();
    const invalidSlot = slots.find((s) => s.wal_status === 'lost');

    if (invalidSlot) {
      this.simulator.markSlotRecreated();

      const now = new Date().toISOString();
      const revisedSteps: RecoveryStep[] = [
        // New step: drop invalid slot
        {
          stepId: 'step-006a',
          type: 'system_action',
          name: 'Drop invalid replication slot',
          description: `Slot '${invalidSlot.slot_name}' has WAL status 'lost' and must be recreated.`,
          executionContext: 'postgresql_write',
          target: 'pg-primary-us-east-1',
          riskLevel: 'elevated',
          command: {
            type: 'sql',
            subtype: 'function_call',
            statement: `SELECT pg_drop_replication_slot('${invalidSlot.slot_name}');`,
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
              statement: `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${invalidSlot.slot_name}';`,
              expect: { operator: 'eq', value: 0 },
            },
          },
          blastRadius: {
            directComponents: ['pg-primary-us-east-1'],
            indirectComponents: ['pg-replica-us-east-1b'],
            maxImpact: 'replication_slot_removed',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 0, retryable: false },
        },
        // New step: recreate slot
        {
          stepId: 'step-006b',
          type: 'system_action',
          name: 'Recreate replication slot',
          description: `Create a fresh physical replication slot for pg-replica-us-east-1b.`,
          executionContext: 'postgresql_write',
          target: 'pg-primary-us-east-1',
          riskLevel: 'routine',
          command: {
            type: 'sql',
            subtype: 'function_call',
            statement: `SELECT pg_create_physical_replication_slot('${invalidSlot.slot_name}');`,
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Slot exists and is available',
            check: {
              type: 'sql',
              statement: `SELECT count(*) FROM pg_replication_slots WHERE slot_name = '${invalidSlot.slot_name}';`,
              expect: { operator: 'eq', value: 1 },
            },
          },
          blastRadius: {
            directComponents: ['pg-primary-us-east-1'],
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
          apiVersion: 'v0.2.1',
          kind: 'RecoveryPlan',
          metadata: {
            planId: `rp-${now.replace(/[-:T]/g, '').slice(0, 14)}-pg-repl-002`,
            agentName: 'postgresql-replication-recovery',
            agentVersion: '1.2.0',
            scenario: 'replication_lag_cascade',
            createdAt: now,
            estimatedDuration: 'PT18M',
            summary:
              'Revised plan: drop and recreate invalid replication slot before proceeding with replica resync.',
            supersedes: _executionState.completedSteps.length > 0
              ? 'original'
              : null,
          },
          impact: {
            affectedSystems: [
              {
                identifier: 'pg-primary-us-east-1',
                technology: 'postgresql',
                role: 'primary',
                impactType: 'reduced_read_capacity',
              },
              {
                identifier: 'pg-replica-us-east-1b',
                technology: 'postgresql',
                role: 'replica',
                impactType: 'temporary_unavailability',
              },
            ],
            affectedServices: ['user-api', 'reporting-service'],
            estimatedUserImpact:
              'Read queries may experience elevated latency for approximately 12 minutes.',
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
}
