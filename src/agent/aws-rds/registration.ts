// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { awsRdsRecoveryManifest } from './manifest.js';

export const awsRdsRecoveryRegistration: AgentRegistration = {
  kind: 'aws-rds',
  name: 'aws-rds-recovery',
  manifest: awsRdsRecoveryManifest,

  async createAgent(target) {
    const { AwsRdsRecoveryAgent } = await import('./agent.js');
    const awsConfig = target.aws;
    const isLive = awsConfig && awsConfig.region !== 'simulator';

    if (isLive) {
      try {
        const { RdsRecoveryLiveClient } = await import('./live-client.js');
        const backend = new RdsRecoveryLiveClient({
          region: awsConfig.region,
          instanceId: awsConfig.instanceId!,
        });
        const agent = new AwsRdsRecoveryAgent(backend);
        return { agent, backend, target };
      } catch {
        // SDK not installed or connection failed — fall back to simulator
      }
    }

    const { RdsRecoverySimulator } = await import('./simulator.js');
    const backend = new RdsRecoverySimulator();
    const agent = new AwsRdsRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
