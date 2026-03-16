// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * K8sBackend — interface for querying Kubernetes cluster state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface K8sNodeStatus {
  name: string;
  status: 'Ready' | 'NotReady' | 'SchedulingDisabled';
  roles: string[];
  kubeletVersion: string;
  conditions: Array<{ type: string; status: string; message: string }>;
  allocatable: { cpu: string; memory: string; pods: string };
  podCount: number;
}

export interface K8sPodInfo {
  name: string;
  namespace: string;
  nodeName: string;
  status: 'Running' | 'Pending' | 'CrashLoopBackOff' | 'Terminating' | 'Failed' | 'Unknown';
  restarts: number;
  age: string;
  containers: Array<{ name: string; ready: boolean; restartCount: number }>;
}

export interface K8sEvent {
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string; namespace: string };
  count: number;
  lastTimestamp: string;
}

export interface K8sDeploymentStatus {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  availableReplicas: number;
  conditions: Array<{ type: string; status: string; message: string }>;
}

export interface K8sPVCStatus {
  name: string;
  namespace: string;
  status: 'Bound' | 'Pending' | 'Terminating';
  capacity: string;
  storageClass: string;
  finalizers: string[];
}

export interface K8sBackend extends ExecutionBackend {
  /** Get status of all cluster nodes */
  getNodeStatus(): Promise<K8sNodeStatus[]>;

  /** Get pods in a given namespace */
  getPodsByNamespace(namespace: string): Promise<K8sPodInfo[]>;

  /** Get cluster events, optionally filtered by namespace */
  getEvents(namespace?: string): Promise<K8sEvent[]>;

  /** Get deployment status in a namespace */
  getDeploymentStatus(namespace: string): Promise<K8sDeploymentStatus[]>;

  /** Get PVC status in a namespace */
  getPVCStatus(namespace: string): Promise<K8sPVCStatus[]>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
