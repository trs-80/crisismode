// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { deriveAwsRdsTargets } from '../cli/autodiscovery.js';
import type { EnvHint } from '../cli/autodiscovery.js';

const dbHint: EnvHint = { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' };

describe('deriveAwsRdsTargets', () => {
  it('derives an aws-rds target from an RDS instance endpoint when creds exist', () => {
    const env = { DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]).toMatchObject({
      kind: 'aws-rds',
      aws: { region: 'us-east-1', instanceId: 'mydb' },
    });
    expect(r.notes[r.targets[0]!.name]).toContain('DATABASE_URL');
  });

  it('records the host as uncredentialed instead when creds are absent', () => {
    const env = { DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, false);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.uncredentialedHosts).toEqual(['mydb.c9akciq32rza.us-east-1.rds.amazonaws.com']);
  });

  it('records Aurora cluster endpoints as unsupported, never as targets', () => {
    const env = { DATABASE_URL: 'postgres://u:p@prod.cluster-c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.unsupportedEndpoints).toEqual([
      { host: 'prod.cluster-c9akciq32rza.us-east-1.rds.amazonaws.com', type: 'cluster' },
    ]);
  });

  it('ignores non-RDS hosts entirely', () => {
    const env = { DATABASE_URL: 'postgres://u:p@localhost:5432/app' };
    const r = deriveAwsRdsTargets([dbHint], env, true);
    expect(r.targets).toHaveLength(0);
    expect(r.awsDetection.unsupportedEndpoints).toHaveLength(0);
    expect(r.awsDetection.uncredentialedHosts).toHaveLength(0);
  });

  it('dedupes multiple env vars pointing at the same instance', () => {
    const env = {
      DATABASE_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app',
      POSTGRES_URL: 'postgres://u:p@mydb.c9akciq32rza.us-east-1.rds.amazonaws.com:5432/app',
    };
    const pgHint: EnvHint = { name: 'POSTGRES_URL', present: true, kind: 'database_url', inferredService: 'postgresql' };
    const r = deriveAwsRdsTargets([dbHint, pgHint], env, true);
    expect(r.targets).toHaveLength(1);
  });
});
