// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCompletions } from '../cli/commands/completions.js';
import { ExitCode } from '../cli/exit-codes.js';

describe('Shell completions (6.2)', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  const originalWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  });

  it('generates bash completions', async () => {
    await runCompletions('bash');
    const output = stdoutChunks.join('');
    expect(output).toContain('_crisismode_completions');
    expect(output).toContain('complete -F _crisismode_completions crisismode');
    expect(output).toContain('scan');
    expect(output).toContain('diagnose');
    expect(output).toContain('recover');
    expect(output).toContain('watch');
    expect(output).toContain('completions');
  });

  it('generates zsh completions', async () => {
    await runCompletions('zsh');
    const output = stdoutChunks.join('');
    expect(output).toContain('#compdef crisismode');
    expect(output).toContain('_crisismode');
    expect(output).toContain('scan:Health scan');
    expect(output).toContain('--config');
  });

  it('generates fish completions', async () => {
    await runCompletions('fish');
    const output = stdoutChunks.join('');
    expect(output).toContain('complete -c crisismode');
    expect(output).toContain('__fish_use_subcommand');
    expect(output).toContain('scan');
    expect(output).toContain('interval');
  });

  it('rejects unsupported shell', async () => {
    // Was `process.exit(1)`. `completions` now returns the same USAGE code
    // `down --bogusflag` has always returned for the same class of mistake,
    // and index.ts is the only place a code becomes process.exitCode.
    const code = await runCompletions('powershell');
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('unsupported shell');
    expect(stderr).toContain('powershell');
    expect(code).toBe(ExitCode.USAGE);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('bash completions include all commands', async () => {
    await runCompletions('bash');
    const output = stdoutChunks.join('');
    const commands = ['scan', 'diagnose', 'recover', 'status', 'init', 'demo', 'webhook', 'ask', 'watch', 'completions'];
    for (const cmd of commands) {
      expect(output).toContain(cmd);
    }
  });

  it('bash completions include command-specific flags', async () => {
    await runCompletions('bash');
    const output = stdoutChunks.join('');
    expect(output).toContain('--category');
    expect(output).toContain('--execute');
    expect(output).toContain('--health-only');
    expect(output).toContain('--interval');
    expect(output).toContain('--plugin');
  });

  it('zsh completions include descriptions', async () => {
    await runCompletions('zsh');
    const output = stdoutChunks.join('');
    expect(output).toContain('Health scan with scored summary');
    expect(output).toContain('Continuous shadow observation');
    expect(output).toContain('Print shell completion script');
  });

  it('fish completions disable default file completion', async () => {
    await runCompletions('fish');
    const output = stdoutChunks.join('');
    expect(output).toContain('complete -c crisismode -f');
  });

  it('completes the triage command in every shell', async () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      stdoutChunks = [];
      await runCompletions(shell);
      expect(stdoutChunks.join('')).toContain('triage');
    }
  });
});
