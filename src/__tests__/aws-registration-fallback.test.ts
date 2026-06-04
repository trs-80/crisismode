// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';

import { awsS3RecoveryRegistration } from '../agent/aws-s3/registration.js';
import { awsRdsRecoveryRegistration } from '../agent/aws-rds/registration.js';
import { awsDynamoDbRecoveryRegistration } from '../agent/aws-dynamodb/registration.js';
import type { ResolvedTarget } from '../config/schema.js';

function makeTarget(kind: string, aws: ResolvedTarget['aws']): ResolvedTarget {
  return {
    name: `test-${kind}`,
    kind,
    primary: { host: 'simulator', port: 0 },
    replicas: [],
    credentials: {},
    aws,
  };
}

const cases = [
  { name: 'aws-s3', registration: awsS3RecoveryRegistration, idField: 'bucket' as const },
  { name: 'aws-rds', registration: awsRdsRecoveryRegistration, idField: 'instanceId' as const },
  { name: 'aws-dynamodb', registration: awsDynamoDbRecoveryRegistration, idField: 'table' as const },
];

describe.each(cases)('$name registration — live-target safety', ({ name, registration, idField }) => {
  it('uses the simulator backend for region "simulator"', async () => {
    const target = makeTarget(name, { region: 'simulator' });
    const result = await registration.createAgent(target);
    expect(result.agent).toBeDefined();
    expect(result.backend).toBeDefined();
    expect(result.backend.constructor.name).toContain('Simulator');
  });

  it('throws (does not silently simulate) when a live target omits its identifier', async () => {
    const target = makeTarget(name, { region: 'us-east-1' });
    await expect(registration.createAgent(target)).rejects.toThrow(
      new RegExp(`aws\\.${idField} is missing`),
    );
  });

  it('constructs a live backend when region and identifier are both set', async () => {
    const target = makeTarget(name, { region: 'us-east-1', [idField]: 'real-resource' });
    const result = await registration.createAgent(target);
    expect(result.agent).toBeDefined();
    // The AWS live clients defer SDK I/O to query time, so construction itself
    // succeeds and yields the live (non-simulator) backend.
    expect(result.backend.constructor.name).toContain('LiveClient');
  });
});
