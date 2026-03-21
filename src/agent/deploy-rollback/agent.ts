// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { deployRollbackManifest } from './manifest.js';
import type { DeployBackend } from './backend.js';
import { DeploySimulator } from './simulator.js';

export class DeployRollbackAgent implements RecoveryAgent {
  manifest = deployRollbackManifest;
  backend: DeployBackend;

  constructor(backend?: DeployBackend) {
    this.backend = backend ?? new DeploySimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const currentDeploy = await this.backend.getCurrentDeployment();
    const endpoints = await this.backend.getHealthEndpoints();
    const traffic = await this.backend.getTrafficDistribution();

    const maxErrorRate = Math.max(0, ...endpoints.map((e) => e.errorRate));
    const avgErrorRate =
      endpoints.reduce((sum, e) => sum + e.errorRate, 0) / endpoints.length;
    const downEndpoints = endpoints.filter((e) => e.status === 'down').length;
    const degradedEndpoints = endpoints.filter((e) => e.status === 'degraded').length;

    const errorCritical = maxErrorRate > 5;
    const errorWarning = maxErrorRate > 1;
    const endpointCritical = downEndpoints > 0;
    const endpointWarning = degradedEndpoints > 0;
    const deployCritical = currentDeploy.status === 'failed' || currentDeploy.status === 'rolling_back';

    const status =
      errorCritical || endpointCritical || deployCritical
        ? 'unhealthy'
        : errorWarning || endpointWarning
          ? 'recovering'
          : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'deploy_status',
        status: signalStatus(deployCritical),
        detail: `Current deploy ${currentDeploy.sha.slice(0, 8)} is ${currentDeploy.status}. Deployed at ${currentDeploy.timestamp}.`,
        observedAt,
      },
      {
        source: 'endpoint_health',
        status: signalStatus(endpointCritical, endpointWarning),
        detail: `${endpoints.length} endpoint(s) monitored: ${downEndpoints} down, ${degradedEndpoints} degraded. Max error rate: ${maxErrorRate.toFixed(1)}%.`,
        observedAt,
      },
      {
        source: 'error_rate',
        status: signalStatus(errorCritical, errorWarning),
        detail: `Average error rate across endpoints: ${avgErrorRate.toFixed(1)}%. Max: ${maxErrorRate.toFixed(1)}%.`,
        observedAt,
      },
      {
        source: 'traffic_distribution',
        status: signalStatus(false, traffic.entries.length > 1),
        detail: traffic.entries
          .map((e) => `${e.target}: ${e.percentage}%`)
          .join(', '),
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.94,
      summary: {
        healthy: 'Deploy health is healthy. All endpoints are responsive with error rates within normal thresholds.',
        recovering: 'Deploy health is recovering. Some endpoints show elevated error rates or degradation after traffic shift.',
        unhealthy: 'Deploy health is unhealthy. Endpoint failures and high error rates indicate a bad deployment requiring rollback.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring deploy health and error rates.'],
        recovering: ['Continue monitoring. Traffic has been shifted but error rates have not fully stabilized.'],
        unhealthy: ['Run the deploy rollback recovery workflow to shift traffic away from the bad deployment.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const currentDeploy = await this.backend.getCurrentDeployment();
    const endpoints = await this.backend.getHealthEndpoints();
    const rollbackTarget = await this.backend.getRollbackTarget();
    const recentDeploys = await this.backend.listRecentDeploys(5);

    const maxErrorRate = Math.max(0, ...endpoints.map((e) => e.errorRate));
    const downEndpoints = endpoints.filter((e) => e.status === 'down');
    const maxLatency = Math.max(0, ...endpoints.map((e) => e.latencyMs));

    const scenario =
      maxErrorRate > 10
        ? 'bad_deploy_high_error_rate'
        : maxLatency > 3_000
          ? 'deploy_timeout_cascade'
          : downEndpoints.length > 0
            ? 'canary_failure'
            : 'rollback_needed';

    const confidence = maxErrorRate > 10 && rollbackTarget !== null ? 0.95 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'deploy_status',
          observation: `Current deploy ${currentDeploy.sha.slice(0, 8)} (${currentDeploy.status}) deployed at ${currentDeploy.timestamp} by ${currentDeploy.author}. Message: "${currentDeploy.message}".`,
          severity: currentDeploy.status === 'failed' ? 'critical' : 'warning',
          data: { currentDeploy },
        },
        {
          source: 'endpoint_health',
          observation: `${downEndpoints.length} endpoint(s) down, max error rate ${maxErrorRate.toFixed(1)}%, max latency ${maxLatency}ms. Failing endpoints: ${downEndpoints.map((e) => e.url).join(', ') || 'none'}.`,
          severity: maxErrorRate > 10 ? 'critical' : maxErrorRate > 5 ? 'warning' : 'info',
          data: { endpoints },
        },
        {
          source: 'deploy_history',
          observation: rollbackTarget
            ? `Rollback target available: ${rollbackTarget.sha.slice(0, 8)} (${rollbackTarget.status}) deployed at ${rollbackTarget.timestamp}.`
            : 'No suitable rollback target found in recent deploy history.',
          severity: rollbackTarget ? 'info' : 'critical',
          data: { rollbackTarget, recentDeploys },
        },
        {
          source: 'error_rate_timeline',
          observation: `Error rate spike detected after deploy ${currentDeploy.sha.slice(0, 8)}. Previous deploy ${rollbackTarget?.sha.slice(0, 8) ?? 'unknown'} was healthy.`,
          severity: 'warning',
          data: { currentSha: currentDeploy.sha, previousSha: rollbackTarget?.sha },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'app-deployment');

    const steps: RecoveryStep[] = [
      // Step 1: Read current deploy status and error rates
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Read current deploy status and error rates',
        executionContext: 'deploy_read',
        target,
        command: {
          type: 'api_call',
          operation: 'deploy_status',
          parameters: { includeEndpoints: true, includeTraffic: true },
        },
        outputCapture: {
          name: 'current_deploy_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Alert on-call about bad deploy detected
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Alert on-call about bad deploy detected',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Bad deploy detected on ${target} — initiating rollback`,
          detail: `Scenario: ${diagnosis.scenario}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_deploy_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Capture current traffic distribution and deploy state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Capture pre-rollback state',
        description: 'Capture current traffic distribution and deploy state before mutations.',
        stateCaptures: [
          {
            name: 'traffic_snapshot',
            captureType: 'command_output',
            statement: 'GET /api/internal/traffic-distribution',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'deploy_state_snapshot',
            captureType: 'command_output',
            statement: 'GET /api/internal/deploy-status',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Shift traffic away from bad deploy
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Shift traffic away from bad deploy',
        description: 'Route 90% of traffic to the previous known-good deployment version, leaving 10% on the current version for monitoring.',
        executionContext: 'deploy_write',
        target,
        riskLevel: 'elevated',
        requiredCapabilities: ['traffic.shift'],
        command: {
          type: 'api_call',
          operation: 'traffic_shift',
          parameters: { previousVersionWeight: 90, currentVersionWeight: 10 },
        },
        preConditions: [
          {
            description: 'Deploy system is reachable',
            check: {
              type: 'api_call',
              statement: 'deploy_health',
              expect: { operator: 'lte', value: 100 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'traffic_before_shift',
              captureType: 'command_output',
              statement: 'GET /api/internal/traffic-distribution',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'traffic_after_shift',
              captureType: 'command_output',
              statement: 'GET /api/internal/traffic-distribution',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Traffic distribution updated with majority routed to previous version',
          check: {
            type: 'api_call',
            statement: 'traffic_distribution',
            expect: { operator: 'lte', value: 10 },
          },
        },
        rollback: {
          type: 'automatic',
          description: 'Revert traffic weights to pre-shift distribution using captured snapshot.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['load-balancer', 'traffic-router'],
          maxImpact: 'traffic_routing_changed',
          cascadeRisk: 'medium',
        },
        timeout: 'PT1M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Verify error rates dropping after traffic shift
      {
        stepId: 'step-005',
        type: 'diagnosis_action',
        name: 'Verify error rates dropping after traffic shift',
        executionContext: 'deploy_read',
        target,
        command: {
          type: 'api_call',
          operation: 'health_check',
          parameters: { waitForStabilization: true },
        },
        outputCapture: {
          name: 'post_shift_health',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT2M',
      },
      // Step 6: Evaluate if full rollback needed
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Evaluate if full rollback is needed',
        description: 'Check if the traffic shift resolved errors or if a complete rollback to the previous version is required.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_shift_error_rates',
            captureType: 'command_output',
            statement: 'GET /api/internal/endpoint-health',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Conditional — full rollback or escalate
      {
        stepId: 'step-007',
        type: 'conditional',
        name: 'Decide: restore full traffic to previous version or escalate',
        condition: {
          description: 'Error rates have dropped below 5% after traffic shift',
          check: {
            type: 'api_call',
            statement: 'error_rate',
            expect: { operator: 'lt', value: 5 },
          },
        },
        thenStep: {
          stepId: 'step-007a',
          type: 'system_action',
          name: 'Complete rollback — route 100% traffic to previous version',
          description: 'Error rates resolved after traffic shift. Complete the rollback by routing all traffic to the known-good version.',
          executionContext: 'deploy_write',
          target,
          riskLevel: 'routine',
          requiredCapabilities: ['deploy.rollback'],
          command: {
            type: 'api_call',
            operation: 'full_rollback',
            parameters: { confirmFullRollback: true },
          },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'All traffic routed to previous version',
            check: {
              type: 'api_call',
              statement: 'error_rate',
              expect: { operator: 'lt', value: 1 },
            },
          },
          rollback: {
            type: 'manual',
            description: 'Re-deploy the original version if the rollback target is also unhealthy.',
          },
          blastRadius: {
            directComponents: [target],
            indirectComponents: ['traffic-router'],
            maxImpact: 'full_traffic_reroute',
            cascadeRisk: 'low',
          },
          timeout: 'PT1M',
          retryPolicy: { maxRetries: 1, retryable: true },
        },
        elseStep: {
          stepId: 'step-007b',
          type: 'human_notification',
          name: 'Escalate — errors persist after traffic shift',
          recipients: [
            { role: 'deploy_owner', urgency: 'critical' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `Deploy rollback on ${target} requires manual intervention`,
            detail: 'Error rates remain elevated after traffic shift to previous version. The issue may not be isolated to the current deployment. Manual investigation required.',
            contextReferences: ['post_shift_health', 'post_shift_error_rates'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 8: Recovery summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'deploy_owner', urgency: 'medium' },
        ],
        message: {
          summary: `Deploy rollback recovery completed on ${target}`,
          detail: 'Traffic shifted away from bad deploy, error rates verified, rollback decision executed. Monitor endpoint health and error rates.',
          contextReferences: ['post_shift_health'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'deploy-rb',
        agentName: 'deploy-rollback-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'bad_deploy_high_error_rate',
        estimatedDuration: 'PT8M',
        summary: `Recover from bad deploy on ${target}: shift traffic to known-good version, verify error rates, complete rollback.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'application',
            role: 'deployment',
            impactType: 'traffic_rerouting',
          },
        ],
        affectedServices: ['application-layer', 'traffic-router'],
        estimatedUserImpact: 'Brief increase in latency during traffic shift. Requests to the bad deploy version will be drained.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Traffic shift is reversible by restoring the original distribution. Full rollback can be undone by re-deploying the original version.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    const endpoints = await this.backend.getHealthEndpoints();
    const maxErrorRate = Math.max(0, ...endpoints.map((e) => e.errorRate));

    if (maxErrorRate < 5) {
      return { action: 'continue' };
    }

    return {
      action: 'abort',
      reason: `Error rate still elevated at ${maxErrorRate.toFixed(1)}% after traffic shift. Full rollback and manual intervention recommended.`,
    };
  }
}
