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
      if (!awsConfig.table) {
        // A live target with no table is a misconfiguration. Fail loud rather
        // than silently simulating a recovery the operator believes ran against
        // the real table.
        throw new Error(
          `aws-dynamodb target "${target.name}" is set for live recovery (region "${awsConfig.region}") ` +
            `but aws.table is missing. Set aws.table, or use region "simulator" for the in-memory backend.`,
        );
      }
      try {
        const { DynamoDbRecoveryLiveClient } = await import('./live-client.js');
        const backend = new DynamoDbRecoveryLiveClient({
          region: awsConfig.region,
          table: awsConfig.table,
        });
        const agent = new AwsDynamoDbRecoveryAgent(backend);
        return { agent, backend, target };
      } catch (err) {
        // Only the dynamic import()/construction is guarded here; the live
        // client defers all DynamoDB I/O to query time, so real connection/auth
        // failures surface later, not in this catch. Never swallow silently.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `aws-dynamodb live client initialization failed for target "${target.name}" (${message}). ` +
            `Falling back to the simulator — recovery actions will NOT run against the real table.`,
        );
      }
    }

    const { DynamoDbRecoverySimulator } = await import('./simulator.js');
    const backend = new DynamoDbRecoverySimulator();
    const agent = new AwsDynamoDbRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
