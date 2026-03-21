// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Integration tests for Phase 2 live clients.
 *
 * These tests validate that each live client:
 * 1. Implements the full backend interface
 * 2. Has correct capability provider descriptors
 * 3. Handles executeCommand and evaluateCheck correctly
 * 4. Cleans up resources via close()
 *
 * Tests that require real infrastructure (Vercel API, PostgreSQL, Redis)
 * use mocked network calls. Integration tests against real services
 * should be run separately via the podman test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Kubernetes Live Client ──
//
// Tests follow Khorikov's principles:
// - Verify observable behavior (return values, thrown errors), not implementation
// - Each test is a behavioral specification — name describes the outcome
// - Mocks are stubs for unmanaged dependencies (K8s API); assertions are on outputs only
// - Tests cover the domain logic inside the live client: status mapping, filtering, error guarding

describe('K8sLiveClient', () => {
  let K8sLiveClient: typeof import('../agent/kubernetes/live-client.js').K8sLiveClient;

  // ── Test data: realistic K8s API response shapes ──

  function makeNode(name: string, overrides: Record<string, unknown> = {}) {
    return {
      metadata: { name, labels: { 'node-role.kubernetes.io/worker': '' }, ...overrides },
      spec: { unschedulable: false },
      status: {
        conditions: [{ type: 'Ready', status: 'True', message: 'kubelet is posting ready status' }],
        nodeInfo: { kubeletVersion: 'v1.29.2' },
        allocatable: { cpu: '8', memory: '32Gi', pods: '110' },
      },
    };
  }

  function makePod(name: string, phase: string, overrides: Record<string, unknown> = {}) {
    const waitingState = phase === 'CrashLoopBackOff'
      ? { waiting: { reason: 'CrashLoopBackOff' } }
      : { running: {} };
    return {
      metadata: { name, namespace: 'production', creationTimestamp: new Date(Date.now() - 3_600_000).toISOString(), ...overrides },
      spec: { nodeName: 'worker-1' },
      status: {
        phase: phase === 'CrashLoopBackOff' ? 'Running' : phase,
        containerStatuses: [{ name: 'app', ready: phase === 'Running', restartCount: phase === 'CrashLoopBackOff' ? 47 : 0, state: waitingState }],
      },
    };
  }

  function createMockClient(apiOverrides: {
    nodes?: unknown[];
    pods?: unknown[];
    events?: unknown[];
    deployments?: unknown[];
    pvcs?: unknown[];
  } = {}) {
    const client = Object.create(K8sLiveClient.prototype) as InstanceType<typeof K8sLiveClient>;

    const nodes = apiOverrides.nodes ?? [makeNode('worker-1'), makeNode('worker-2')];
    const pods = apiOverrides.pods ?? [makePod('app-abc', 'Running')];
    const events = apiOverrides.events ?? [];
    const deployments = apiOverrides.deployments ?? [];
    const pvcs = apiOverrides.pvcs ?? [];

    const mockCoreApi = {
      listNode: vi.fn().mockResolvedValue({ items: nodes }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
      listNamespacedEvent: vi.fn().mockResolvedValue({ items: events }),
      listEventForAllNamespaces: vi.fn().mockResolvedValue({ items: events }),
      listNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ items: pvcs }),
      listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: pods }),
      patchNode: vi.fn().mockResolvedValue({}),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
      createNamespacedPodEviction: vi.fn().mockResolvedValue({}),
      patchNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    };

    const mockAppsApi = {
      listNamespacedDeployment: vi.fn().mockResolvedValue({ items: deployments }),
      patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    };

    const mockVersionApi = {
      getCode: vi.fn().mockResolvedValue({ gitVersion: 'v1.29.2' }),
    };

    Object.defineProperty(client, 'coreApi', { value: mockCoreApi, writable: true });
    Object.defineProperty(client, 'appsApi', { value: mockAppsApi, writable: true });
    Object.defineProperty(client, 'versionApi', { value: mockVersionApi, writable: true });
    Object.defineProperty(client, 'config', { value: {}, writable: true });

    return client;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/kubernetes/live-client.js');
    K8sLiveClient = mod.K8sLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Node status mapping ──

  describe('node status classification', () => {
    it('reports a node with Ready=True as Ready', async () => {
      const client = createMockClient({ nodes: [makeNode('worker-1')] });
      const [node] = await client.getNodeStatus();
      expect(node.status).toBe('Ready');
      expect(node.name).toBe('worker-1');
    });

    it('reports a node with Ready=False as NotReady', async () => {
      const node = makeNode('worker-2');
      node.status.conditions = [{ type: 'Ready', status: 'False', message: 'kubelet stopped' }];
      const client = createMockClient({ nodes: [node] });
      const [result] = await client.getNodeStatus();
      expect(result.status).toBe('NotReady');
    });

    it('reports an unschedulable node as SchedulingDisabled regardless of Ready condition', async () => {
      const node = makeNode('worker-3');
      node.spec = { unschedulable: true };
      const client = createMockClient({ nodes: [node] });
      const [result] = await client.getNodeStatus();
      expect(result.status).toBe('SchedulingDisabled');
    });

    it('extracts roles from node-role.kubernetes.io labels', async () => {
      const node = makeNode('control-plane-1', {
        labels: { 'node-role.kubernetes.io/control-plane': '', 'node-role.kubernetes.io/master': '' },
      });
      const client = createMockClient({ nodes: [node] });
      const [result] = await client.getNodeStatus();
      expect(result.roles).toContain('control-plane');
      expect(result.roles).toContain('master');
    });

    it('defaults to worker role when no role labels are present', async () => {
      const node = makeNode('bare-node', { labels: {} });
      const client = createMockClient({ nodes: [node] });
      const [result] = await client.getNodeStatus();
      expect(result.roles).toEqual(['worker']);
    });
  });

  // ── Pod status mapping ──

  describe('pod status classification', () => {
    it('detects CrashLoopBackOff from container waiting state, not pod phase', async () => {
      const pod = makePod('crash-pod', 'CrashLoopBackOff');
      const client = createMockClient({ pods: [pod] });
      const [result] = await client.getPodsByNamespace('production');
      expect(result.status).toBe('CrashLoopBackOff');
      expect(result.restarts).toBe(47);
    });

    it('reports Pending pods as Pending', async () => {
      const pod = makePod('pending-pod', 'Pending');
      const client = createMockClient({ pods: [pod] });
      const [result] = await client.getPodsByNamespace('production');
      expect(result.status).toBe('Pending');
    });

    it('reports pods with deletionTimestamp as Terminating', async () => {
      const pod = makePod('dying-pod', 'Running', { deletionTimestamp: new Date().toISOString() });
      const client = createMockClient({ pods: [pod] });
      const [result] = await client.getPodsByNamespace('production');
      expect(result.status).toBe('Terminating');
    });

    it('reports Failed pods as Failed', async () => {
      const pod = makePod('failed-pod', 'Failed');
      const client = createMockClient({ pods: [pod] });
      const [result] = await client.getPodsByNamespace('production');
      expect(result.status).toBe('Failed');
    });

    it('computes human-readable age from creationTimestamp', async () => {
      const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
      const pod = makePod('old-pod', 'Running', { creationTimestamp: twoHoursAgo });
      const client = createMockClient({ pods: [pod] });
      const [result] = await client.getPodsByNamespace('production');
      expect(result.age).toBe('2h');
    });
  });

  // ── Events ──

  describe('event retrieval', () => {
    const warningEvent = {
      type: 'Warning', reason: 'NodeNotReady', message: 'Node worker-2 is not ready',
      involvedObject: { kind: 'Node', name: 'worker-2', namespace: '' },
      count: 5, lastTimestamp: new Date().toISOString(),
    };

    it('returns events scoped to a namespace when namespace is provided', async () => {
      const client = createMockClient({ events: [warningEvent] });
      const events = await client.getEvents('production');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('Warning');
      expect(events[0].reason).toBe('NodeNotReady');
    });

    it('returns cluster-wide events when no namespace is given', async () => {
      const client = createMockClient({ events: [warningEvent] });
      const events = await client.getEvents();
      expect(events).toHaveLength(1);
    });
  });

  // ── Deployments ──

  describe('deployment status', () => {
    it('maps replica counts and availability conditions from the API response', async () => {
      const client = createMockClient({
        deployments: [{
          metadata: { name: 'payment-service', namespace: 'production' },
          spec: { replicas: 3 },
          status: {
            readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2,
            conditions: [{ type: 'Available', status: 'False', message: 'Not enough replicas' }],
          },
        }],
      });
      const [dep] = await client.getDeploymentStatus('production');
      expect(dep.replicas).toBe(3);
      expect(dep.readyReplicas).toBe(2);
      expect(dep.conditions[0].status).toBe('False');
    });
  });

  // ── PVCs ──

  describe('PVC status', () => {
    it('maps Bound PVCs with their finalizers and capacity', async () => {
      const client = createMockClient({
        pvcs: [{
          metadata: { name: 'data-vol', namespace: 'production', finalizers: ['kubernetes.io/pvc-protection'] },
          spec: { storageClassName: 'gp3' },
          status: { phase: 'Bound', capacity: { storage: '10Gi' } },
        }],
      });
      const [pvc] = await client.getPVCStatus('production');
      expect(pvc.status).toBe('Bound');
      expect(pvc.capacity).toBe('10Gi');
      expect(pvc.finalizers).toContain('kubernetes.io/pvc-protection');
    });

    it('reports PVCs with deletionTimestamp as Terminating', async () => {
      const client = createMockClient({
        pvcs: [{
          metadata: { name: 'stuck-pvc', namespace: 'production', deletionTimestamp: new Date().toISOString(), finalizers: ['x'] },
          spec: { storageClassName: 'gp3' },
          status: { phase: 'Bound', capacity: { storage: '5Gi' } },
        }],
      });
      const [pvc] = await client.getPVCStatus('production');
      expect(pvc.status).toBe('Terminating');
    });
  });

  // ── Command execution: observable outcomes ──

  describe('executeCommand', () => {
    it('node_cordon returns confirmation with the cordoned node name', async () => {
      const client = createMockClient();
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'node_cordon', parameters: { node: 'worker-2' },
      }) as Record<string, unknown>;
      expect(result).toEqual({ cordoned: true, node: 'worker-2' });
    });

    it('node_cordon rejects when no node parameter is given', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({
        type: 'structured_command', operation: 'node_cordon', parameters: {},
      })).rejects.toThrow('node_cordon requires a node parameter');
    });

    it('node_drain reports the number of evicted pods', async () => {
      const client = createMockClient({ pods: [makePod('app-1', 'Running'), makePod('app-2', 'Running')] });
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'node_drain', parameters: { node: 'worker-2' },
      }) as Record<string, unknown>;
      expect(result).toEqual({ drained: true, node: 'worker-2', evictedPods: 2 });
    });

    it('node_drain skips DaemonSet-managed pods', async () => {
      const daemonPod = makePod('fluentd-xyz', 'Running');
      (daemonPod.metadata as Record<string, unknown>).ownerReferences = [{ kind: 'DaemonSet', name: 'fluentd' }];
      const regularPod = makePod('app-1', 'Running');
      const client = createMockClient({ pods: [daemonPod, regularPod] });
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'node_drain', parameters: { node: 'worker-1' },
      }) as Record<string, unknown>;
      expect(result.evictedPods).toBe(1);
    });

    it('node_drain skips mirror pods (static pods)', async () => {
      const mirrorPod = makePod('kube-apiserver-cp1', 'Running');
      (mirrorPod.metadata as Record<string, unknown>).annotations = { 'kubernetes.io/config.mirror': 'abc123' };
      const regularPod = makePod('app-1', 'Running');
      const client = createMockClient({ pods: [mirrorPod, regularPod] });
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'node_drain', parameters: { node: 'worker-1' },
      }) as Record<string, unknown>;
      expect(result.evictedPods).toBe(1);
    });

    it('node_drain rejects when no node parameter is given', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({
        type: 'structured_command', operation: 'node_drain', parameters: {},
      })).rejects.toThrow('node_drain requires a node parameter');
    });

    it('pod_delete returns confirmation with the deleted pod name', async () => {
      const client = createMockClient();
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'pod_delete', parameters: { pod: 'stuck-pod', namespace: 'production' },
      }) as Record<string, unknown>;
      expect(result).toEqual({ deleted: true, pod: 'stuck-pod' });
    });

    it('pod_delete rejects when no pod parameter is given', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({
        type: 'structured_command', operation: 'pod_delete', parameters: {},
      })).rejects.toThrow('pod_delete requires a pod parameter');
    });

    it('deployment_restart returns confirmation with the restarted deployment names', async () => {
      const client = createMockClient();
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'deployment_restart',
        parameters: { deployments: ['payment-service', 'order-service'], namespace: 'production' },
      }) as Record<string, unknown>;
      expect(result).toEqual({ restarted: true, deployments: ['payment-service', 'order-service'] });
    });

    it('deployment_restart rejects when no deployments are given', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({
        type: 'structured_command', operation: 'deployment_restart', parameters: { deployments: [] },
      })).rejects.toThrow('deployment_restart requires deployments parameter');
    });

    it('pvc_finalize returns confirmation with the finalized PVC name', async () => {
      const client = createMockClient();
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'pvc_finalize', parameters: { pvc: 'stuck-pvc', namespace: 'production' },
      }) as Record<string, unknown>;
      expect(result).toEqual({ finalized: true, pvc: 'stuck-pvc' });
    });

    it('pvc_finalize rejects when no pvc parameter is given', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({
        type: 'structured_command', operation: 'pvc_finalize', parameters: {},
      })).rejects.toThrow('pvc_finalize requires a pvc parameter');
    });

    it('node_status returns the current cluster node list', async () => {
      const client = createMockClient({ nodes: [makeNode('worker-1')] });
      const result = await client.executeCommand({
        type: 'structured_command', operation: 'node_status',
      }) as { nodes: unknown[] };
      expect(result.nodes).toHaveLength(1);
    });

    it('rejects non-structured_command types', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
        .rejects.toThrow('Unsupported command type');
    });

    it('rejects unknown operations', async () => {
      const client = createMockClient();
      await expect(client.executeCommand({ type: 'structured_command', operation: 'launch_missiles' }))
        .rejects.toThrow('Unknown K8s operation');
    });
  });

  // ── Health checks: domain logic correctness ──

  describe('evaluateCheck', () => {
    it('node_ready_count counts only Ready nodes', async () => {
      const notReadyNode = makeNode('worker-2');
      notReadyNode.status.conditions = [{ type: 'Ready', status: 'False', message: 'down' }];
      const client = createMockClient({ nodes: [makeNode('worker-1'), notReadyNode] });
      // 1 of 2 nodes is Ready
      expect(await client.evaluateCheck({
        type: 'structured_command', statement: 'node_ready_count', expect: { operator: 'eq', value: 1 },
      })).toBe(true);
      expect(await client.evaluateCheck({
        type: 'structured_command', statement: 'node_ready_count', expect: { operator: 'gte', value: 2 },
      })).toBe(false);
    });

    it('pod_crashloop_count counts pods in CrashLoopBackOff across all namespaces', async () => {
      const client = createMockClient({
        pods: [makePod('healthy', 'Running'), makePod('crashing', 'CrashLoopBackOff')],
      });
      expect(await client.evaluateCheck({
        type: 'structured_command', statement: 'pod_crashloop_count', expect: { operator: 'eq', value: 1 },
      })).toBe(true);
    });

    it('deployment_ready is true only when all deployments have full replicas', async () => {
      const client = createMockClient({
        deployments: [
          { metadata: { name: 'a', namespace: 'default' }, spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3, conditions: [] } },
          { metadata: { name: 'b', namespace: 'default' }, spec: { replicas: 2 }, status: { readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1, conditions: [] } },
        ],
      });
      // Not all ready (deployment b has 1/2)
      expect(await client.evaluateCheck({
        type: 'structured_command', statement: 'deployment_ready', expect: { operator: 'eq', value: 'true' },
      })).toBe(false);
    });

    it('returns true for unknown check statements (safe default)', async () => {
      const client = createMockClient();
      expect(await client.evaluateCheck({
        type: 'structured_command', statement: 'unknown_check', expect: { operator: 'eq', value: 1 },
      })).toBe(true);
    });
  });

  // ── Capability provider contract ──

  describe('capability provider', () => {
    it('declares live_validated maturity with all K8s admin capabilities', () => {
      const client = createMockClient();
      const [provider] = client.listCapabilityProviders();
      expect(provider.maturity).toBe('live_validated');
      expect(provider.capabilities).toEqual(expect.arrayContaining([
        'k8s.node.cordon', 'k8s.node.drain', 'k8s.pod.delete',
        'k8s.deployment.restart', 'k8s.pvc.finalize',
      ]));
      expect(provider.targetKinds).toContain('kubernetes');
    });
  });

  // ── Version discovery ──

  it('reports the cluster gitVersion', async () => {
    const client = createMockClient();
    const version = await client.discoverVersion();
    expect(version).toBe('v1.29.2');
  });

  // ── Cleanup ──

  it('close resolves without error', async () => {
    const client = createMockClient();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ── Kubernetes Registration (controller / integration boundary) ──
//
// Khorikov: registration is a controller — it orchestrates choosing a backend.
// Test it through its observable output (returns a working agent + backend),
// not by mocking its internal imports.

describe('K8s registration', () => {
  it('returns a functional agent backed by the simulator for simulator targets', async () => {
    const { k8sRecoveryRegistration } = await import('../agent/kubernetes/registration.js');
    const { assembleContext } = await import('../framework/context.js');
    const target = {
      name: 'test-k8s',
      kind: 'kubernetes',
      primary: { host: 'simulator', port: 6443 },
      replicas: [],
      credentials: { username: '', password: '' },
    };
    const result = await k8sRecoveryRegistration.createAgent(target);
    expect(result.agent).toBeDefined();
    expect(result.backend).toBeDefined();
    // The agent should be usable — assessHealth is the observable contract
    const trigger = { type: 'manual' as const, source: 'test', payload: {}, receivedAt: new Date().toISOString() };
    const context = assembleContext(trigger, k8sRecoveryRegistration.manifest);
    const health = await result.agent.assessHealth(context);
    expect(health.status).toBeDefined();
  });

  it('falls back to simulator when live client connection fails', async () => {
    const { k8sRecoveryRegistration } = await import('../agent/kubernetes/registration.js');
    const { assembleContext } = await import('../framework/context.js');
    const target = {
      name: 'test-k8s',
      kind: 'kubernetes',
      // Non-routable path will fail to connect
      primary: { host: '/nonexistent/kubeconfig/path', port: 6443 },
      replicas: [],
      credentials: { username: '', password: '' },
    };
    const result = await k8sRecoveryRegistration.createAgent(target);
    // Should succeed (fell back to simulator) — not throw
    expect(result.agent).toBeDefined();
    const trigger = { type: 'manual' as const, source: 'test', payload: {}, receivedAt: new Date().toISOString() };
    const context = assembleContext(trigger, k8sRecoveryRegistration.manifest);
    const health = await result.agent.assessHealth(context);
    expect(health.status).toBeDefined();
  });
});

// ── Deploy Rollback Live Client ──

describe('DeployLiveClient', () => {
  let DeployLiveClient: typeof import('../agent/deploy-rollback/live-client.js').DeployLiveClient;

  const mockConfig = {
    token: 'test-token',
    projectId: 'prj_test123',
    teamId: 'team_test',
    healthEndpoints: ['https://app.example.com/healthz'],
    timeoutMs: 5_000,
  };

  const mockDeployment = {
    uid: 'dpl_abc123',
    name: 'my-app',
    url: 'my-app-abc123.vercel.app',
    state: 'READY',
    readyState: 'READY',
    created: Date.now() - 60_000,
    meta: {
      githubCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      githubCommitMessage: 'feat: add new feature',
      githubCommitAuthorLogin: 'developer',
    },
  };

  const mockOlderDeployment = {
    ...mockDeployment,
    uid: 'dpl_older456',
    created: Date.now() - 3_600_000,
    meta: {
      ...mockDeployment.meta,
      githubCommitSha: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
      githubCommitMessage: 'fix: previous fix',
    },
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/deploy-rollback/live-client.js');
    DeployLiveClient = mod.DeployLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements DeployBackend interface', () => {
    const client = new DeployLiveClient(mockConfig);
    expect(typeof client.getCurrentDeployment).toBe('function');
    expect(typeof client.listRecentDeploys).toBe('function');
    expect(typeof client.getTrafficDistribution).toBe('function');
    expect(typeof client.getHealthEndpoints).toBe('function');
    expect(typeof client.getRollbackTarget).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new DeployLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('deploy.status.read');
    expect(providers[0].capabilities).toContain('deploy.rollback');
  });

  it('getCurrentDeployment fetches from Vercel API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const deploy = await client.getCurrentDeployment();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(deploy.sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    expect(deploy.status).toBe('succeeded');
    expect(deploy.author).toBe('developer');
  });

  it('listRecentDeploys returns multiple deployments', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment, mockOlderDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const deploys = await client.listRecentDeploys(5);
    expect(deploys).toHaveLength(2);
    expect(deploys[0].sha).not.toBe(deploys[1].sha);
  });

  it('getHealthEndpoints probes configured URLs', async () => {
    // First call is for API, remaining for health endpoints
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('OK', { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const endpoints = await client.getHealthEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].url).toBe('https://app.example.com/healthz');
    expect(endpoints[0].status).toBe('healthy');
  });

  it('getHealthEndpoints marks failed endpoints as down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const client = new DeployLiveClient(mockConfig);
    const endpoints = await client.getHealthEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status).toBe('down');
    expect(endpoints[0].errorRate).toBe(100);
  });

  it('getRollbackTarget finds last successful deploy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployments: [mockDeployment, mockOlderDeployment] }), { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const target = await client.getRollbackTarget();
    expect(target).not.toBeNull();
    expect(target!.sha).toBe(mockOlderDeployment.meta.githubCommitSha);
  });

  it('executeCommand handles deploy_status', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deployments: [mockDeployment] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }));

    const client = new DeployLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'deploy_status' }) as Record<string, unknown>;
    expect(result).toHaveProperty('current');
    expect(result).toHaveProperty('traffic');
    expect(result).toHaveProperty('endpoints');
  });

  it('rejects unsupported command types', async () => {
    const client = new DeployLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported deploy live client command type');
  });

  it('evaluateCheck handles deploy_health', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('OK', { status: 200 }),
    );

    const client = new DeployLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'deploy_health',
      expect: { operator: 'lte', value: 10 },
    });
    expect(result).toBe(true);
  });

  it('transition is a no-op', () => {
    const client = new DeployLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });

  it('close is safe to call', async () => {
    const client = new DeployLiveClient(mockConfig);
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ── AI Provider Live Client ──

describe('AiProviderLiveClient', () => {
  let AiProviderLiveClient: typeof import('../agent/ai-provider/live-client.js').AiProviderLiveClient;

  const mockConfig = {
    providers: [
      {
        name: 'openai',
        endpoint: 'https://api.openai.com/v1',
        healthPath: '/models',
        apiKey: 'sk-test',
        priority: 1,
        enabled: true,
      },
      {
        name: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        healthPath: '/models',
        apiKey: 'sk-ant-test',
        authHeader: 'x-api-key',
        authPrefix: '',
        priority: 2,
        enabled: true,
      },
    ],
    timeoutMs: 5_000,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/ai-provider/live-client.js');
    AiProviderLiveClient = mod.AiProviderLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements AiProviderBackend interface', () => {
    const client = new AiProviderLiveClient(mockConfig);
    expect(typeof client.getProviderStatus).toBe('function');
    expect(typeof client.getRequestMetrics).toBe('function');
    expect(typeof client.getCircuitBreakerState).toBe('function');
    expect(typeof client.getFallbackConfig).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new AiProviderLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('provider.status.read');
    expect(providers[1].capabilities).toContain('provider.circuit_breaker.trip');
  });

  it('getProviderStatus probes each provider', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const statuses = await client.getProviderStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses[0].name).toBe('openai');
    expect(statuses[0].status).toBe('healthy');
    expect(statuses[1].name).toBe('anthropic');
  });

  it('marks down providers correctly', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const statuses = await client.getProviderStatus();
    expect(statuses[0].status).toBe('down');
    expect(statuses[1].status).toBe('healthy');
  });

  it('circuit breakers start closed', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const states = await client.getCircuitBreakerState();
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.state === 'closed')).toBe(true);
  });

  it('getFallbackConfig returns sorted chain', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const config = await client.getFallbackConfig();
    expect(config.chain).toHaveLength(2);
    expect(config.chain[0].provider).toBe('openai');
    expect(config.chain[0].priority).toBe(1);
  });

  it('getRequestMetrics returns valid defaults', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    const metrics = await client.getRequestMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.successRate).toBe(1);
  });

  it('getRequestMetrics tracks probes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    await client.getProviderStatus(); // This triggers probes
    const metrics = await client.getRequestMetrics();
    expect(metrics.totalRequests).toBe(2);
  });

  it('executeCommand trip_circuit_breaker opens a breaker', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await client.executeCommand({ type: 'api_call', operation: 'trip_circuit_breaker', parameters: { provider: 'openai' } });
    const states = await client.getCircuitBreakerState();
    const openai = states.find((s) => s.provider === 'openai')!;
    expect(openai.state).toBe('open');
  });

  it('executeCommand restore_primary resets all breakers', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await client.executeCommand({ type: 'api_call', operation: 'trip_circuit_breaker', parameters: { provider: 'openai' } });
    await client.executeCommand({ type: 'api_call', operation: 'restore_primary' });
    const states = await client.getCircuitBreakerState();
    expect(states.every((s) => s.state === 'closed')).toBe(true);
  });

  it('evaluateCheck handles provider_ping', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const client = new AiProviderLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'provider_ping',
      expect: { operator: 'eq', value: 'ok' },
    });
    expect(result).toBe(true);
  });

  it('rejects unsupported command types', async () => {
    const client = new AiProviderLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported AI provider live client command type');
  });
});

