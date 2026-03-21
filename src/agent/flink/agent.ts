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
import { flinkRecoveryManifest } from './manifest.js';
import type { FlinkBackend } from './backend.js';
import { FlinkSimulator } from './simulator.js';

export class FlinkRecoveryAgent implements RecoveryAgent {
  manifest = flinkRecoveryManifest;
  backend: FlinkBackend;

  constructor(backend?: FlinkBackend) {
    this.backend = backend ?? new FlinkSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const jobs = await this.backend.getJobStatus();
    const job = jobs[0];
    const jobId = job?.jobId ?? 'unknown';
    const checkpoints = await this.backend.getCheckpointHistory(jobId);
    const taskManagers = await this.backend.getTaskManagers();
    const backpressure = await this.backend.getBackpressure(jobId);

    const jobFailing = job?.state === 'FAILING' || job?.state === 'FAILED';
    const jobRestarting = job?.state === 'RESTARTING';

    const completedCheckpoints = checkpoints.filter((cp) => cp.status === 'COMPLETED').length;
    const totalCheckpoints = checkpoints.length;
    const checkpointFailureRate = totalCheckpoints > 0 ? 1 - completedCheckpoints / totalCheckpoints : 0;
    const checkpointCritical = checkpointFailureRate > 0.5;
    const checkpointWarning = checkpointFailureRate > 0;

    const highBackpressureCount = backpressure.filter((bp) => bp.backpressureLevel === 'high').length;
    const backpressureCritical = highBackpressureCount > 1;
    const backpressureWarning = highBackpressureCount > 0;

    const lowMemoryThreshold = 100_000_000; // 100MB
    const tmLowMemory = taskManagers.some((tm) => tm.freeMemory < lowMemoryThreshold);

    const status = jobFailing || checkpointCritical
      ? 'unhealthy'
      : jobRestarting || backpressureWarning || checkpointWarning
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'flink_job_status',
        status: signalStatus(jobFailing, jobRestarting),
        detail: `Job '${job?.name ?? 'unknown'}' is in state ${job?.state ?? 'UNKNOWN'} with parallelism ${job?.parallelism ?? 0}/${job?.maxParallelism ?? 0}.`,
        observedAt,
      },
      {
        source: 'flink_checkpoint_status',
        status: signalStatus(checkpointCritical, checkpointWarning),
        detail: `${completedCheckpoints}/${totalCheckpoints} checkpoints completed. Failure rate: ${(checkpointFailureRate * 100).toFixed(0)}%.`,
        observedAt,
      },
      {
        source: 'flink_backpressure',
        status: signalStatus(backpressureCritical, backpressureWarning),
        detail: `${highBackpressureCount} subtask(s) with high backpressure out of ${backpressure.length} total.`,
        observedAt,
      },
      {
        source: 'flink_taskmanager_status',
        status: signalStatus(false, tmLowMemory),
        detail: `${taskManagers.length} TaskManager(s) registered.${tmLowMemory ? ' At least one TaskManager has critically low free memory.' : ' All TaskManagers have adequate memory.'}`,
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'Flink cluster is healthy. Jobs are running, checkpoints are succeeding, and no backpressure detected.',
        recovering: 'Flink cluster is recovering. Job is restarting or partial backpressure/checkpoint warnings remain.',
        unhealthy: 'Flink cluster is unhealthy. Job is failing, checkpoints are cascading failures, or severe backpressure detected.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring Flink job health and checkpoint status.'],
        recovering: ['Continue monitoring until job returns to RUNNING state and checkpoint success rate stabilizes.'],
        unhealthy: ['Run the Flink recovery workflow in dry-run mode to determine the next safe mitigation step.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const jobs = await this.backend.getJobStatus();
    const job = jobs[0];
    const jobId = job?.jobId ?? 'unknown';
    const checkpoints = await this.backend.getCheckpointHistory(jobId);
    const taskManagers = await this.backend.getTaskManagers();
    const backpressure = await this.backend.getBackpressure(jobId);
    const exceptions = await this.backend.getExceptions(jobId);

    const completedCheckpoints = checkpoints.filter((cp) => cp.status === 'COMPLETED').length;
    const failedCheckpoints = checkpoints.filter((cp) => cp.status === 'FAILED').length;
    const totalCheckpoints = checkpoints.length;
    const checkpointFailureRate = totalCheckpoints > 0 ? failedCheckpoints / totalCheckpoints : 0;

    const highBackpressureCount = backpressure.filter((bp) => bp.backpressureLevel === 'high').length;
    const lowMemoryThreshold = 100_000_000;
    const tmLowMemory = taskManagers.filter((tm) => tm.freeMemory < lowMemoryThreshold);

    const scenario = checkpointFailureRate > 0.5
      ? 'checkpoint_failure_cascade'
      : highBackpressureCount > 1
        ? 'backpressure_cascade'
        : tmLowMemory.length > 0
          ? 'task_manager_loss'
          : 'checkpoint_failure_cascade';

    const confidence = checkpointFailureRate > 0.5 && exceptions.length > 0 ? 0.93 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'flink_job_status',
          observation: `Job '${job?.name ?? 'unknown'}' is ${job?.state ?? 'UNKNOWN'} with parallelism ${job?.parallelism ?? 0}/${job?.maxParallelism ?? 0}. Running for ${((job?.duration ?? 0) / 60_000).toFixed(0)} minutes.`,
          severity: job?.state === 'FAILING' || job?.state === 'FAILED' ? 'critical' : 'warning',
          data: { job },
        },
        {
          source: 'flink_checkpoint_status',
          observation: `${completedCheckpoints}/${totalCheckpoints} checkpoints completed, ${failedCheckpoints} failed (${(checkpointFailureRate * 100).toFixed(0)}% failure rate).${failedCheckpoints > 0 ? ` Last failure: ${checkpoints.find((cp) => cp.status === 'FAILED')?.failureReason ?? 'unknown'}.` : ''}`,
          severity: checkpointFailureRate > 0.5 ? 'critical' : checkpointFailureRate > 0 ? 'warning' : 'info',
          data: { checkpoints: checkpoints.map((cp) => ({ id: cp.id, status: cp.status, failureReason: cp.failureReason })) },
        },
        {
          source: 'flink_backpressure',
          observation: `${highBackpressureCount} subtask(s) with high backpressure. Max backpressure ratio: ${Math.max(0, ...backpressure.map((bp) => bp.ratio)).toFixed(2)}.`,
          severity: highBackpressureCount > 1 ? 'critical' : highBackpressureCount > 0 ? 'warning' : 'info',
          data: { backpressure },
        },
        {
          source: 'flink_taskmanager_status',
          observation: `${taskManagers.length} TaskManager(s). ${tmLowMemory.length > 0 ? `${tmLowMemory.length} with critically low memory (< 100MB free).` : 'All have adequate memory.'}`,
          severity: tmLowMemory.length > 0 ? 'warning' : 'info',
          data: { taskManagers: taskManagers.map((tm) => ({ id: tm.id, freeSlots: tm.freeSlots, totalSlots: tm.totalSlots, freeMemory: tm.freeMemory })) },
        },
        {
          source: 'flink_exceptions',
          observation: exceptions.length > 0
            ? `${exceptions.length} recent exception(s). Latest: ${exceptions[0]?.exception} in ${exceptions[0]?.taskName}.`
            : 'No recent exceptions.',
          severity: exceptions.length > 0 ? 'warning' : 'info',
          data: { exceptions },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const instance = String(context.trigger.payload.instance || 'flink-cluster');

    const steps: RecoveryStep[] = [
      // Step 1: Capture job and checkpoint state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture Flink job and checkpoint state',
        executionContext: 'flink_read',
        target: instance,
        command: {
          type: 'structured_command',
          operation: 'job_status',
          parameters: { includeCheckpoints: true, includeTaskManagers: true },
        },
        outputCapture: {
          name: 'current_flink_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Flink checkpoint failure recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Flink checkpoint failure recovery initiated on ${instance}`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_flink_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Adjust checkpoint configuration (reduce interval, increase timeout)
      {
        stepId: 'step-003',
        type: 'system_action',
        name: 'Adjust checkpoint configuration',
        description: 'Increase checkpoint timeout and interval to reduce checkpoint pressure during recovery.',
        executionContext: 'flink_admin',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['stream.checkpoint.configure'],
        command: {
          type: 'structured_command',
          operation: 'checkpoint_configure',
          parameters: { checkpointInterval: 120_000, checkpointTimeout: 300_000 },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Checkpoint configuration accepted',
          check: {
            type: 'structured_command',
            statement: 'checkpoint_success_rate',
            expect: { operator: 'gte', value: 0 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Revert checkpoint interval and timeout to previous values.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'checkpoint_interval_increased',
          cascadeRisk: 'none',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 4: Trigger savepoint before restart
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Trigger savepoint for state preservation',
        description: 'Create a savepoint to preserve job state before restarting from a clean slate.',
        executionContext: 'flink_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['stream.savepoint.trigger'],
        command: {
          type: 'structured_command',
          operation: 'savepoint_trigger',
          parameters: { jobId: 'job-abc123', targetDirectory: '/savepoints' },
        },
        statePreservation: {
          before: [
            {
              name: 'job_state_before_savepoint',
              captureType: 'command_output',
              statement: 'GET /jobs/job-abc123',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'savepoint_result',
              captureType: 'command_output',
              statement: 'GET /jobs/job-abc123/savepoints',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Job has transitioned to recovering state',
          check: {
            type: 'structured_command',
            statement: 'job_state',
            expect: { operator: 'neq', value: 'FAILING' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Savepoint is non-destructive. No rollback required — job can be restarted from any previous savepoint.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['downstream-consumers'],
          maxImpact: 'brief_processing_pause',
          cascadeRisk: 'low',
        },
        stateTransition: 'recovering',
        timeout: 'PT2M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Restart job from savepoint
      {
        stepId: 'step-005',
        type: 'system_action',
        name: 'Restart job from savepoint',
        description: 'Cancel the failing job and restart from the latest savepoint with clean state.',
        executionContext: 'flink_admin',
        target: instance,
        riskLevel: 'elevated',
        requiredCapabilities: ['stream.job.restart'],
        command: {
          type: 'structured_command',
          operation: 'job_restart',
          parameters: { jobId: 'job-abc123', fromSavepoint: '/savepoints/sp-001', allowNonRestoredState: false },
        },
        statePreservation: {
          before: [
            {
              name: 'job_state_before_restart',
              captureType: 'command_output',
              statement: 'GET /jobs/job-abc123',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'job_state_after_restart',
              captureType: 'command_output',
              statement: 'GET /jobs/job-abc123',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Job is running successfully',
          check: {
            type: 'structured_command',
            statement: 'job_state',
            expect: { operator: 'eq', value: 'RUNNING' },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Restart the job from a previous savepoint if the current restart fails.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: ['downstream-consumers', 'upstream-producers'],
          maxImpact: 'stream_processing_interrupted',
          cascadeRisk: 'medium',
        },
        stateTransition: 'recovered',
        timeout: 'PT3M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 6: Reconfigure checkpoints for normal operation
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Restore checkpoint configuration',
        description: 'Set checkpoint interval and timeout back to normal production values after successful restart.',
        executionContext: 'flink_admin',
        target: instance,
        riskLevel: 'routine',
        requiredCapabilities: ['stream.checkpoint.configure'],
        command: {
          type: 'structured_command',
          operation: 'checkpoint_configure',
          parameters: { checkpointInterval: 60_000, checkpointTimeout: 120_000 },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Checkpoint configuration accepted and first checkpoint succeeds',
          check: {
            type: 'structured_command',
            statement: 'checkpoint_success_rate',
            expect: { operator: 'gt', value: 0.5 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Revert to relaxed checkpoint configuration if failures resume.',
        },
        blastRadius: {
          directComponents: [instance],
          indirectComponents: [],
          maxImpact: 'checkpoint_interval_changed',
          cascadeRisk: 'none',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 7: Replanning checkpoint — verify recovery
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Verify job health and checkpoint success',
        description: 'Check if the job is running stably and checkpoints are completing before declaring success.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_job_state',
            captureType: 'command_output',
            statement: 'GET /jobs',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'post_recovery_checkpoints',
            captureType: 'command_output',
            statement: 'GET /jobs/job-abc123/checkpoints',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 8: Recovery summary notification
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'data_engineering_lead', urgency: 'medium' },
        ],
        message: {
          summary: `Flink checkpoint failure recovery completed on ${instance}`,
          detail: 'Job restarted from savepoint, checkpoints reconfigured and succeeding. Monitor job health and consumer lag.',
          contextReferences: ['post_recovery_job_state', 'post_recovery_checkpoints'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'flink-chk',
        agentName: 'flink-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'checkpoint_failure_cascade',
        estimatedDuration: 'PT8M',
        summary: `Recover Flink from checkpoint failure cascade on ${instance}: trigger savepoint, restart job, reconfigure checkpoints.`,
        supersedes: null,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: instance,
            technology: 'flink',
            role: 'jobmanager',
            impactType: 'stream_processing_interrupted',
          },
        ],
        affectedServices: ['stream-processing-pipeline'],
        estimatedUserImpact: 'Brief interruption in stream processing during job restart. State preserved via savepoint.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Job can be restarted from any previous savepoint. Checkpoint configuration changes are independently reversible.',
      },
    };
  }

  replan = defaultReplan;
}
