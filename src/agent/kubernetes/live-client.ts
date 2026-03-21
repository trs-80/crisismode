// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * K8sLiveClient — connects to real Kubernetes clusters and implements K8sBackend.
 *
 * Queries nodes, pods, deployments, PVCs, and events via the K8s API.
 * Supports kubeconfig, in-cluster ServiceAccount, and context-based auth.
 * Used when running the spoke against real infrastructure.
 */

import * as k8s from '@kubernetes/client-node';
import { setHeaderOptions } from '@kubernetes/client-node';
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

export interface K8sConnectionConfig {
  /** Path to kubeconfig file. If omitted, loads from default location. */
  kubeconfig?: string;
  /** Kubeconfig context to use. If omitted, uses the current context. */
  context?: string;
  /** Use in-cluster ServiceAccount auth instead of kubeconfig. */
  inCluster?: boolean;
  /** Connection timeout in milliseconds. */
  connectTimeoutMs?: number;
}

export class K8sLiveClient implements K8sBackend {
  private coreApi!: k8s.CoreV1Api;
  private appsApi!: k8s.AppsV1Api;
  private versionApi!: k8s.VersionApi;
  private kc!: k8s.KubeConfig;
  private config: K8sConnectionConfig;

  constructor(config: K8sConnectionConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.kc = new k8s.KubeConfig();

    if (this.config.inCluster) {
      this.kc.loadFromCluster();
    } else if (this.config.kubeconfig) {
      this.kc.loadFromFile(this.config.kubeconfig);
    } else {
      this.kc.loadFromDefault();
    }

    if (this.config.context) {
      this.kc.setCurrentContext(this.config.context);
    }

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.versionApi = this.kc.makeApiClient(k8s.VersionApi);

    // Verify connectivity
    await this.versionApi.getCode();
  }