// ── DB Migration Live Client ──

describe('DbMigrationLiveClient', () => {
  // We can't easily mock `pg` with ESM, so we test the client via a
  // lightweight duck-typed approach: construct the client and use
  // Object.defineProperty to replace the private pool with a mock.

  let DbMigrationLiveClient: typeof import('../agent/db-migration/live-client.js').DbMigrationLiveClient;
  const mockQuery = vi.fn();
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  function createClient() {
    // pg.Pool constructor will try to connect on first query, not on construction.
    // We construct then swap the pool with our mock before any queries run.
    const client = Object.create(DbMigrationLiveClient.prototype) as InstanceType<typeof DbMigrationLiveClient>;
    Object.defineProperty(client, 'pool', { value: { query: mockQuery, end: mockEnd }, writable: true });
    Object.defineProperty(client, 'longQueryThresholdSec', { value: 30, writable: true });
    return client;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockQuery.mockReset();
    mockEnd.mockReset().mockResolvedValue(undefined);
    const mod = await import('../agent/db-migration/live-client.js');
    DbMigrationLiveClient = mod.DbMigrationLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements DbMigrationBackend interface', () => {
    const client = createClient();
    expect(typeof client.getMigrationStatus).toBe('function');
    expect(typeof client.getConnectionPoolStats).toBe('function');
    expect(typeof client.getActiveQueries).toBe('function');
    expect(typeof client.getTableLockInfo).toBe('function');
    expect(typeof client.getDatabaseSize).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = createClient();
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('db.query.read');
    expect(providers[1].capabilities).toContain('db.migration.rollback');
  });

  it('getMigrationStatus detects Prisma migrations', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        version: '20260315_001_add_users',
        name: '20260315_001_add_users',
        status: 'completed',
        started_at: '2026-03-15T10:00:00Z',
        error: null,
      }],
    });

    const client = createClient();
    const status = await client.getMigrationStatus();
    expect(status.version).toBe('20260315_001_add_users');
    expect(status.status).toBe('completed');
  });

  it('getMigrationStatus falls back to DDL detection', async () => {
    // Prisma fails
    mockQuery.mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));
    // Drizzle fails
    mockQuery.mockRejectedValueOnce(new Error('relation "__drizzle_migrations" does not exist'));
    // DDL detection returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const client = createClient();
    const status = await client.getMigrationStatus();
    expect(status.version).toBe('none');
    expect(status.status).toBe('completed');
  });

  it('getConnectionPoolStats queries pg_stat_activity', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ active: 15, idle: 30, waiting: 2, max_connections: 100 }],
    });

    const client = createClient();
    const stats = await client.getConnectionPoolStats();
    expect(stats.active).toBe(15);
    expect(stats.idle).toBe(30);
    expect(stats.maxConnections).toBe(100);
    expect(stats.utilizationPct).toBe(45);
  });

  it('getActiveQueries returns long-running queries', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        pid: 12001,
        query: 'CREATE INDEX CONCURRENTLY ...',
        duration_sec: 120,
        state: 'active',
        wait_event: 'Lock',
      }],
    });

    const client = createClient();
    const queries = await client.getActiveQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0].pid).toBe(12001);
    expect(queries[0].waitEvent).toBe('Lock');
  });

  it('getTableLockInfo returns blocking locks', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        relation: 'orders',
        lock_type: 'AccessExclusiveLock',
        granted: true,
        pid: 12001,
        query: 'CREATE INDEX ...',
      }],
    });

    const client = createClient();
    const locks = await client.getTableLockInfo();
    expect(locks).toHaveLength(1);
    expect(locks[0].relation).toBe('orders');
    expect(locks[0].granted).toBe(true);
  });

  it('getDatabaseSize queries pg_database_size', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_bytes: '107374182400', tablespace_free: '21474836480' }],
    });

    const client = createClient();
    const size = await client.getDatabaseSize();
    expect(size.totalBytes).toBe(107_374_182_400);
    expect(size.tablespaceFree).toBe(21_474_836_480);
  });

  it('evaluateCheck handles pg_isready', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ result: 1 }] });

    const client = createClient();
    const result = await client.evaluateCheck({
      type: 'sql',
      statement: 'SELECT 1',
      expect: { operator: 'eq', value: 1 },
    });
    expect(result).toBe(true);
  });

  it('close terminates pool', async () => {
    const client = createClient();
    await client.close();
    expect(mockEnd).toHaveBeenCalledOnce();
  });

  it('discoverVersion queries SHOW server_version', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ server_version: '16.2' }] });

    const client = createClient();
    const version = await client.discoverVersion!();
    expect(version).toBe('16.2');
  });
});

