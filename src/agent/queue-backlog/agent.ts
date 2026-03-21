// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { queueBacklogManifest } from './manifest.js';
import type { QueueBackend } from './backend.js';
import { QueueSimulator } from './simulator.js';

export class QueueBacklogAgent implements RecoveryAgent {
  manifest = queueBacklogManifest;
  backend: QueueBackend;

  constructor(backend?: QueueBackend) {
    this.backend = backend ?? new QueueSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const queues = await this.backend.getQueueStats();
    const workers = await this.backend.getWorkerStatus();
    const dlq = await this.backend.getDeadLetterStats();
    const rates = await this.backend.getProcessingRate();

    const totalDepth = queues.reduce((sum, q) => sum + q.depth, 0);
    const stuckWorkers = workers.filter((w) => w.status === 'stuck' || w.status === 'dead').length;
    const activeWorkers = workers.filter((w) => w.status === 'active').length;

    const backlogCritical = rates.backlogGrowthRate > 100;
    const backlogWarning = rates.backlogGrowthRate > 0;
    const workerCritical = stuckWorkers > workers.length / 2;
    const workerWarning = stuckWorkers > 0;
    const dlqCritical = dlq.depth > 1000;
    const dlqWarning = dlq.depth > 100;
    const rateCritical = rates.processingRate < rates.incomingRate * 0.25;
    const rateWarning = rates.processingRate < rates.incomingRate;

    const status = backlogCritical || workerCritical || dlqCritical || rateCritical
      ? 'unhealthy'
      : backlogWarning || workerWarning || dlqWarning || rateWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'queue_depth_metrics',
        status: signalStatus(backlogCritical, backlogWarning),
        detail: `Total queue depth: ${totalDepth.toLocaleString()}. Backlog growth rate: ${rates.backlogGrowthRate} msg/s.`,
        observedAt,
      },
      {
        source: 'worker_heartbeat',
        status: signalStatus(workerCritical, workerWarning),
        detail: `${activeWorkers} active worker(s), ${stuckWorkers} stuck/dead worker(s) out of ${workers.length} total.`,
        observedAt,
      },
      {
        source: 'dlq_metrics',
        status: signalStatus(dlqCritical, dlqWarning),
        detail: `Dead letter queue depth: ${dlq.depth.toLocaleString()}. Oldest message age: ${dlq.oldestAge}s.`,
        observedAt,
      },
      {
        source: 'processing_rate',
        status: signalStatus(rateCritical, rateWarning),
        detail: `Incoming: ${rates.incomingRate} msg/s. Processing: ${rates.processingRate} msg/s. Estimated clear time: ${rates.estimatedClearTime === Infinity ? 'never' : `${rates.estimatedClearTime}s`}.`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'Queue health is healthy. Backlog depths, worker status, and processing rates are all within normal thresholds.',
        recovering: 'Queue health is recovering. Backlog is draining but at least one indicator is still above the healthy target.',
        unhealthy: 'Queue health is unhealthy. Backlog is growing, workers are stuck, or processing rate has collapsed.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring queue depths and worker health.'],
        recovering: ['Continue monitoring until backlog clears and all workers return to healthy state.'],
        unhealthy: ['Run the queue backlog recovery workflow in dry-run mode to determine the next safe mitigation step.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const queues = await this.backend.getQueueStats();
    const workers = await this.backend.getWorkerStatus();
    const dlq = await this.backend.getDeadLetterStats();
    const rates = await this.backend.getProcessingRate();

    const totalDepth = queues.reduce((sum, q) => sum + q.depth, 0);
    const stuckWorkers = workers.filter((w) => w.status === 'stuck' || w.status === 'dead').length;

    const scenario = stuckWorkers > workers.length / 2
      ? 'stuck_workers'
      : dlq.depth > 1000
        ? 'dead_letter_flood'
        : rates.backlogGrowthRate > 100
          ? 'backlog_overflow'
          : 'processing_rate_collapse';

    const confidence = stuckWorkers > 0 && rates.backlogGrowthRate > 0 ? 0.93 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'queue_depth_metrics',
          observation: `Total backlog: ${totalDepth.toLocaleString()} messages across ${queues.length} queue(s). Worst queue: ${queues.sort((a, b) => b.depth - a.depth)[0]?.name} (${queues.sort((a, b) => b.depth - a.depth)[0]?.depth.toLocaleString()} messages).`,
          severity: totalDepth > 100_000 ? 'critical' : totalDepth > 10_000 ? 'warning' : 'info',
          data: { totalDepth, queues },
        },
        {
          source: 'worker_heartbeat',
          observation: `${stuckWorkers} of ${workers.length} worker(s) are stuck or dead. ${workers.filter((w) => w.status === 'active').length} active.`,
          severity: stuckWorkers > workers.length / 2 ? 'critical' : stuckWorkers > 0 ? 'warning' : 'info',
          data: { workers, stuckWorkers },
        },
        {
          source: 'dlq_metrics',
          observation: `Dead letter queue: ${dlq.depth.toLocaleString()} messages. Oldest: ${dlq.oldestAge}s. Recent errors: ${dlq.recentErrors.length > 0 ? dlq.recentErrors[0] : 'none'}.`,
          severity: dlq.depth > 1000 ? 'critical' : dlq.depth > 100 ? 'warning' : 'info',
          data: { dlq },
        },
        {
          source: 'processing_rate',
          observation: `Incoming: ${rates.incomingRate} msg/s, Processing: ${rates.processingRate} msg/s. Backlog growing at ${rates.backlogGrowthRate} msg/s.`,
          severity: rates.backlogGrowthRate > 100 ? 'critical' : rates.backlogGrowthRate > 0 ? 'warning' : 'info',
          data: { rates },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const instance = String(context.trigger.payload.instance || 'queue-cluster');

    const steps: RecoveryStep[] = [
      // Step 1: Read all queue stats, worker health, DLQ depth
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture queue stats, worker health, and DLQ depth',
        executionContext: 'queue_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'queue_stats',
          parameters: { sections: ['queues', 'workers', 'dlq', 'rates'] },
        },
        outputCapture: {
          name: 'current_queue_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Alert about backlog building
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of queue backlog building',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Queue backlog recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_queue_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Capture current queue depths and worker states
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture queue depths and worker states before mutations.',
        stateCaptures: [
          {
            name: 'queue_depths_snapshot',
            captureType: 'command_output',
            statement: 'GET queue_depths',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'worker_states_snapshot',
            captureType: 'command_output',
            statement: 'GET worker_states',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Pause incoming queue to stop backlog growth (elevated)
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Pause incoming queue intake',
        description: 'Temporarily pause message intake on all queues to stop backlog growth while workers recover.',
        executionContext: 'queue_write',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['queue.pause'],
        command: {
          type: 'structured_command',
          operation: 'pause_intake',
          parameters: { scope: 'all_queues' },
        },
        preConditions: [
          {
            description: 'Queue service is responding',
            check: {
              type: 'structured_command',
              statement: 'queue_service_health',
              expect: { operator: 'eq', value: 'ok' },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'queue_intake_state_before',
              captureType: 'command_output',
              statement: 'GET queue_intake_status',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'queue_intake_state_after',
              captureType: 'command_output',
              statement: 'GET queue_intake_status',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Backlog growth rate has stopped',
          check: {
            type: 'structured_command',
            statement: 'backlog_growth_rate',
            expect: { operator: 'lte', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Resume queue intake to restore message flow.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['upstream-producers'],
          maxImpact: 'message_intake_paused',
          cascadeRisk: 'medium',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 5: Restart stuck workers (routine)
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Restart stuck workers',
        description: 'Restart workers in stuck or dead state to restore processing capacity.',
        executionContext: 'queue_write',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['queue.workers.restart'],
        command: {
          type: 'structured_command',
          operation: 'restart_workers',
          parameters: { filter: 'stuck_or_dead' },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'No stuck or dead workers remain',
          check: {
            type: 'structured_command',
            statement: 'stuck_worker_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Workers will be restarted again if they remain stuck.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'workers_restarted',
          cascadeRisk: 'low',
        },
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Verify workers processing and backlog draining
      {
        stepId: 'step-006',
        type: 'diagnosis_action',
        name: 'Verify workers processing and backlog draining',
        executionContext: 'queue_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'queue_stats',
          parameters: { sections: ['queues', 'workers', 'rates'] },
        },
        outputCapture: {
          name: 'post_recovery_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 7: Conditional — if backlog draining, resume; else scale workers
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Decide: resume intake or scale workers',
        condition: {
          description: 'Backlog is draining (growth rate is negative)',
          check: {
            type: 'structured_command',
            statement: 'backlog_growth_rate',
            expect: { operator: 'lt', value: 0 },
          },
        },
        thenStep: {
          stepId: 'step-007a',
          type: 'system_action',
          name: 'Resume queue intake',
          description: 'Backlog is draining — resume normal message intake.',
          executionContext: 'queue_write',
          target: instance,
          riskLevel: 'routine',
          requiredCapabilities: ['queue.pause'],
          command: {
            type: 'structured_command',
            operation: 'resume_intake',
            parameters: { scope: 'all_queues' },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Queue intake is active',
            check: {
              type: 'structured_command',
              statement: 'queue_service_health',
              expect: { operator: 'eq', value: 'ok' },
            },
          },
          rollback: {
            type: 'automatic',
            description: 'Pause intake again if backlog resumes growing.',
          },
          blastRadius: {
            directComponents: [instance],
            indirectComponents: [],
            maxImpact: 'intake_resumed',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
        elseStep: {
          stepId: 'step-007b',
          type: 'system_action',
          name: 'Scale up workers',
          description: 'Backlog still growing — scale worker count to increase processing throughput.',
          executionContext: 'queue_write',
          target: instance,
          riskLevel: 'routine',
          requiredCapabilities: ['queue.workers.scale'],
          command: {
            type: 'structured_command',
            operation: 'scale_workers',
            parameters: { count: 10, strategy: 'add' },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Worker count increased',
            check: {
              type: 'structured_command',
              statement: 'stuck_worker_count',
              expect: { operator: 'eq', value: 0 },
            },
          },
          rollback: {
            type: 'manual',
            description: 'Scale workers back down once backlog is cleared.',
          },
          blastRadius: {
            directComponents: [instance],
            indirectComponents: ['compute-resources'],
            maxImpact: 'worker_count_increased',
            cascadeRisk: 'low',
          },
          timeout: 'PT2M',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
      },
      // Step 8: Recovery summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary with queue depths',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'medium' },
        ],
        message: {
          summary: `Queue backlog recovery completed on ${instance}`,
          detail: `Stuck workers restarted, backlog draining in progress. Messages preserved — no data loss. Monitor queue depths and processing rates.`,
          contextReferences: ['post_recovery_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'queue-blg',
        agentName: 'queue-backlog-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'backlog_overflow',
        estimatedDuration: 'PT10M',
        summary: `Recover queue system from backlog on ${instance}: pause intake, restart stuck workers, drain backlog, resume flow.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'message-queue',
            role: 'primary',
            impactType: 'temporary_intake_pause',
          },
        ],
        affectedServices: ['message-processing'],
        estimatedUserImpact: 'Temporary pause in new message intake. Existing messages continue processing. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Each step is independently reversible. Queue intake can be resumed immediately. Worker restarts are idempotent.',
      },
    };
  }

  replan = defaultReplan;
}
