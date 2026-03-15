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
