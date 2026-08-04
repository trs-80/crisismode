// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTfState, discoverStateSource, WATCHABLE_TF_TYPES } from '../agent/iac-drift/state-parser.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

describe('parseTfState', () => {
  it('extracts managed aws_* resources with ids and regions', () => {
    const r = parseTfState(V4_STATE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resources).toHaveLength(5); // db, bucket, versioning, table, elasticache
    expect(r.resources[0]).toMatchObject({
      type: 'aws_db_instance', name: 'main', id: 'prod-db', region: 'us-east-1',
    });
    // s3 ARNs carry no region — region stays undefined, never guessed
    expect(r.resources.find((x) => x.type === 'aws_s3_bucket')!.region).toBeUndefined();
    expect(r.summary).toEqual({
      serial: 42, terraformVersion: '1.9.0',
      resourceCounts: {
        aws_db_instance: 1, aws_s3_bucket: 1, aws_s3_bucket_versioning: 1,
        aws_dynamodb_table: 1, aws_elasticache_cluster: 1,
      },
    });
  });

  it('excludes data-mode and non-aws resources', () => {
    const r = parseTfState(V4_STATE);
    if (!r.ok) throw new Error('expected ok');
    expect(r.resources.map((x) => x.type)).not.toContain('aws_caller_identity');
    expect(r.resources.map((x) => x.type)).not.toContain('random_pet');
  });

  it('rejects unknown format versions with a typed error', () => {
    const r = parseTfState(JSON.stringify({ version: 3, resources: [] }));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('version 3') });
  });

  it('rejects corrupt JSON without throwing', () => {
    const r = parseTfState('{not json');
    expect(r.ok).toBe(false);
  });
});

describe('discoverStateSource', () => {
  it('finds local terraform.tfstate at the project root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await writeFile(join(dir, 'terraform.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({ kind: 'local', path: join(dir, 'terraform.tfstate') });
  });

  it('follows the active non-default workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'environment'), 'staging');
    await mkdir(join(dir, 'terraform.tfstate.d', 'staging'), { recursive: true });
    await writeFile(join(dir, 'terraform.tfstate.d', 'staging', 'terraform.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({
      kind: 'local', path: join(dir, 'terraform.tfstate.d', 'staging', 'terraform.tfstate'),
    });
  });

  it('reads an s3 backend from .terraform/terraform.tfstate JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 's3', config: { bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'eu-west-1' } },
    }));
    expect(await discoverStateSource(dir)).toEqual({
      kind: 's3-backend', bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'eu-west-1',
    });
  });

  it('reports non-s3 backends as unsupported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 'remote', config: {} },
    }));
    expect(await discoverStateSource(dir)).toEqual({ kind: 'unsupported-backend', backendType: 'remote' });
  });

  it('resolves a local backend with a custom path from .terraform/terraform.tfstate JSON when the file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 'local', config: { path: 'state/custom.tfstate' } },
    }));
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'custom.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({ kind: 'local', path: join(dir, 'state', 'custom.tfstate') });
  });

  it('reports none (not unsupported-backend) when a configured local backend path does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await mkdir(join(dir, '.terraform'), { recursive: true });
    await writeFile(join(dir, '.terraform', 'terraform.tfstate'), JSON.stringify({
      backend: { type: 'local', config: { path: 'state/custom.tfstate' } },
    }));
    expect(await discoverStateSource(dir)).toEqual({ kind: 'none' });
  });

  it('falls back to scanning *.tf for a backend "s3" block when .terraform/ is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await writeFile(join(dir, 'main.tf'), [
      'terraform {',
      '  backend "s3" {',
      '    bucket = "tf-states"',
      '    key    = "app/terraform.tfstate"',
      '    region = "us-east-2"',
      '  }',
      '}',
    ].join('\n'));
    expect(await discoverStateSource(dir)).toEqual({
      kind: 's3-backend', bucket: 'tf-states', key: 'app/terraform.tfstate', region: 'us-east-2',
    });
  });

  it('falls back to scanning *.tf for a backend "local" block when .terraform/ is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    await writeFile(join(dir, 'main.tf'), [
      'terraform {',
      '  backend "local" {',
      '    path = "state/custom.tfstate"',
      '  }',
      '}',
    ].join('\n'));
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'custom.tfstate'), V4_STATE);
    expect(await discoverStateSource(dir)).toEqual({ kind: 'local', path: join(dir, 'state', 'custom.tfstate') });
  });

  it('returns none for a directory without terraform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-'));
    expect(await discoverStateSource(dir)).toEqual({ kind: 'none' });
  });
});

describe('WATCHABLE_TF_TYPES', () => {
  it('maps the deep trio to their agent kinds', () => {
    expect(WATCHABLE_TF_TYPES).toEqual({
      aws_db_instance: 'aws-rds',
      aws_s3_bucket: 'aws-s3',
      aws_dynamodb_table: 'aws-dynamodb',
    });
  });
});
