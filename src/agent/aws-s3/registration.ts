// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { awsS3RecoveryManifest } from './manifest.js';

export const awsS3RecoveryRegistration: AgentRegistration = {
  kind: 'aws-s3',
  name: 'aws-s3-recovery',
  manifest: awsS3RecoveryManifest,

  async createAgent(target) {
    const { AwsS3RecoveryAgent } = await import('./agent.js');
    const awsConfig = target.aws;
    const isLive = awsConfig && awsConfig.region !== 'simulator';

    if (isLive) {
      try {
        const { S3RecoveryLiveClient } = await import('./live-client.js');
        const backend = new S3RecoveryLiveClient({
          region: awsConfig.region,
          bucket: awsConfig.bucket!,
        });
        const agent = new AwsS3RecoveryAgent(backend);
        return { agent, backend, target };
      } catch {
        // Connection failed — fall back to simulator
      }
    }

    const { S3RecoverySimulator } = await import('./simulator.js');
    const backend = new S3RecoverySimulator();
    const agent = new AwsS3RecoveryAgent(backend);
    return { agent, backend, target };
  },
};
