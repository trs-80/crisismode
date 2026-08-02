// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  approxMaxConnections, summarizeSgRules, isAccessDeniedError,
} from '../agent/aws-rds/control-plane-helpers.js';

describe('approxMaxConnections', () => {
  it('derives the documented formula value for known classes', () => {
    // db.t3.micro: 1 GiB → LEAST(1073741824/9531392, 5000) ≈ 112
    expect(approxMaxConnections('db.t3.micro')).toBe(112);
    // db.m5.large: 8 GiB → ≈ 901
    expect(approxMaxConnections('db.m5.large')).toBe(901);
  });
  it('returns null for unknown classes', () => {
    expect(approxMaxConnections('db.z99.mega')).toBeNull();
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