// ── Queue Backlog Live Client ──

describe('QueueLiveClient', () => {
  let QueueLiveClient: typeof import('../agent/queue-backlog/live-client.js').QueueLiveClient;

  const mockConfig = {
    redisUrl: 'redis://localhost:6379',
    queueNames: ['orders', 'notifications'],
    keyPrefix: 'bull',
    timeoutMs: 5_000,
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/queue-backlog/live-client.js');
    QueueLiveClient = mod.QueueLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements QueueBackend interface', () => {
    const client = new QueueLiveClient(mockConfig);
    expect(typeof client.getQueueStats).toBe('function');
    expect(typeof client.getWorkerStatus).toBe('function');
    expect(typeof client.getDeadLetterStats).toBe('function');
    expect(typeof client.getProcessingRate).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new QueueLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('queue.stats.read');
    expect(providers[1].capabilities).toContain('queue.pause');
  });

  it('rejects unsupported command types', async () => {
    const client = new QueueLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported queue live client command type');
  });

  it('transition is a no-op', () => {
    const client = new QueueLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });
});

// ── Config Drift Live Client ──

describe('ConfigDriftLiveClient', () => {
  let ConfigDriftLiveClient: typeof import('../agent/config-drift/live-client.js').ConfigDriftLiveClient;

  const mockConfig = {
    expectations: [
      { path: 'DATABASE_URL', expected: 'postgresql://localhost:5432/app', source: 'env' as const, masked: true },
      { path: 'LOG_LEVEL', expected: 'info', source: 'env' as const },
      { path: 'MISSING_VAR', expected: 'some-value', source: 'env' as const },
    ],
    secrets: [],
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../agent/config-drift/live-client.js');
    ConfigDriftLiveClient = mod.ConfigDriftLiveClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('implements ConfigDriftBackend interface', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    expect(typeof client.getEnvironmentVars).toBe('function');
    expect(typeof client.getSecretStatus).toBe('function');
    expect(typeof client.getConfigDiff).toBe('function');
    expect(typeof client.getRecentConfigChanges).toBe('function');
    expect(typeof client.executeCommand).toBe('function');
    expect(typeof client.evaluateCheck).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  it('lists capability providers with live_validated maturity', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    const providers = client.listCapabilityProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].maturity).toBe('live_validated');
    expect(providers[0].capabilities).toContain('config.env.read');
    expect(providers[1].capabilities).toContain('config.env.restore');
  });

  it('getEnvironmentVars reads from process.env', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const vars = await client.getEnvironmentVars();

    expect(vars).toHaveLength(3);
    expect(vars[0].name).toBe('DATABASE_URL');
    expect(vars[0].masked).toBe(true);
    // Masked values should not expose full content
    expect(vars[0].actual).toContain('***');

    expect(vars[1].name).toBe('LOG_LEVEL');
    expect(vars[1].actual).toBe('info');
    expect(vars[1].masked).toBe(false);

    expect(vars[2].name).toBe('MISSING_VAR');
    expect(vars[2].actual).toBeNull();

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
  });

  it('getConfigDiff detects mismatches', async () => {
    process.env.DATABASE_URL = 'postgresql://wrong-host:5432/app';
    process.env.LOG_LEVEL = 'info';
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const diffs = await client.getConfigDiff();

    // DATABASE_URL mismatch + MISSING_VAR not set
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    const dbDiff = diffs.find((d) => d.path === 'DATABASE_URL');
    expect(dbDiff).toBeDefined();

    const missingDiff = diffs.find((d) => d.path === 'MISSING_VAR');
    expect(missingDiff).toBeDefined();
    expect(missingDiff!.actual).toBe('<not set>');

    // LOG_LEVEL matches — should NOT be in diffs
    const logDiff = diffs.find((d) => d.path === 'LOG_LEVEL');
    expect(logDiff).toBeUndefined();

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
  });

  it('getConfigDiff returns empty when all aligned', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const diffs = await client.getConfigDiff();
    expect(diffs).toHaveLength(0);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('evaluateCheck handles config_drift_count', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'config_drift_count',
      expect: { operator: 'eq', value: 0 },
    });
    expect(result).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('evaluateCheck handles all_configs_aligned', async () => {
    process.env.DATABASE_URL = 'postgresql://wrong:5432/app';
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.evaluateCheck({
      type: 'api_call',
      statement: 'all_configs_aligned',
      expect: { operator: 'eq', value: 'false' },
    });
    expect(result).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
  });

  it('executeCommand scan_config returns full state', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'scan_config' }) as Record<string, unknown>;
    expect(result).toHaveProperty('envVars');
    expect(result).toHaveProperty('secrets');
    expect(result).toHaveProperty('configDiffs');
    expect(result).toHaveProperty('recentChanges');

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('executeCommand verify_alignment checks diffs', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/app';
    process.env.LOG_LEVEL = 'info';
    process.env.MISSING_VAR = 'some-value';

    const client = new ConfigDriftLiveClient(mockConfig);
    const result = await client.executeCommand({ type: 'api_call', operation: 'verify_alignment' }) as { aligned: boolean };
    expect(result.aligned).toBe(true);

    // Cleanup
    delete process.env.DATABASE_URL;
    delete process.env.LOG_LEVEL;
    delete process.env.MISSING_VAR;
  });

  it('rejects unsupported command types', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    await expect(client.executeCommand({ type: 'sql', operation: 'test' }))
      .rejects.toThrow('Unsupported config-drift live client command type');
  });

  it('getSecretStatus returns empty for no secrets', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    const secrets = await client.getSecretStatus();
    expect(secrets).toHaveLength(0);
  });

  it('transition is a no-op', () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    expect(() => client.transition('anything')).not.toThrow();
  });

  it('close is safe to call', async () => {
    const client = new ConfigDriftLiveClient(mockConfig);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
