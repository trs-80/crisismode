// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CapabilityDefinition } from '../types/plugin.js';

const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: 'db.query.read',
    actionKind: 'read',
    description: 'Run read-only diagnostic queries against a database target.',
    targetKinds: ['postgresql', 'mysql', 'redis'],
    manualFallback: 'Query the target system directly with an approved read-only tool to confirm current state.',
  },
  {
    id: 'db.query.write',
    actionKind: 'mutate',
    description: 'Run write-capable database operations against a database target.',
    targetKinds: ['postgresql', 'mysql'],
    manualFallback: 'Use your approved database administration workflow to apply the required change manually.',
  },
  {
    id: 'db.replica.disconnect',
    actionKind: 'mutate',
    description: 'Detach or terminate replication connectivity for a lagging replica.',
    targetKinds: ['postgresql', 'mysql'],
    manualFallback: 'Disconnect the lagging replica from replication on the primary using your approved database administration workflow.',
  },
  {
    id: 'db.replica.reseed',
    actionKind: 'mutate',
    description: 'Re-seed a replica from a healthy source and re-establish replication.',
    targetKinds: ['postgresql', 'mysql'],
    manualFallback: 'Re-seed the affected replica from a healthy source using `pg_basebackup` or your platform replica rebuild workflow.',
  },
  {
    id: 'db.replication_slot.drop',
    actionKind: 'mutate',
    description: 'Drop an invalid or abandoned replication slot.',
    targetKinds: ['postgresql'],
    manualFallback: 'Drop the invalid replication slot manually with an approved PostgreSQL administration workflow.',
  },
  {
    id: 'db.replication_slot.create',
    actionKind: 'mutate',
    description: 'Create a replacement replication slot.',
    targetKinds: ['postgresql'],
    manualFallback: 'Create the replacement replication slot manually with an approved PostgreSQL administration workflow.',
  },
  {
    id: 'traffic.backend.detach',
    actionKind: 'mutate',
    description: 'Remove a backend from traffic serving rotation.',
    targetKinds: ['linux', 'load_balancer'],
    manualFallback: 'Remove the affected backend from read traffic using your load balancer, proxy, or service-routing control plane.',
  },
  {
    id: 'traffic.backend.attach',
    actionKind: 'mutate',
    description: 'Restore a backend to traffic serving rotation.',
    targetKinds: ['linux', 'load_balancer'],
    manualFallback: 'Return the repaired backend to read traffic only after direct health checks confirm it is healthy.',
  },
  {
    id: 'cache.client.disconnect',
    actionKind: 'mutate',
    description: 'Disconnect selected cache clients to relieve resource pressure.',
    targetKinds: ['redis'],
    manualFallback: 'Disconnect the targeted cache clients manually with your approved Redis administration workflow.',
  },
  {
    id: 'cache.expiry.trigger',
    actionKind: 'mutate',
    description: 'Trigger or accelerate key expiry to reclaim memory.',
    targetKinds: ['redis'],
    manualFallback: 'Trigger expiry manually with your approved Redis administration workflow or operational runbook.',
  },
  {
    id: 'cache.config.set',
    actionKind: 'mutate',
    description: 'Apply a cache runtime configuration change.',
    targetKinds: ['redis'],
    manualFallback: 'Apply the runtime configuration change manually with your approved Redis administration workflow.',
  },

  // ── Consensus (etcd) ──
  {
    id: 'consensus.member.remove',
    actionKind: 'mutate',
    description: 'Remove a member from an etcd cluster.',
    targetKinds: ['etcd'],
    manualFallback: 'Remove the member manually using `etcdctl member remove <ID>`.',
  },
  {
    id: 'consensus.member.add',
    actionKind: 'mutate',
    description: 'Add a new or recovered member to an etcd cluster.',
    targetKinds: ['etcd'],
    manualFallback: 'Add the member manually using `etcdctl member add <name> --peer-urls=<url>`.',
  },
  {
    id: 'consensus.defrag',
    actionKind: 'mutate',
    description: 'Defragment an etcd member to reclaim storage space.',
    targetKinds: ['etcd'],
    manualFallback: 'Run `etcdctl defrag --endpoints=<endpoint>` manually against the target member.',
  },
  {
    id: 'consensus.snapshot.restore',
    actionKind: 'mutate',
    description: 'Restore an etcd member from a snapshot.',
    targetKinds: ['etcd'],
    manualFallback: 'Restore from snapshot manually using `etcdctl snapshot restore <file>`.',
  },
  {
    id: 'consensus.alarm.disarm',
    actionKind: 'mutate',
    description: 'Disarm an etcd alarm (e.g. NOSPACE) after resolving the underlying issue.',
    targetKinds: ['etcd'],
    manualFallback: 'Disarm the alarm manually using `etcdctl alarm disarm`.',
  },

  // ── Broker (Kafka) ──
  {
    id: 'broker.partition.reassign',
    actionKind: 'mutate',
    description: 'Reassign partition replicas across Kafka brokers.',
    targetKinds: ['kafka'],
    manualFallback: 'Reassign partitions manually using `kafka-reassign-partitions.sh`.',
  },
  {
    id: 'broker.leader.elect',
    actionKind: 'mutate',
    description: 'Trigger preferred leader election for Kafka partitions.',
    targetKinds: ['kafka'],
    manualFallback: 'Trigger preferred leader election manually using `kafka-leader-election.sh`.',
  },
  {
    id: 'broker.config.set',
    actionKind: 'mutate',
    description: 'Apply a runtime configuration change to a Kafka broker.',
    targetKinds: ['kafka'],
    manualFallback: 'Apply the broker configuration change manually using `kafka-configs.sh`.',
  },
  {
    id: 'consumer.group.reset',
    actionKind: 'mutate',
    description: 'Reset consumer group offsets to recover from lag or corruption.',
    targetKinds: ['kafka'],
    manualFallback: 'Reset offsets manually using `kafka-consumer-groups.sh --reset-offsets`.',
  },

  // ── Kubernetes ──
  {
    id: 'k8s.node.cordon',
    actionKind: 'mutate',
    description: 'Cordon a Kubernetes node to prevent new pod scheduling.',
    targetKinds: ['kubernetes'],
    manualFallback: 'Cordon the node manually using `kubectl cordon <node>`.',
  },
  {
    id: 'k8s.node.drain',
    actionKind: 'mutate',
    description: 'Drain a Kubernetes node, evicting all pods gracefully.',
    targetKinds: ['kubernetes'],
    manualFallback: 'Drain the node manually using `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`.',
  },
  {
    id: 'k8s.pod.delete',
    actionKind: 'mutate',
    description: 'Delete a Kubernetes pod to trigger rescheduling.',
    targetKinds: ['kubernetes'],
    manualFallback: 'Delete the pod manually using `kubectl delete pod <name> -n <namespace>`.',
  },
  {
    id: 'k8s.deployment.restart',
    actionKind: 'mutate',
    description: 'Perform a rolling restart of a Kubernetes deployment.',
    targetKinds: ['kubernetes'],
    manualFallback: 'Restart the deployment manually using `kubectl rollout restart deployment/<name>`.',
  },
  {
    id: 'k8s.pvc.finalize',
    actionKind: 'mutate',
    description: 'Remove finalizers from a stuck PersistentVolumeClaim to allow deletion.',
    targetKinds: ['kubernetes'],
    manualFallback: 'Remove the finalizer manually using `kubectl patch pvc <name> -p \'{"metadata":{"finalizers":null}}\'`.',
  },

  // ── Storage (Ceph) ──
  {
    id: 'storage.osd.reweight',
    actionKind: 'mutate',
    description: 'Reweight a Ceph OSD to redistribute data.',
    targetKinds: ['ceph'],
    manualFallback: 'Reweight the OSD manually using `ceph osd reweight <id> <weight>`.',
  },
  {
    id: 'storage.osd.remove',
    actionKind: 'mutate',
    description: 'Mark a Ceph OSD out and remove it from the cluster.',
    targetKinds: ['ceph'],
    manualFallback: 'Remove the OSD manually using `ceph osd out <id> && ceph osd crush remove osd.<id>`.',
  },
  {
    id: 'storage.pg.repair',
    actionKind: 'mutate',
    description: 'Repair inconsistent Ceph placement groups.',
    targetKinds: ['ceph'],
    manualFallback: 'Repair PGs manually using `ceph pg repair <pgid>`.',
  },
  {
    id: 'storage.pool.quota.set',
    actionKind: 'mutate',
    description: 'Set or adjust a Ceph pool quota.',
    targetKinds: ['ceph'],
    manualFallback: 'Set the pool quota manually using `ceph osd pool set-quota <pool> max_bytes <value>`.',
  },

  // ── Stream (Flink) ──
  {
    id: 'stream.job.restart',
    actionKind: 'mutate',
    description: 'Restart a Flink job from the latest checkpoint or savepoint.',
    targetKinds: ['flink'],
    manualFallback: 'Restart the job manually via the Flink REST API or CLI.',
  },
  {
    id: 'stream.savepoint.trigger',
    actionKind: 'mutate',
    description: 'Trigger a savepoint for a running Flink job.',
    targetKinds: ['flink'],
    manualFallback: 'Trigger a savepoint manually using `flink savepoint <jobId>`.',
  },
  {
    id: 'stream.checkpoint.configure',
    actionKind: 'mutate',
    description: 'Adjust Flink checkpoint configuration (interval, timeout, min-pause).',
    targetKinds: ['flink'],
    manualFallback: 'Update checkpoint configuration in the Flink job configuration manually.',
  },
  {
    id: 'stream.taskmanager.release',
    actionKind: 'mutate',
    description: 'Release and decommission a Flink TaskManager.',
    targetKinds: ['flink'],
    manualFallback: 'Decommission the TaskManager manually via the Flink REST API.',
  },
];

const CAPABILITY_INDEX = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));

export function listCapabilities(): CapabilityDefinition[] {
  return CAPABILITIES;
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return CAPABILITY_INDEX.get(id);
}

export function isKnownCapability(id: string): boolean {
  return CAPABILITY_INDEX.has(id);
}
