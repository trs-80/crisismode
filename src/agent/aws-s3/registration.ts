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
      if (!awsConfig.bucket) {
        // A live target with no bucket is a misconfiguration. Fail loud rather
        // than silently simulating a recovery the operator believes ran against
        // the real bucket.
        throw new Error(
          `aws-s3 target "${target.name}" is set for live recovery (region "${awsConfig.region}") ` +
            `but aws.bucket is missing. Set aws.bucket, or use region "simulator" for the in-memory backend.`,
        );
      }
      try {
        const { S3RecoveryLiveClient } = await import('./live-client.js');
        const backend = new S3RecoveryLiveClient({
          region: awsConfig.region,
          bucket: awsConfig.bucket,
        });
        const agent = new AwsS3RecoveryAgent(backend);
        return { agent, backend, target };
      } catch (err) {
        // Only the dynamic import()/construction is guarded here; the live
        // client defers all S3 I/O to query time, so real connection/auth
        // failures surface later, not in this catch. Never swallow silently.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `aws-s3 live client initialization failed for target "${target.name}" (${message}). ` +
            `Falling back to the simulator — recovery actions will NOT run against the real bucket.`,
        );
      }
    }

    const { S3RecoverySimulator } = await import('./simulator.js');
    const backend = new S3RecoverySimulator();
    const agent = new AwsS3RecoveryAgent(backend);
    return { agent, backend, target };
  },
};
