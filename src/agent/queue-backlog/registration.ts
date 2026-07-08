// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { queueBacklogManifest } from './manifest.js';

export const queueBacklogRegistration = createLiveRegistration({
  kind: 'message-queue',
  name: 'queue-backlog-recovery',
  manifest: queueBacklogManifest,
  loadAgent: async () => {
    const { QueueBacklogAgent } = await import('./agent.js');
    return QueueBacklogAgent as never;
  },
  loadSimulator: async () => {
    const { QueueSimulator } = await import('./simulator.js');
    return QueueSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { QueueLiveClient } = await import('./live-client.js');

    const scheme = target.queue?.tls ? 'rediss' : 'redis';
    const auth = target.credentials.password
      ? `${encodeURIComponent(target.credentials.username ?? 'default')}:${encodeURIComponent(target.credentials.password)}@`
      : '';
    const redisUrl = `${scheme}://${auth}${target.primary.host}:${target.primary.port}`;

    const client = new QueueLiveClient({
      redisUrl,
      queueNames: target.queue?.queueNames ?? [],
      keyPrefix: target.queue?.keyPrefix,
    });
    await client.connect();
    return client;
  },
});
