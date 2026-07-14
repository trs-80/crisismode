// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { tlsManifest } from './manifest.js';

export const tlsRecoveryRegistration = createLiveRegistration({
  kind: 'tls',
  name: 'tls-certificate-recovery',
  manifest: tlsManifest,
  loadAgent: async () => {
    const { TlsCertificateAgent } = await import('./agent.js');
    return TlsCertificateAgent as never;
  },
  loadSimulator: async () => {
    const { TlsSimulator } = await import('./simulator.js');
    return TlsSimulator as never;
  },
  buildLiveBackend: async (target) => {
    if (target.primary.host === 'default' || target.primary.host === '') {
      throw new Error(
        "tls target requires an endpoint host to inspect (e.g. host: example.com). Use host: 'simulator' for demo mode.",
      );
    }

    const { TlsLiveClient } = await import('./live-client.js');
    return new TlsLiveClient({
      endpoints: [{ host: target.primary.host, port: target.primary.port || 443 }],
      connectTimeoutMs: 5000,
    });
  },
});
