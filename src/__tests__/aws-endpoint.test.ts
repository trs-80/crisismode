// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { parseRdsEndpoint } from '../cli/aws-endpoint.js';

describe('parseRdsEndpoint', () => {
  it('parses an instance endpoint into id + region', () => {
    expect(parseRdsEndpoint('mydb.c9akciq32rza.us-east-1.rds.amazonaws.com')).toEqual({
      type: 'instance',
      instanceId: 'mydb',
      region: 'us-east-1',
      host: 'mydb.c9akciq32rza.us-east-1.rds.amazonaws.com',
    });
  });

  it('handles mixed-case cluster endpoint', () => {
    const r = parseRdsEndpoint('MyDB.CLUSTER-abc123.US-EAST-1.rds.amazonaws.com');
    expect(r).toMatchObject({ type: 'cluster', region: 'us-east-1' });
    expect(r!.instanceId).toBeUndefined();
  });

  it('handles mixed-case proxy endpoint', () => {
    expect(parseRdsEndpoint('MyProxy.PROXY-abc123.EU-WEST-1.rds.amazonaws.com'))
      .toMatchObject({ type: 'proxy', region: 'eu-west-1' });
  });

  it('recognises a cluster-custom endpoint as cluster', () => {
    expect(parseRdsEndpoint('mydb.cluster-custom-c9akciq32rza.us-east-1.rds.amazonaws.com'))
      .toMatchObject({ type: 'cluster', region: 'us-east-1' });
  });

  it('recognises an Aurora cluster endpoint without an instanceId', () => {
    const r = parseRdsEndpoint('prod.cluster-c9akciq32rza.eu-west-2.rds.amazonaws.com');
    expect(r).toMatchObject({ type: 'cluster', region: 'eu-west-2' });
    expect(r!.instanceId).toBeUndefined();
  });

  it('recognises a cluster reader endpoint as cluster', () => {
    expect(parseRdsEndpoint('prod.cluster-ro-c9akciq32rza.us-west-2.rds.amazonaws.com'))
      .toMatchObject({ type: 'cluster', region: 'us-west-2' });
  });

  it('recognises an RDS Proxy endpoint', () => {
    expect(parseRdsEndpoint('myproxy.proxy-c9akciq32rza.us-east-2.rds.amazonaws.com'))
      .toMatchObject({ type: 'proxy', region: 'us-east-2' });
  });

  it('returns null for non-RDS hosts', () => {
    expect(parseRdsEndpoint('db.example.com')).toBeNull();
    expect(parseRdsEndpoint('localhost')).toBeNull();
    expect(parseRdsEndpoint('rds.amazonaws.com')).toBeNull();
    expect(parseRdsEndpoint('mydb.c9akciq32rza.us-east-1.rds.amazonaws.com.evil.com')).toBeNull();
  });

  it('handles gov/long region names', () => {
    expect(parseRdsEndpoint('x.abc123.us-gov-west-1.rds.amazonaws.com'))
      .toMatchObject({ type: 'instance', region: 'us-gov-west-1' });
  });
});
