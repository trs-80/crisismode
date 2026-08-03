// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIacDetection } from '../cli/autodiscovery.js';
import { V4_STATE } from './fixtures/iac-tfstate-v4.js';

describe('deriveIacDetection', () => {
  it('derives an iac-drift target when terraform files exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    await writeFile(join(dir, 'terraform.tfstate'), V4_STATE);
    const r = await deriveIacDetection(dir);
    expect(r.target).toMatchObject({ name: 'derived-iac-drift', kind: 'iac-drift', iac: { dir } });
    expect(r.note).toContain('Terraform');
    expect(r.iacDetection).toMatchObject({ stateSource: 'local' });
    expect(r.iacDetection!.unwatchableTypes).toEqual({ aws_elasticache_cluster: 1 });
  });

  it('derives a target from .tf files even without readable state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    await writeFile(join(dir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');
    const r = await deriveIacDetection(dir);
    expect(r.target).not.toBeNull();
    expect(r.iacDetection!.stateSource).toBe('none');
  });

  it('returns all-null for a project without terraform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iac-disc-'));
    const r = await deriveIacDetection(dir);
    expect(r).toEqual({ target: null, note: null, iacDetection: null });
  });
});
