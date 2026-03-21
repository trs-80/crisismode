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
import { k8sRecoveryManifest } from './manifest.js';
import type { K8sBackend } from './backend.js';
import { K8sSimulator } from './simulator.js';

export class K8sRecoveryAgent implements RecoveryAgent {
  manifest = k8sRecoveryManifest;
  backend: K8sBackend;

  constructor(backend?: K8sBackend) {
    this.backend = backend ?? new K8sSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const nodes = await this.backend.getNodeStatus();
    const pods = await this.backend.getPodsByNamespace('production');
    const deployments = await this.backend.getDeploymentStatus('production');

    const notReadyNodes = nodes.filter((n) => n.status === 'NotReady');
    const crashloopPods = pods.filter((p) => p.status === 'CrashLoopBackOff');
    const unhealthyDeployments = deployments.filter((d) => d.readyReplicas < d.replicas);

    const nodesCritical = notReadyNodes.length > 0;
    const podsCritical = crashloopPods.length > 2;
    const podsWarning = crashloopPods.length > 0;
    const deploymentsCritical = unhealthyDeployments.length > 0;

    const status = nodesCritical || podsCritical
      ? 'unhealthy'
      : podsWarning || deploymentsCritical
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'k8s_node_status',
        status: signalStatus(nodesCritical),
        detail: nodesCritical
          ? `${notReadyNodes.length} node(s) NotReady: ${notReadyNodes.map((n) => n.name).join(', ')}.`
          : `All ${nodes.length} node(s) are Ready.`,
        observedAt,
      },
      {
        source: 'k8s_pod_health',
        status: signalStatus(podsCritical, podsWarning),
        detail: crashloopPods.length > 0
          ? `${crashloopPods.length} pod(s) in CrashLoopBackOff: ${crashloopPods.map((p) => p.name).join(', ')}.`
          : 'No pods in CrashLoopBackOff.',
        observedAt,
      },
      {
        source: 'k8s_deployment_status',
        status: signalStatus(false, deploymentsCritical),
        detail: unhealthyDeployments.length > 0
          ? `${unhealthyDeployments.length} deployment(s) not at full replicas: ${unhealthyDeployments.map((d) => `${d.name} (${d.readyReplicas}/${d.replicas})`).join(', ')}.`
          : 'All deployments at full replicas.',
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: 'Kubernetes cluster is healthy. All nodes ready, no crashlooping pods, all deployments at full replicas.',
        recovering: 'Kubernetes cluster is recovering. Some pods or deployments are not yet at desired state.',
        unhealthy: 'Kubernetes cluster is unhealthy. Node failures or widespread pod crash loops require immediate action.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring cluster health.'],
        recovering: ['Continue monitoring until all deployments reach full replica count and no pods are in error states.'],
        unhealthy: ['Run the Kubernetes recovery workflow in dry-run mode to cordon failing nodes and reschedule workloads.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const nodes = await this.backend.getNodeStatus();
    const pods = await this.backend.getPodsByNamespace('production');
    const deployments = await this.backend.getDeploymentStatus('production');
    const events = await this.backend.getEvents();
    const pvcs = await this.backend.getPVCStatus('production');

    const notReadyNodes = nodes.filter((n) => n.status === 'NotReady');
    const crashloopPods = pods.filter((p) => p.status === 'CrashLoopBackOff');
    const stuckPVCs = pvcs.filter((p) => p.status === 'Terminating');
    const unhealthyDeployments = deployments.filter((d) => d.readyReplicas < d.replicas);
    const warningEvents = events.filter((e) => e.type === 'Warning');

    const scenario = notReadyNodes.length > 0
      ? 'node_not_ready_cascade'
      : crashloopPods.length > 0
        ? 'pod_crashloop_cascade'
        : stuckPVCs.length > 0
          ? 'pvc_stuck_terminating'
          : 'reconciliation_loop_stuck';

    const confidence = notReadyNodes.length > 0 && crashloopPods.length > 0 ? 0.94 : 0.80;

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'k8s_node_status',
          observation: notReadyNodes.length > 0
            ? `${notReadyNodes.length} node(s) NotReady: ${notReadyNodes.map((n) => n.name).join(', ')}. Conditions: ${notReadyNodes.flatMap((n) => n.conditions.map((c) => c.message)).join('; ')}.`
            : `All ${nodes.length} node(s) are Ready.`,
          severity: notReadyNodes.length > 0 ? 'critical' : 'info',
          data: { nodes: nodes.map((n) => ({ name: n.name, status: n.status, podCount: n.podCount })) },
        },
        {
          source: 'k8s_pod_health',
          observation: crashloopPods.length > 0
            ? `${crashloopPods.length} pod(s) in CrashLoopBackOff with total ${crashloopPods.reduce((sum, p) => sum + p.restarts, 0)} restarts.`
            : 'No pods in CrashLoopBackOff.',
          severity: crashloopPods.length > 2 ? 'critical' : crashloopPods.length > 0 ? 'warning' : 'info',
          data: { crashloopPods: crashloopPods.map((p) => ({ name: p.name, nodeName: p.nodeName, restarts: p.restarts })) },
        },
        {
          source: 'k8s_deployment_status',
          observation: unhealthyDeployments.length > 0
            ? `${unhealthyDeployments.length} deployment(s) not at full replicas: ${unhealthyDeployments.map((d) => `${d.name} (${d.readyReplicas}/${d.replicas})`).join(', ')}.`
            : 'All deployments at full replicas.',
          severity: unhealthyDeployments.length > 0 ? 'warning' : 'info',
          data: { deployments: deployments.map((d) => ({ name: d.name, replicas: d.replicas, readyReplicas: d.readyReplicas })) },
        },
        {
          source: 'k8s_events',
          observation: warningEvents.length > 0
            ? `${warningEvents.length} warning event(s). Most frequent: ${warningEvents[0]?.reason} (${warningEvents[0]?.count}x): ${warningEvents[0]?.message}.`
            : 'No warning events detected.',
          severity: warningEvents.length > 3 ? 'warning' : 'info',
          data: { events: warningEvents },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const cluster = String(context.trigger.payload.instance || 'k8s-cluster');

    // Determine target node from diagnosis findings
    const nodeFinding = diagnosis.findings.find((f) => f.source === 'k8s_node_status');
    const nodeData = nodeFinding?.data as { nodes?: Array<{ name: string; status: string }> } | undefined;
    const targetNode = nodeData?.nodes?.find((n) => n.status === 'NotReady')?.name ?? 'worker-2';

    // Determine affected deployments
    const deploymentFinding = diagnosis.findings.find((f) => f.source === 'k8s_deployment_status');
    const deploymentData = deploymentFinding?.data as { deployments?: Array<{ name: string }> } | undefined;
    const affectedDeployments = deploymentData?.deployments?.map((d) => d.name) ?? ['payment-service', 'order-service'];

    const steps: RecoveryStep[] = [
      // Step 1: Capture cluster state
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture cluster state',
        executionContext: 'k8s_read',
        target: cluster,
        command: {
          type: 'structured_command',
          operation: 'node_status',
          parameters: { includeConditions: true },
        },
        outputCapture: {
          name: 'current_cluster_state',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of Kubernetes node failure recovery',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `Kubernetes node failure recovery initiated on ${cluster}`,
          detail: `Scenario: ${diagnosis.scenario}. Target node: ${targetNode}. ${diagnosis.findings[0]?.observation}`,
          contextReferences: ['current_cluster_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-recovery checkpoint',
        description: 'Capture node and pod state before mutations.',
        stateCaptures: [
          {
            name: 'node_state_snapshot',
            captureType: 'command_output',
            statement: 'kubectl get nodes -o json',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
          {
            name: 'pod_state_snapshot',
            captureType: 'command_output',
            statement: 'kubectl get pods -A -o json',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Cordon node
      {
        stepId: 'step-004',
        type: 'system_action',
        name: `Cordon node ${targetNode}`,
        description: `Mark ${targetNode} as unschedulable to prevent new pods from being placed on it.`,
        executionContext: 'k8s_admin',
        target: cluster,
        riskLevel: 'elevated',
        requiredCapabilities: ['k8s.node.cordon'],
        command: {
          type: 'structured_command',
          operation: 'node_cordon',
          parameters: { node: targetNode },
        },
        preConditions: [
          {
            description: 'Cluster API server is reachable',
            check: {
              type: 'structured_command',
              statement: 'node_ready_count',
              expect: { operator: 'gte', value: 1 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'node_state_before_cordon',
              captureType: 'command_output',
              statement: `kubectl get node ${targetNode} -o json`,
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'node_state_after_cordon',
              captureType: 'command_output',
              statement: `kubectl get node ${targetNode} -o json`,
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: `Node ${targetNode} is cordoned (SchedulingDisabled)`,
          check: {
            type: 'structured_command',
            statement: 'node_ready_count',
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'automatic',
          description: `Uncordon ${targetNode} with kubectl uncordon.`,
        },
        blastRadius: {
          directComponents: [targetNode],
          indirectComponents: ['pod-scheduling'],
          maxImpact: 'node_unschedulable',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Human approval for drain
      {
        stepId: 'step-005',
        type: 'human_approval',
        name: `Approve drain of node ${targetNode}`,
        description: `Draining ${targetNode} will evict all running pods. This is a high-risk operation requiring approval.`,
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `Node ${targetNode} is cordoned. Pods on this node are experiencing failures.`,
          detail: `Draining ${targetNode} will evict all pods and allow rescheduling to healthy nodes.`,
          contextReferences: ['current_cluster_state'],
          proposedActions: [`Drain node ${targetNode}`, 'Evict all pods to healthy nodes'],
          riskSummary: 'High — all pods on the node will be terminated and rescheduled.',
          alternatives: [
            { action: 'wait', description: 'Wait for node to self-recover and pods to stabilize.' },
            { action: 'abort', description: 'Abort recovery and investigate node manually.' },
          ],
        },
        timeout: 'PT10M',
        timeoutAction: 'escalate',
        escalateTo: {
          role: 'platform_lead',
          message: `Drain approval for node ${targetNode} timed out. Escalating to platform lead.`,
        },
      },
      // Step 6: Drain node
      {
        stepId: 'step-006',
        type: 'system_action',
        name: `Drain node ${targetNode}`,
        description: `Evict all pods from ${targetNode} to allow rescheduling on healthy nodes.`,
        executionContext: 'k8s_admin',
        target: cluster,
        riskLevel: 'high',
        requiredCapabilities: ['k8s.node.drain'],
        command: {
          type: 'structured_command',
          operation: 'node_drain',
          parameters: { node: targetNode, gracePeriod: 30, force: false, deletEmptyDirData: true },
        },
        statePreservation: {
          before: [
            {
              name: 'pods_before_drain',
              captureType: 'command_output',
              statement: `kubectl get pods -A --field-selector spec.nodeName=${targetNode} -o json`,
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'pods_after_drain',
              captureType: 'command_output',
              statement: `kubectl get pods -A --field-selector spec.nodeName=${targetNode} -o json`,
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovering',
        successCriteria: {
          description: 'No CrashLoopBackOff pods remain',
          check: {
            type: 'structured_command',
            statement: 'pod_crashloop_count',
            expect: { operator: 'eq', value: 0 },
          },
        },
        rollback: {
          type: 'manual',
          description: `Uncordon ${targetNode} and allow pods to be rescheduled back if needed.`,
        },
        blastRadius: {
          directComponents: [targetNode],
          indirectComponents: affectedDeployments,
          maxImpact: 'pods_evicted_and_rescheduled',
          cascadeRisk: 'medium',
        },
        timeout: 'PT5M',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 7: Restart affected deployments
      {
        stepId: 'step-007',
        type: 'system_action',
        name: 'Restart affected deployments',
        description: `Rolling restart of ${affectedDeployments.join(', ')} to ensure all replicas are healthy.`,
        executionContext: 'k8s_admin',
        target: cluster,
        riskLevel: 'elevated',
        requiredCapabilities: ['k8s.deployment.restart'],
        command: {
          type: 'structured_command',
          operation: 'deployment_restart',
          parameters: { deployments: affectedDeployments, namespace: 'production' },
        },
        statePreservation: {
          before: [
            {
              name: 'deployment_state_before_restart',
              captureType: 'command_output',
              statement: 'kubectl get deployments -n production -o json',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'deployment_state_after_restart',
              captureType: 'command_output',
              statement: 'kubectl get deployments -n production -o json',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        stateTransition: 'recovered',
        successCriteria: {
          description: 'All deployments at full replicas',
          check: {
            type: 'structured_command',
            statement: 'deployment_ready',
            expect: { operator: 'eq', value: true },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Roll back deployments to previous revision with kubectl rollout undo.',
        },
        blastRadius: {
          directComponents: affectedDeployments,
          indirectComponents: ['production-services'],
          maxImpact: 'brief_service_restart',
          cascadeRisk: 'low',
        },
        timeout: 'PT3M',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 8: Replanning checkpoint
      {
        stepId: 'step-008',
        type: 'replanning_checkpoint',
        name: 'Verify pod health after recovery',
        description: 'Check if all pods are healthy or if further action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_recovery_pod_state',
            captureType: 'command_output',
            statement: 'kubectl get pods -A -o json',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 9: Recovery summary
      {
        stepId: 'step-009',
        type: 'human_notification',
        name: 'Send recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'platform_lead', urgency: 'medium' },
        ],
        message: {
          summary: `Kubernetes node failure recovery completed on ${cluster}`,
          detail: `Node ${targetNode} cordoned and drained. Affected deployments (${affectedDeployments.join(', ')}) restarted. All pods rescheduled to healthy nodes. Monitor cluster health and consider node replacement.`,
          contextReferences: ['post_recovery_pod_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'k8s-node',
        agentName: 'kubernetes-recovery',
        agentVersion: '1.0.0',
        scenario: diagnosis.scenario ?? 'node_not_ready_cascade',
        estimatedDuration: 'PT15M',
        summary: `Recover Kubernetes cluster from node failure on ${targetNode}: cordon, drain, restart affected deployments.`,
        supersedes: null,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: cluster,
            technology: 'kubernetes',
            role: 'worker-node',
            impactType: 'node_cordoned_pods_rescheduled',
          },
        ],
        affectedServices: affectedDeployments,
        estimatedUserImpact: 'Brief service disruption during pod rescheduling. No data loss expected.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Uncordon the node to restore scheduling. Deployment restarts are rolling and can be undone with rollout undo.',
      },
    };
  }

  replan = defaultReplan;
}
