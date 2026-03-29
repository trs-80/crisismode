// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { awsDynamoDbRecoveryManifest } from './manifest.js';

export const awsDynamoDbRecoveryRegistration: AgentRegistration = {
  kind: 'aws-dynamodb',
  name: 'aws-dynamodb-recovery',
  manifest: awsDynamoDbRecoveryManifest,

  async createAgent(target) {
    const { AwsDynamoDbRecoveryAgent } = await import('./agent.js');
    const awsConfig = target.aws;
    const isLive = awsConfig && awsConfig.region !== 'simulator';

    if (isLive) {
      try {
        const { DynamoDbRecoveryLiveClient } = await import('./live-client.js');
        const backend = new DynamoDbRecoveryLiveClient({
          region: awsConfig.region,
          table: awsConfig.table!,
        });
        const agent = new AwsDynamoDbRecoveryAgent(backend);
        return { agent, backend, target };
      } catch { /* fall through to simulator */ }
    }

    const { DynamoDbRecoverySimulator } = await import('./simulator.js');
    const backend = new DynamoDbRecoverySimulator();
    const agent = new AwsDynamoDbRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