  async getNodeStatus(): Promise<K8sNodeStatus[]> {
    const response = await this.coreApi.listNode();
    return (response.items ?? []).map((node) => {
      const conditions = (node.status?.conditions ?? []).map((c) => ({
        type: c.type ?? '',
        status: c.status ?? 'Unknown',
        message: c.message ?? '',
      }));

      const readyCondition = conditions.find((c) => c.type === 'Ready');
      const unschedulable = node.spec?.unschedulable === true;

      let status: K8sNodeStatus['status'] = 'NotReady';
      if (unschedulable) {
        status = 'SchedulingDisabled';
      } else if (readyCondition?.status === 'True') {
        status = 'Ready';
      }

      const labels = node.metadata?.labels ?? {};
      const roles = Object.keys(labels)
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.replace('node-role.kubernetes.io/', '') || 'worker');
      if (roles.length === 0) roles.push('worker');

      return {
        name: node.metadata?.name ?? 'unknown',
        status,
        roles,
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? 'unknown',
        conditions,
        allocatable: {
          cpu: node.status?.allocatable?.['cpu'] ?? '0',
          memory: node.status?.allocatable?.['memory'] ?? '0',
          pods: node.status?.allocatable?.['pods'] ?? '0',
        },
        podCount: 0, // Populated separately if needed; avoids extra API call
      };
    });
  }

  async getPodsByNamespace(namespace: string): Promise<K8sPodInfo[]> {
    const response = await this.coreApi.listNamespacedPod({ namespace });
    return (response.items ?? []).map((pod) => {
      const containerStatuses = pod.status?.containerStatuses ?? [];

      const totalRestarts = containerStatuses.reduce(
        (sum, c) => sum + (c.restartCount ?? 0),
        0,
      );

      let podStatus: K8sPodInfo['status'] = 'Unknown';
      if (pod.metadata?.deletionTimestamp) {
        podStatus = 'Terminating';
      } else if (pod.status?.phase === 'Running') {
        // Check for CrashLoopBackOff in waiting containers
        const hasCrashLoop = containerStatuses.some(
          (c) => c.state?.waiting?.reason === 'CrashLoopBackOff',
        );
        podStatus = hasCrashLoop ? 'CrashLoopBackOff' : 'Running';
      } else if (pod.status?.phase === 'Pending') {
        podStatus = 'Pending';
      } else if (pod.status?.phase === 'Failed') {
        podStatus = 'Failed';
      } else if (pod.status?.phase === 'Succeeded') {
        podStatus = 'Running'; // Treat completed pods as running for our purposes
      }

      const creationTimestamp = pod.metadata?.creationTimestamp;
      const age = creationTimestamp ? formatAge(new Date(creationTimestamp)) : 'unknown';

      return {
        name: pod.metadata?.name ?? 'unknown',
        namespace: pod.metadata?.namespace ?? namespace,
        nodeName: pod.spec?.nodeName ?? 'unassigned',
        status: podStatus,
        restarts: totalRestarts,
        age,
        containers: containerStatuses.map((c) => ({
          name: c.name ?? 'unknown',
          ready: c.ready ?? false,
          restartCount: c.restartCount ?? 0,
        })),
      };
    });
  }

  async getEvents(namespace?: string): Promise<K8sEvent[]> {
    const response = namespace
      ? await this.coreApi.listNamespacedEvent({ namespace })
      : await this.coreApi.listEventForAllNamespaces();

    return (response.items ?? []).map((event) => ({
      type: (event.type as K8sEvent['type']) ?? 'Normal',
      reason: event.reason ?? '',
      message: event.message ?? '',
      involvedObject: {
        kind: event.involvedObject?.kind ?? '',
        name: event.involvedObject?.name ?? '',
        namespace: event.involvedObject?.namespace ?? '',
      },
      count: event.count ?? 1,
      lastTimestamp: event.lastTimestamp
        ? new Date(event.lastTimestamp).toISOString()
        : new Date().toISOString(),
    }));
  }

  async getDeploymentStatus(namespace: string): Promise<K8sDeploymentStatus[]> {
    const response = await this.appsApi.listNamespacedDeployment({ namespace });
    return (response.items ?? []).map((dep) => ({
      name: dep.metadata?.name ?? 'unknown',
      namespace: dep.metadata?.namespace ?? namespace,
      replicas: dep.spec?.replicas ?? 0,
      readyReplicas: dep.status?.readyReplicas ?? 0,
      updatedReplicas: dep.status?.updatedReplicas ?? 0,
      availableReplicas: dep.status?.availableReplicas ?? 0,
      conditions: (dep.status?.conditions ?? []).map((c) => ({
        type: c.type ?? '',
        status: c.status ?? 'Unknown',
        message: c.message ?? '',
      })),
    }));
  }

  async getPVCStatus(namespace: string): Promise<K8sPVCStatus[]> {
    const response = await this.coreApi.listNamespacedPersistentVolumeClaim({ namespace });
    return (response.items ?? []).map((pvc) => {
      const phase = pvc.status?.phase ?? 'Pending';
      let status: K8sPVCStatus['status'] = 'Pending';
      if (phase === 'Bound') status = 'Bound';
      else if (pvc.metadata?.deletionTimestamp) status = 'Terminating';

      return {
        name: pvc.metadata?.name ?? 'unknown',
        namespace: pvc.metadata?.namespace ?? namespace,
        status,
        capacity: pvc.status?.capacity?.['storage'] ?? '0',
        storageClass: pvc.spec?.storageClassName ?? '',
        finalizers: pvc.metadata?.finalizers ?? [],
      };
    });
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'node_status':
        return { nodes: await this.getNodeStatus() };

      case 'node_cordon': {
        const nodeName = command.parameters?.node as string;
        if (!nodeName) throw new Error('node_cordon requires a node parameter');
        await this.coreApi.patchNode(
          { name: nodeName, body: { spec: { unschedulable: true } } },
          setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
        );
        return { cordoned: true, node: nodeName };
      }

      case 'node_drain': {
        const nodeName = command.parameters?.node as string;
        if (!nodeName) throw new Error('node_drain requires a node parameter');

        // List pods on the node, excluding DaemonSet pods and mirror pods
        const pods = await this.coreApi.listPodForAllNamespaces({
          fieldSelector: `spec.nodeName=${nodeName}`,
        });

        let evicted = 0;
        for (const pod of pods.items ?? []) {
          // Skip DaemonSet-managed pods
          const ownerRefs = pod.metadata?.ownerReferences ?? [];
          if (ownerRefs.some((r) => r.kind === 'DaemonSet')) continue;
          // Skip mirror pods (static pods)
          if (pod.metadata?.annotations?.['kubernetes.io/config.mirror']) continue;

          const eviction: k8s.V1Eviction = {
            apiVersion: 'policy/v1',
            kind: 'Eviction',
            metadata: {
              name: pod.metadata?.name,
              namespace: pod.metadata?.namespace,
            },
          };

          await this.coreApi.createNamespacedPodEviction({
            name: pod.metadata?.name ?? '',
            namespace: pod.metadata?.namespace ?? 'default',
            body: eviction,
          });
          evicted++;
        }

        return { drained: true, node: nodeName, evictedPods: evicted };
      }

      case 'pod_delete': {
        const podName = command.parameters?.pod as string;
        const namespace = (command.parameters?.namespace as string) ?? 'default';
        if (!podName) throw new Error('pod_delete requires a pod parameter');
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        return { deleted: true, pod: podName };
      }

      case 'deployment_restart': {
        const deployments = command.parameters?.deployments as string[] | undefined;
        const namespace = (command.parameters?.namespace as string) ?? 'default';
        if (!deployments?.length) throw new Error('deployment_restart requires deployments parameter');

        for (const depName of deployments) {
          // Same as `kubectl rollout restart` — patch the restart annotation
          const patch = {
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                  },
                },
              },
            },
          };
          await this.appsApi.patchNamespacedDeployment(
            { name: depName, namespace, body: patch },
            setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
          );
        }

        return { restarted: true, deployments };
      }

      case 'pvc_finalize': {
        const pvcName = command.parameters?.pvc as string;
        const namespace = (command.parameters?.namespace as string) ?? 'default';
        if (!pvcName) throw new Error('pvc_finalize requires a pvc parameter');

        // Remove all finalizers to allow deletion
        const patch = [{ op: 'remove', path: '/metadata/finalizers' }];
        await this.coreApi.patchNamespacedPersistentVolumeClaim(
          { name: pvcName, namespace, body: patch },
          setHeaderOptions('Content-Type', k8s.PatchStrategy.JsonPatch),
        );
        return { finalized: true, pvc: pvcName };
      }

      default:
        throw new Error(`Unknown K8s operation: ${command.operation}`);
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
      // Check across all namespaces
      const response = await this.coreApi.listPodForAllNamespaces();
      const crashloopCount = (response.items ?? []).filter((pod) => {
        const statuses = pod.status?.containerStatuses ?? [];
        return statuses.some((c) => c.state?.waiting?.reason === 'CrashLoopBackOff');
      }).length;
      return this.compare(crashloopCount, check.expect.operator, check.expect.value);
    }

    if (stmt === 'deployment_ready') {
      const namespace = (check as unknown as Record<string, unknown>).namespace as string ?? 'default';
      const deployments = await this.getDeploymentStatus(namespace);
      const allReady = deployments.every((d) => d.readyReplicas >= d.replicas);
      return this.compare(allReady, check.expect.operator, check.expect.value);
    }

    return true;
  }

  async discoverVersion(): Promise<string> {
    const info = await this.versionApi.getCode();
    return info.gitVersion ?? 'unknown';
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'k8s-live-admin',
        kind: 'capability_provider',
        name: 'Kubernetes Live Admin Provider',
        maturity: 'live_validated',
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

  async close(): Promise<void> {
    // @kubernetes/client-node does not require explicit cleanup
  }

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

function formatAge(created: Date): string {
  const diffMs = Date.now() - created.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}
