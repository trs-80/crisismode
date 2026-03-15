// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  K8sBackend,
  K8sNodeStatus,
  K8sPodInfo,
  K8sEvent,
  K8sDeploymentStatus,
  K8sPVCStatus,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

export type SimulatorState = 'degraded' | 'recovering' | 'recovered';

export class K8sSimulator implements K8sBackend {
  private state: SimulatorState = 'degraded';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getNodeStatus(): Promise<K8sNodeStatus[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            name: 'worker-1',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 12,
          },
          {
            name: 'worker-2',
            status: 'NotReady',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [
              { type: 'Ready', status: 'False', message: 'kubelet stopped posting node status' },
              { type: 'MemoryPressure', status: 'True', message: 'node has memory pressure' },
            ],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 8,
          },
          {
            name: 'worker-3',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 10,
          },
        ];
      case 'recovering':
        return [
          {
            name: 'worker-1',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 14,
          },
          {
            name: 'worker-2',
            status: 'SchedulingDisabled',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [
              { type: 'Ready', status: 'False', message: 'node is cordoned and draining' },
            ],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 3,
          },
          {
            name: 'worker-3',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 13,
          },
        ];
      case 'recovered':
        return [
          {
            name: 'worker-1',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 16,
          },
          {
            name: 'worker-2',
            status: 'SchedulingDisabled',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [
              { type: 'Ready', status: 'False', message: 'node is cordoned — awaiting maintenance' },
            ],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 0,
          },
          {
            name: 'worker-3',
            status: 'Ready',
            roles: ['worker'],
            kubeletVersion: 'v1.29.2',
            conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
            allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
            podCount: 14,
          },
        ];
    }
  }

  async getPodsByNamespace(_namespace: string): Promise<K8sPodInfo[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            name: 'payment-service-6b8f9-abc12',
            namespace: 'production',
            nodeName: 'worker-2',
            status: 'CrashLoopBackOff',
            restarts: 47,
            age: '2h',
            containers: [{ name: 'payment', ready: false, restartCount: 47 }],
          },
          {
            name: 'payment-service-6b8f9-def34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'payment-service-6b8f9-ghi56',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'order-service-7c9a0-jkl78',
            namespace: 'production',
            nodeName: 'worker-2',
            status: 'CrashLoopBackOff',
            restarts: 32,
            age: '1h',
            containers: [{ name: 'order', ready: false, restartCount: 32 }],
          },
          {
            name: 'order-service-7c9a0-mno90',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'order', ready: true, restartCount: 0 }],
          },
          {
            name: 'cache-service-8d1b2-pqr12',
            namespace: 'production',
            nodeName: 'worker-2',
            status: 'CrashLoopBackOff',
            restarts: 28,
            age: '1h30m',
            containers: [{ name: 'cache', ready: false, restartCount: 28 }],
          },
          {
            name: 'monitoring-agent-stu34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '24h',
            containers: [{ name: 'agent', ready: true, restartCount: 0 }],
          },
        ];
      case 'recovering':
        return [
          {
            name: 'payment-service-6b8f9-abc12',
            namespace: 'production',
            nodeName: 'worker-2',
            status: 'Terminating',
            restarts: 47,
            age: '2h',
            containers: [{ name: 'payment', ready: false, restartCount: 47 }],
          },
          {
            name: 'payment-service-6b8f9-def34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'payment-service-6b8f9-ghi56',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'order-service-7c9a0-jkl78',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Pending',
            restarts: 32,
            age: '1h',
            containers: [{ name: 'order', ready: false, restartCount: 32 }],
          },
          {
            name: 'order-service-7c9a0-mno90',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'order', ready: true, restartCount: 0 }],
          },
          {
            name: 'cache-service-8d1b2-pqr12',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Pending',
            restarts: 28,
            age: '1h30m',
            containers: [{ name: 'cache', ready: false, restartCount: 28 }],
          },
          {
            name: 'monitoring-agent-stu34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '24h',
            containers: [{ name: 'agent', ready: true, restartCount: 0 }],
          },
        ];
      case 'recovered':
        return [
          {
            name: 'payment-service-6b8f9-xyz99',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '5m',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'payment-service-6b8f9-def34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'payment-service-6b8f9-ghi56',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'payment', ready: true, restartCount: 0 }],
          },
          {
            name: 'order-service-7c9a0-uvw88',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '5m',
            containers: [{ name: 'order', ready: true, restartCount: 0 }],
          },
          {
            name: 'order-service-7c9a0-mno90',
            namespace: 'production',
            nodeName: 'worker-3',
            status: 'Running',
            restarts: 0,
            age: '12h',
            containers: [{ name: 'order', ready: true, restartCount: 0 }],
          },
          {
            name: 'cache-service-8d1b2-rst77',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '5m',
            containers: [{ name: 'cache', ready: true, restartCount: 0 }],
          },
          {
            name: 'monitoring-agent-stu34',
            namespace: 'production',
            nodeName: 'worker-1',
            status: 'Running',
            restarts: 0,
            age: '24h',
            containers: [{ name: 'agent', ready: true, restartCount: 0 }],
          },
        ];
    }
  }

  async getEvents(_namespace?: string): Promise<K8sEvent[]> {
    const now = new Date().toISOString();
    switch (this.state) {
      case 'degraded':
        return [
          {
            type: 'Warning',
            reason: 'NodeNotReady',
            message: 'Node worker-2 status is now: NodeNotReady',
            involvedObject: { kind: 'Node', name: 'worker-2', namespace: '' },
            count: 5,
            lastTimestamp: now,
          },
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            message: 'No nodes are available: 1 node(s) had taint {node.kubernetes.io/not-ready}',
            involvedObject: { kind: 'Pod', name: 'payment-service-6b8f9-abc12', namespace: 'production' },
            count: 12,
            lastTimestamp: now,
          },
          {
            type: 'Warning',
            reason: 'BackOff',
            message: 'Back-off restarting failed container',
            involvedObject: { kind: 'Pod', name: 'order-service-7c9a0-jkl78', namespace: 'production' },
            count: 32,
            lastTimestamp: now,
          },
        ];
      case 'recovering':
        return [
          {
            type: 'Warning',
            reason: 'NodeNotReady',
            message: 'Node worker-2 status is now: NodeNotReady',
            involvedObject: { kind: 'Node', name: 'worker-2', namespace: '' },
            count: 5,
            lastTimestamp: now,
          },
          {
            type: 'Normal',
            reason: 'NodeCordon',
            message: 'Node worker-2 cordoned',
            involvedObject: { kind: 'Node', name: 'worker-2', namespace: '' },
            count: 1,
            lastTimestamp: now,
          },
        ];
      case 'recovered':
        return [
          {
            type: 'Normal',
            reason: 'Scheduled',
            message: 'Successfully assigned production/payment-service-6b8f9-xyz99 to worker-1',
            involvedObject: { kind: 'Pod', name: 'payment-service-6b8f9-xyz99', namespace: 'production' },
            count: 1,
            lastTimestamp: now,
          },
          {
            type: 'Normal',
            reason: 'Started',
            message: 'Started container payment',
            involvedObject: { kind: 'Pod', name: 'payment-service-6b8f9-xyz99', namespace: 'production' },
            count: 1,
            lastTimestamp: now,
          },
        ];
    }
  }

  async getDeploymentStatus(_namespace: string): Promise<K8sDeploymentStatus[]> {
    switch (this.state) {
      case 'degraded':
        return [
          {
            name: 'payment-service',
            namespace: 'production',
            replicas: 3,
            readyReplicas: 2,
            updatedReplicas: 3,
            availableReplicas: 2,
            conditions: [
              { type: 'Available', status: 'False', message: 'Deployment does not have minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet "payment-service-6b8f9" is progressing' },
            ],
          },
          {
            name: 'order-service',
            namespace: 'production',
            replicas: 2,
            readyReplicas: 1,
            updatedReplicas: 2,
            availableReplicas: 1,
            conditions: [
              { type: 'Available', status: 'False', message: 'Deployment does not have minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet "order-service-7c9a0" is progressing' },
            ],
          },
        ];
      case 'recovering':
        return [
          {
            name: 'payment-service',
            namespace: 'production',
            replicas: 3,
            readyReplicas: 2,
            updatedReplicas: 3,
            availableReplicas: 2,
            conditions: [
              { type: 'Available', status: 'False', message: 'Deployment does not have minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet is progressing' },
            ],
          },
          {
            name: 'order-service',
            namespace: 'production',
            replicas: 2,
            readyReplicas: 1,
            updatedReplicas: 2,
            availableReplicas: 1,
            conditions: [
              { type: 'Available', status: 'False', message: 'Deployment does not have minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet is progressing' },
            ],
          },
        ];
      case 'recovered':
        return [
          {
            name: 'payment-service',
            namespace: 'production',
            replicas: 3,
            readyReplicas: 3,
            updatedReplicas: 3,
            availableReplicas: 3,
            conditions: [
              { type: 'Available', status: 'True', message: 'Deployment has minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet has successfully progressed' },
            ],
          },
          {
            name: 'order-service',
            namespace: 'production',
            replicas: 2,
            readyReplicas: 2,
            updatedReplicas: 2,
            availableReplicas: 2,
            conditions: [
              { type: 'Available', status: 'True', message: 'Deployment has minimum availability' },
              { type: 'Progressing', status: 'True', message: 'ReplicaSet has successfully progressed' },
            ],
          },
        ];
    }
  }

  async getPVCStatus(_namespace: string): Promise<K8sPVCStatus[]> {
    // No stuck PVCs in this scenario
    return [
      {
        name: 'data-payment-service-0',
        namespace: 'production',
        status: 'Bound',
        capacity: '10Gi',
        storageClass: 'gp3',
        finalizers: ['kubernetes.io/pvc-protection'],
      },
    ];
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported K8s simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'node_status':
        return { nodes: await this.getNodeStatus() };
      case 'node_cordon':
        this.transition('recovering');
        return { cordoned: true, node: command.parameters?.node ?? 'worker-2' };
      case 'node_drain':
        return { drained: true, node: command.parameters?.node ?? 'worker-2' };
      case 'deployment_restart':
        this.transition('recovered');
        return { restarted: true, deployments: command.parameters?.deployments ?? [] };
      case 'pod_delete':
        return { deleted: true, pod: command.parameters?.pod ?? 'unknown' };
      case 'pvc_finalize':
        return { finalized: true, pvc: command.parameters?.pvc ?? 'unknown' };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'node_ready_count') {
      const nodes = await this.getNodeStatus();
      const readyCount = nodes.filter((n) => n.status === 'Ready').length;
      return this.compare(readyCount, check.expect.operator, check.expect.value);
    }

    if (stmt === 'pod_crashloop_count') {
      const pods = await this.getPodsByNamespace('production');
      const crashloopCount = pods.filter((p) => p.status === 'CrashLoopBackOff').length;
      return this.compare(crashloopCount, check.expect.operator, check.expect.value);
    }

    if (stmt === 'deployment_ready') {
      const deployments = await this.getDeploymentStatus('production');
      const allReady = deployments.every((d) => d.readyReplicas >= d.replicas);
      return this.compare(allReady, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'k8s-simulator-admin',
        kind: 'capability_provider',
        name: 'Kubernetes Simulator Admin Provider',
        maturity: 'simulator_only',
        capabilities: [
          'k8s.node.cordon',
          'k8s.node.drain',
          'k8s.pod.delete',
          'k8s.deployment.restart',
          'k8s.pvc.finalize',
        ],
        executionContexts: ['k8s_admin'],
        targetKinds: ['kubernetes'],
        commandTypes: ['structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
