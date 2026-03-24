// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlaybooks } from '../framework/playbook/discovery.js';

describe('discoverPlaybooks', () => {
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'playbook-disc-test-'));
    dirs.push(d);
    return d;
  }

  /** Create a valid playbook .md file in the given directory. */
  async function createPlaybookFile(
    dir: string,
    filename: string,
    frontmatterOverrides: Record<string, unknown> = {},
  ): Promise<string> {
    const defaults = {
      name: filename.replace('.md', ''),
      version: '1.0.0',
      description: `Test playbook ${filename}`,
      ...frontmatterOverrides,
    };

    const yamlLines = Object.entries(defaults)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');

    const content = `---\n${yamlLines}\n---\n\nPlaybook body.\n`;
    const filePath = join(dir, filename);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
    delete process.env.CRISISMODE_PLAYBOOK_PATH;
  });

  it('discovers playbooks from project directory', async () => {
    const projectDir = await makeTmpDir();
    const playbooksDir = join(projectDir, 'playbooks');
    await mkdir(playbooksDir, { recursive: true });
    await createPlaybookFile(playbooksDir, 'fix-lag.md', {
      name: 'fix-lag',
      description: 'Fix replication lag',
    });

    const result = await discoverPlaybooks({ projectDir });

    const projectPlaybooks = result.playbooks.filter((p) => p.source === 'project');
    expect(projectPlaybooks.length).toBeGreaterThanOrEqual(1);

    const found = projectPlaybooks.find((p) => p.frontmatter.name === 'fix-lag');
    expect(found).toBeDefined();
    expect(found!.source).toBe('project');
    expect(found!.frontmatter.description).toBe('Fix replication lag');
  });

  it('reports warnings for invalid playbooks', async () => {
    const projectDir = await makeTmpDir();
    const playbooksDir = join(projectDir, 'playbooks');
    await mkdir(playbooksDir, { recursive: true });

    // Write a .md file with invalid frontmatter (missing required fields)
    await writeFile(
      join(playbooksDir, 'broken.md'),
      '---\nseverity: catastrophic\n---\n\nBody.\n',
      'utf-8',
    );

    const result = await discoverPlaybooks({ projectDir });

    const relevantWarnings = result.warnings.filter((w) => w.path.includes('broken.md'));
    expect(relevantWarnings.length).toBe(1);
    expect(relevantWarnings[0].reason).toContain('Invalid frontmatter');
  });

  it('ignores non-.md files', async () => {
    const projectDir = await makeTmpDir();
    const playbooksDir = join(projectDir, 'playbooks');
    await mkdir(playbooksDir, { recursive: true });

    await writeFile(
      join(playbooksDir, 'readme.txt'),
      '---\nname: should-not-load\nversion: "1.0.0"\ndescription: ignored\n---\n',
      'utf-8',
    );

    const result = await discoverPlaybooks({ projectDir });

    const projectPlaybooks = result.playbooks.filter((p) => p.source === 'project');
    expect(projectPlaybooks).toHaveLength(0);
  });

  it('returns empty result for a non-existent project directory', async () => {
    const result = await discoverPlaybooks({
      projectDir: '/tmp/nonexistent-crisismode-playbook-dir',
    });

    // Should not crash; playbooks may contain user-level entries but no project ones
    expect(result.playbooks).toBeDefined();
    expect(result.warnings).toBeDefined();
    const projectPlaybooks = result.playbooks.filter((p) => p.source === 'project');
    expect(projectPlaybooks).toHaveLength(0);
  });

  it('deduplicates by name — later source shadows earlier', async () => {
    const dir1 = await makeTmpDir();
    const dir2 = await makeTmpDir();

    const playbooksDir1 = join(dir1, 'playbooks');
    const playbooksDir2 = join(dir2, 'playbooks');
    await mkdir(playbooksDir1, { recursive: true });
    await mkdir(playbooksDir2, { recursive: true });

    await createPlaybookFile(playbooksDir1, 'dup.md', {
      name: 'dup-playbook',
      version: '1.0.0',
      description: 'first',
    });
    await createPlaybookFile(playbooksDir2, 'dup.md', {
      name: 'dup-playbook',
      version: '2.0.0',
      description: 'second',
    });

    process.env.CRISISMODE_PLAYBOOK_PATH = `${playbooksDir1}:${playbooksDir2}`;

    const result = await discoverPlaybooks({
      projectDir: '/tmp/nonexistent-crisismode-playbook-dir',
    });

    const envPlaybooks = result.playbooks.filter(
      (p) => p.source === 'env' && p.frontmatter.name === 'dup-playbook',
    );
    expect(envPlaybooks).toHaveLength(1);
    expect(envPlaybooks[0].frontmatter.version).toBe('2.0.0');
  });
});
