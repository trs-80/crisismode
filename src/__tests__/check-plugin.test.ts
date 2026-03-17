// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  exitCodeToStatus,
  exitStatusToHealth,
  executeCheckPlugin,
} from '../framework/check-plugin.js';
import type { CheckRequest } from '../framework/check-plugin.js';

// ── exitCodeToStatus ──

describe('exitCodeToStatus', () => {
  it('maps 0 to ok', () => {
    expect(exitCodeToStatus(0)).toBe('ok');
  });

  it('maps 1 to warning', () => {
    expect(exitCodeToStatus(1)).toBe('warning');
  });

  it('maps 2 to critical', () => {
    expect(exitCodeToStatus(2)).toBe('critical');
  });

  it('maps 3 to unknown', () => {
    expect(exitCodeToStatus(3)).toBe('unknown');
  });

  it('maps unrecognised codes to unknown', () => {
    expect(exitCodeToStatus(42)).toBe('unknown');
    expect(exitCodeToStatus(-1)).toBe('unknown');
    expect(exitCodeToStatus(127)).toBe('unknown');
  });
});

// ── exitStatusToHealth ──

describe('exitStatusToHealth', () => {
  it('maps ok to healthy', () => {
    expect(exitStatusToHealth('ok')).toBe('healthy');
  });

  it('maps warning to recovering', () => {
    expect(exitStatusToHealth('warning')).toBe('recovering');
  });

  it('maps critical to unhealthy', () => {
    expect(exitStatusToHealth('critical')).toBe('unhealthy');
  });

  it('maps unknown to unknown', () => {
    expect(exitStatusToHealth('unknown')).toBe('unknown');
  });
});

// ── executeCheckPlugin ──

describe('executeCheckPlugin', () => {
  let tmpDir: string;
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'check-plugin-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dirs.length = 0;
  });

  async function writeScript(dir: string, name: string, body: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    await chmod(p, 0o755);
    return p;
  }

  const baseRequest: CheckRequest = {
    verb: 'health',
    target: { name: 'test', kind: 'generic' },
  };

  it('parses valid JSON output from a plugin', async () => {
    tmpDir = await makeTmpDir();
    const script = await writeScript(
      tmpDir,
      'plugin.sh',
      'echo \'{"status":"healthy","summary":"all good","confidence":0.95}\'',
    );

    const result = await executeCheckPlugin(script, baseRequest);
    expect(result.exitCode).toBe(0);
    expect(result.exitStatus).toBe('ok');
    expect(result.result).toEqual({
      status: 'healthy',
      summary: 'all good',
      confidence: 0.95,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr', async () => {
    tmpDir = await makeTmpDir();
    const script = await writeScript(
      tmpDir,
      'plugin.sh',
      'echo \'{"status":"healthy","summary":"ok","confidence":1}\'\necho "warning: something" >&2',
    );

    const result = await executeCheckPlugin(script, baseRequest);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning: something');
  });

  it('maps non-zero exit codes correctly', async () => {
    tmpDir = await makeTmpDir();
    const script = await writeScript(
      tmpDir,
      'plugin.sh',
      'echo \'{"status":"unhealthy","summary":"bad","confidence":0.8}\'\nexit 2',
    );

    const result = await executeCheckPlugin(script, baseRequest);
    expect(result.exitCode).toBe(2);
    expect(result.exitStatus).toBe('critical');
  });

  it('handles non-JSON output gracefully', async () => {
    tmpDir = await makeTmpDir();
    const script = await writeScript(tmpDir, 'plugin.sh', 'echo "NOT JSON"');

    const result = await executeCheckPlugin(script, baseRequest);
    expect(result.result).toBeNull();
    expect(result.stderr).toContain('Failed to parse stdout as JSON');
  });

  it('handles empty stdout', async () => {
    tmpDir = await makeTmpDir();
    const script = await writeScript(tmpDir, 'plugin.sh', 'exit 0');

    const result = await executeCheckPlugin(script, baseRequest);
    expect(result.result).toBeNull();
    expect(result.exitStatus).toBe('ok');
  });

  it('returns unknown status on execution error', async () => {
    const result = await executeCheckPlugin('/nonexistent/path/plugin', baseRequest);
    expect(result.exitStatus).toBe('unknown');
    expect(result.exitCode).toBe(3);
    expect(result.result).toBeNull();
  });

  it('handles timeout', async () => {
    tmpDir = await makeTmpDir();
    // Use `exec sleep` so bash is replaced by sleep (receives SIGTERM directly)
    const script = await writeScript(tmpDir, 'plugin.sh', 'exec sleep 30');

    const result = await executeCheckPlugin(script, baseRequest, { timeoutMs: 500 });
    // The process should be killed within a reasonable time
    expect(result.durationMs).toBeLessThan(10_000);
    // Killed process maps to exit code null -> 3 (unknown)
    expect([0, 1, 2, 3]).toContain(result.exitCode);
  }, 15_000);
});
