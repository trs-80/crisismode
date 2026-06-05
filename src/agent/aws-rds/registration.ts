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
      if (!awsConfig.instanceId) {
        // A live target with no instanceId is a misconfiguration. Fail loud
        // rather than silently simulating a recovery the operator believes ran
        // against the real instance.
        throw new Error(
          `aws-rds target "${target.name}" is set for live recovery (region "${awsConfig.region}") ` +
            `but aws.instanceId is missing. Set aws.instanceId, or use region "simulator" for the in-memory backend.`,
        );
      }
      try {
        const { RdsRecoveryLiveClient } = await import('./live-client.js');
        const backend = new RdsRecoveryLiveClient({
          region: awsConfig.region,
          instanceId: awsConfig.instanceId,
        });
        const agent = new AwsRdsRecoveryAgent(backend);
        return { agent, backend, target };
      } catch (err) {
        // Only the dynamic import()/construction is guarded here; the live
        // client defers all RDS I/O to query time, so real connection/auth
        // failures surface later, not in this catch. Never swallow silently.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `aws-rds live client initialization failed for target "${target.name}" (${message}). ` +
            `Falling back to the simulator — recovery actions will NOT run against the real instance.`,
        );
      }
    }

    const { RdsRecoverySimulator } = await import('./simulator.js');
    const backend = new RdsRecoverySimulator();
    const agent = new AwsRdsRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
