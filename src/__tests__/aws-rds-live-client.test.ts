// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStsSend = vi.fn();
const mockRdsSend = vi.fn();

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = mockStsSend; },
  GetCallerIdentityCommand: class { constructor(public params?: unknown) {} },
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: class { send = mockRdsSend; },
  DescribeDBInstancesCommand: class { constructor(public params?: unknown) {} },
  DescribeDBSnapshotsCommand: class { constructor(public params?: unknown) {} },
  DescribeEventsCommand: class { constructor(public params?: unknown) {} },
}));

import { RdsRecoveryLiveClient } from '../agent/aws-rds/live-client.js';

function makeClient(): RdsRecoveryLiveClient {
  return new RdsRecoveryLiveClient({ region: 'us-east-1', instanceId: 'prod-db-01' });
}

describe('RdsRecoveryLiveClient.validateCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports valid when STS GetCallerIdentity succeeds', async () => {
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    const client = makeClient();
    await expect(client.validateCredentials()).resolves.toEqual({ valid: true });
  });

  it('reports invalid with a reason when STS rejects', async () => {
    mockStsSend.mockRejectedValue(new Error('InvalidClientTokenId: The security token is invalid'));
    const client = makeClient();
    const result = await client.validateCredentials();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('InvalidClientTokenId');
  });
});

describe('RdsRecoveryLiveClient.executeCommand get_instance_health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to getInstanceHealth() and serializes real instance data', async () => {
    mockRdsSend.mockResolvedValueOnce({
      DBInstances: [{
        DBInstanceIdentifier: 'prod-db-01',
        DBInstanceStatus: 'available',
        Engine: 'postgres',
        EngineVersion: '15.4',
        DBInstanceClass: 'db.t3.micro',
        AllocatedStorage: 20,
        MultiAZ: false,
        Endpoint: { Port: 5432 },
        VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-123' }],
      }],
    });

    const client = makeClient();
    const result = await client.executeCommand({
      type: 'structured_command',
      operation: 'get_instance_health',
      parameters: { instanceId: 'prod-db-01' },
    });

    expect(result).toEqual({
      health: {
        instanceId: 'prod-db-01',
        status: 'available',
        engine: 'postgres',
        engineVersion: '15.4',
        instanceClass: 'db.t3.micro',
        allocatedStorageGb: 20,
        multiAz: false,
        pendingModifications: [],
        endpointPort: 5432,
        vpcSecurityGroupIds: ['sg-123'],
      },
    });
  });

  it('returns a PermissionMissing result rather than throwing when access is denied', async () => {
    mockRdsSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const client = makeClient();
    const result = await client.executeCommand({
      type: 'structured_command',
      operation: 'get_instance_health',
      parameters: { instanceId: 'prod-db-01' },
    });

    expect(result).toEqual({ health: { permissionMissing: 'rds:DescribeDBInstances' } });
  });
});

describe('RdsRecoveryLiveClient.getInstanceHealth instance-not-found handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rethrows DBInstanceNotFoundFault with a plain-language account/region hint', async () => {
    mockRdsSend.mockRejectedValue(Object.assign(new Error('not found'), { name: 'DBInstanceNotFoundFault' }));

    const client = makeClient();
    await expect(client.getInstanceHealth()).rejects.toThrow(/prod-db-01/);
    await expect(client.getInstanceHealth()).rejects.toThrow(/account\/region/i);
  });
});
