// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode init` scaffolds a *check plugin*, never a RecoveryAgent, so
 * `--plugin <name>` is the canonical flag. `--agent <name>` is kept working as a
 * deprecated alias for users who already scripted it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInit } from '../cli/commands/init.js';
import { configure } from '../cli/output.js';

const INDEX_SOURCE = readFileSync(fileURLToPath(new URL('../cli/index.ts', import.meta.url)), 'utf-8');
const SCAN_SOURCE = readFileSync(
  fileURLToPath(new URL('../cli/commands/scan.ts', import.meta.url)),
  'utf-8',
);
const COMPLETIONS_SOURCE = readFileSync(
  fileURLToPath(new URL('../cli/commands/completions.ts', import.meta.url)),
  'utf-8',
);

describe('crisismode init — plugin scaffolding flags', () => {
  let tmpDir: string;
  let origCwd: string;
  let stderr: string[];
  let stdout: string[];

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'crisismode-init-'));
    process.chdir(tmpDir);
    stderr = [];
    stdout = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    configure({ noColor: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function pluginFiles(name: string): { manifest: string; script: string } {
    return {
      manifest: join(tmpDir, 'checks', name, 'manifest.json'),
      script: join(tmpDir, 'checks', name, 'check.sh'),
    };
  }

  it('scaffolds a check plugin with the canonical --plugin flag', async () => {
    await runInit(undefined, { plugin: 'my-check' });

    const { manifest, script } = pluginFiles('my-check');
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(script)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, 'utf-8')).name).toBe('my-check');
    // Executable bit — the runner spawns check.sh directly.
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  it('prints no deprecation notice for --plugin', async () => {
    await runInit(undefined, { plugin: 'my-check' });
    expect(stderr.join('')).toBe('');
  });

  it('still scaffolds with the deprecated --agent alias', async () => {
    await runInit(undefined, { agent: 'legacy-check' });

    const { manifest, script } = pluginFiles('legacy-check');
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(script)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, 'utf-8')).name).toBe('legacy-check');
  });

  it('warns on --agent and points at --plugin', async () => {
    await runInit(undefined, { agent: 'legacy-check' });

    const notice = stderr.join('');
    expect(notice).toContain('--agent is deprecated');
    expect(notice).toContain('crisismode init --plugin legacy-check');
    // One line, not a paragraph.
    expect(notice.trimEnd().split('\n')).toHaveLength(1);
  });

  it('prefers --plugin over --agent when both are given, and says so', async () => {
    await runInit(undefined, { plugin: 'canonical', agent: 'legacy' });

    expect(existsSync(pluginFiles('canonical').manifest)).toBe(true);
    expect(existsSync(pluginFiles('legacy').manifest)).toBe(false);
    expect(stderr.join('')).toContain('scaffolding --plugin canonical and ignoring --agent legacy');
  });

  it('scaffolds once when both flags name the same plugin', async () => {
    await runInit(undefined, { plugin: 'same', agent: 'same' });

    expect(existsSync(pluginFiles('same').manifest)).toBe(true);
    expect(stderr.join('')).toContain('--agent is deprecated');
  });

  it('rejects a valueless --plugin with a usage error instead of scaffolding', async () => {
    // `strict: false` parses a bare `--plugin` as boolean true.
    await expect(runInit(undefined, { plugin: true })).rejects.toThrow(
      'crisismode init --plugin my-check',
    );
    expect(existsSync(join(tmpDir, 'checks'))).toBe(false);
    expect(existsSync(join(tmpDir, 'crisismode.yaml'))).toBe(false);
  });

  it('rejects a valueless --agent with a usage error', async () => {
    await expect(runInit(undefined, { agent: true })).rejects.toThrow(
      'crisismode init --agent my-check',
    );
    expect(existsSync(join(tmpDir, 'checks'))).toBe(false);
  });

  it('rejects a plugin name that would escape checks/', async () => {
    await expect(runInit(undefined, { plugin: '../../evil' })).rejects.toThrow('Invalid plugin name');
    expect(existsSync(join(tmpDir, 'checks'))).toBe(false);
  });

  it('still generates crisismode.yaml when neither flag is given', async () => {
    await runInit();

    expect(existsSync(join(tmpDir, 'crisismode.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, 'checks'))).toBe(false);
    expect(stderr.join('')).toBe('');
  });
});

describe('crisismode init — CLI flag registration', () => {
  // Mirrors the string-valued flags registered in src/cli/index.ts. Registration
  // matters: under `strict: false` an *unregistered* `--plugin foo` would be
  // parsed as a boolean and `foo` would fall through to the positional path
  // argument, silently writing a config file named "foo".
  const parseOpts = {
    options: {
      plugin: { type: 'string' as const },
      agent: { type: 'string' as const },
    },
    allowPositionals: true,
    strict: false,
  };

  it('parses --plugin as a string value, not a positional', () => {
    const { values, positionals } = parseArgs({ ...parseOpts, args: ['--plugin', 'my-check'] });
    expect(values.plugin).toBe('my-check');
    expect(positionals).toEqual([]);
  });

  it('parses the deprecated --agent as a string value', () => {
    const { values, positionals } = parseArgs({ ...parseOpts, args: ['--agent', 'legacy-check'] });
    expect(values.agent).toBe('legacy-check');
    expect(positionals).toEqual([]);
  });

  it('registers both flags in the real parseArgs config', () => {
    expect(INDEX_SOURCE).toContain('plugin: { type: \'string\' }');
    expect(INDEX_SOURCE).toContain('agent: { type: \'string\' }');
  });

  it('forwards both flags from the init route to runInit', () => {
    expect(INDEX_SOURCE).toContain('plugin: values.plugin as string | boolean | undefined');
    expect(INDEX_SOURCE).toContain('agent: values.agent as string | boolean | undefined');
  });
});

describe('crisismode init — documented surface matches the real one', () => {
  it('help text advertises --plugin for scaffolding', () => {
    expect(INDEX_SOURCE).toContain('crisismode init --plugin <name>');
    expect(INDEX_SOURCE).toMatch(/--plugin <name>\s+Scaffold a new check plugin \(init only\)/);
  });

  it('help text never describes --agent as the way to scaffold a plugin', () => {
    expect(INDEX_SOURCE).not.toContain('init --agent');
    expect(INDEX_SOURCE).not.toMatch(/--agent <name>\s+Scaffold/);
  });

  it('help text marks --agent as a deprecated alias', () => {
    expect(INDEX_SOURCE).toMatch(/--agent <name>\s+Deprecated alias for --plugin/);
  });

  it('the empty-plugin scan hint suggests the canonical flag', () => {
    expect(SCAN_SOURCE).toContain('crisismode init --plugin my-check');
    expect(SCAN_SOURCE).not.toContain('init --agent');
  });

  it('shell completions offer --plugin for init', () => {
    expect(COMPLETIONS_SOURCE).toContain('--plugin --json --no-color -h --help');
    expect(COMPLETIONS_SOURCE).toContain("'--plugin[Scaffold a new check plugin]:plugin name'");
    expect(COMPLETIONS_SOURCE).toContain(
      "__fish_seen_subcommand_from init' -l plugin -d 'Scaffold a new check plugin' -r",
    );
  });
});
