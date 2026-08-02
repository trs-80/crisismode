// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  approxMaxConnections, summarizeSgRules, isAccessDeniedError, isInstanceNotFoundError,
} from '../agent/aws-rds/control-plane-helpers.js';

describe('approxMaxConnections', () => {
  it('derives the documented formula value for known postgres-family classes', () => {
    // db.t3.micro: 1 GiB → LEAST(1073741824/9531392, 5000) ≈ 112
    expect(approxMaxConnections('db.t3.micro', 'postgres')).toBe(112);
    // db.m5.large: 8 GiB → ≈ 901
    expect(approxMaxConnections('db.m5.large', 'postgres')).toBe(901);
  });
  it('treats aurora-postgresql and the simulator-style "postgresql" string as postgres-family', () => {
    expect(approxMaxConnections('db.t3.micro', 'aurora-postgresql')).toBe(112);
    expect(approxMaxConnections('db.t3.micro', 'postgresql')).toBe(112);
  });
  it('returns null for unknown classes', () => {
    expect(approxMaxConnections('db.z99.mega', 'postgres')).toBeNull();
  });
  it('returns null for non-postgres engines instead of applying the postgres formula', () => {
    // The postgres default_max_connections formula does not describe MySQL's
    // divisor — reporting a value would be a false saturation signal.
    expect(approxMaxConnections('db.t3.micro', 'mysql')).toBeNull();
    expect(approxMaxConnections('db.m5.large', 'mariadb')).toBeNull();
  });
});

describe('summarizeSgRules', () => {
  it('collects CIDRs and sg refs whose port range covers the DB port', () => {
    const out = summarizeSgRules(5432, [
      { FromPort: 5432, ToPort: 5432, IpProtocol: 'tcp', IpRanges: [{ CidrIp: '10.0.0.0/16' }] },
      { FromPort: 0, ToPort: 65535, IpProtocol: 'tcp', UserIdGroupPairs: [{ GroupId: 'sg-abc' }] },
      { FromPort: 443, ToPort: 443, IpProtocol: 'tcp', IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ]);
    expect(out).toContain('10.0.0.0/16');
    expect(out).toContain('sg-abc');
    expect(out).not.toContain('0.0.0.0/0');
  });
  it('treats IpProtocol -1 as all ports', () => {
    expect(summarizeSgRules(5432, [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]))
      .toEqual(['0.0.0.0/0']);
  });
  it('returns empty for no matching rules', () => {
    expect(summarizeSgRules(5432, [])).toEqual([]);
  });
  it('collects IPv6 CIDRs from an IPv6-only inbound rule instead of reporting no sources', () => {
    const out = summarizeSgRules(5432, [
      { FromPort: 5432, ToPort: 5432, IpProtocol: 'tcp', Ipv6Ranges: [{ CidrIpv6: '2001:db8::/32' }] },
    ]);
    expect(out).toEqual(['2001:db8::/32']);
  });
  it('collects both IPv4 and IPv6 sources on the same rule', () => {
    const out = summarizeSgRules(5432, [
      {
        FromPort: 5432,
        ToPort: 5432,
        IpProtocol: 'tcp',
        IpRanges: [{ CidrIp: '10.0.0.0/16' }],
        Ipv6Ranges: [{ CidrIpv6: '2001:db8::/32' }],
      },
    ]);
    expect(out).toContain('10.0.0.0/16');
    expect(out).toContain('2001:db8::/32');
  });
});

describe('isAccessDeniedError', () => {
  it('matches the AWS access-denied error family by name and message', () => {
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDeniedException' }))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'UnauthorizedOperation' }))).toBe(true);
    expect(isAccessDeniedError(new Error('User ... is not authorized to perform rds:DescribeDBInstances'))).toBe(true);
    expect(isAccessDeniedError(new Error('connect ETIMEDOUT'))).toBe(false);
  });
});

describe('isInstanceNotFoundError', () => {
  it('matches the RDS instance-not-found error family by name', () => {
    expect(isInstanceNotFoundError(Object.assign(new Error('x'), { name: 'DBInstanceNotFoundFault' }))).toBe(true);
    expect(isInstanceNotFoundError(Object.assign(new Error('x'), { name: 'DBInstanceNotFound' }))).toBe(true);
    expect(isInstanceNotFoundError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(false);
    expect(isInstanceNotFoundError(new Error('connect ETIMEDOUT'))).toBe(false);
    expect(isInstanceNotFoundError('not an error')).toBe(false);
  });
});
