// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Sandboxing guarantees for third-party check plugins.
 *
 * Check plugins are executables installed from a remote registry. Two things
 * follow from that: they must not inherit the operator's secrets, and they
 * must not be able to exhaust the spoke's memory (256Mi target) by writing
 * without bound to stdout.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCheckPlugin, executeNagiosPlugin } from '../framework/check-plugin.js';
import type { CheckRequest } from '../framework/check-plugin.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writePlugin(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crisismode-plugin-test-'));
  dirs.push(dir);
  const path = join(dir, 'check.sh');
  await writeFile(path, body, 'utf-8');
  await chmod(path, 0o755);
  return path;
}

const REQUEST: CheckRequest = {
  verb: 'health',
  target: { name: 'probe', kind: 'postgresql' },
};

describe('check plugin environment isolation', () => {
  it('does not leak the parent process secrets to the plugin', async () => {
    // A plugin that reports back whether it can see the operator's secrets.
    const path = await writePlugin(
      `#!/bin/sh
cat > /dev/null
printf '{"status":"healthy","summary":"env probe","confidence":1,"sawApiKey":"%s","sawPgPassword":"%s","sawPath":"%s"}' \\
  "$ANTHROPIC_API_KEY" "$PGPASSWORD" "$([ -n "$PATH" ] && echo yes)"
exit 0
`,
    );

    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
    process.env.PGPASSWORD = 'hunter2-must-not-leak';
    try {
      const res = await executeCheckPlugin(path, REQUEST);
      const result = res.result as unknown as Record<string, string>;

      expect(result.sawApiKey).toBe('');
      expect(result.sawPgPassword).toBe('');
      // PATH must survive — plugins shell out to curl, openssl, etc.
      expect(result.sawPath).toBe('yes');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.PGPASSWORD;
    }
  });

  it('still passes through env explicitly supplied by the caller', async () => {
    const path = await writePlugin(
      `#!/bin/sh
cat > /dev/null
printf '{"status":"healthy","summary":"env probe","confidence":1,"explicit":"%s"}' "$CRISISMODE_EXPLICIT"
exit 0
`,
    );

    const res = await executeCheckPlugin(path, REQUEST, {
      env: { CRISISMODE_EXPLICIT: 'provided-by-caller' },
    });
    const result = res.result as unknown as Record<string, string>;

    expect(result.explicit).toBe('provided-by-caller');
  });

  it('withholds secrets from nagios-format plugins too', async () => {
    const path = await writePlugin(
      `#!/bin/sh
echo "OK - apikey=[$ANTHROPIC_API_KEY]"
exit 0
`,
    );

    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
    try {
      const res = await executeNagiosPlugin(path, 'health');
      expect(JSON.stringify(res)).not.toContain('sk-ant-must-not-leak');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('check plugin output limits', () => {
  it('caps runaway stdout instead of buffering it without bound', async () => {
    // 32 MB of stdout — far past any legitimate check result, and enough to
    // matter against the 256Mi spoke footprint.
    const path = await writePlugin(
      `#!/bin/sh
cat > /dev/null
head -c 33554432 /dev/zero | tr '\\0' 'x'
exit 0
`,
    );

    const res = await executeCheckPlugin(path, REQUEST, { timeoutMs: 30_000 });

    expect(res.exitStatus).toBe('unknown');
    expect(res.stderr).toMatch(/output limit/i);
    // The captured stderr must not itself embed the runaway payload.
    expect(res.stderr.length).toBeLessThan(64 * 1024);
  }, 40_000);

  it('caps runaway stderr as well', async () => {
    const path = await writePlugin(
      `#!/bin/sh
cat > /dev/null
head -c 33554432 /dev/zero | tr '\\0' 'x' >&2
printf '{"status":"healthy","summary":"noisy","confidence":1}'
exit 0
`,
    );

    const res = await executeCheckPlugin(path, REQUEST, { timeoutMs: 30_000 });

    expect(res.stderr.length).toBeLessThan(2 * 1024 * 1024);
  }, 40_000);

  it('leaves normal-sized plugin output untouched', async () => {
    const path = await writePlugin(
      `#!/bin/sh
cat > /dev/null
printf '{"status":"healthy","summary":"all good","confidence":0.9}'
exit 0
`,
    );

    const res = await executeCheckPlugin(path, REQUEST);

    expect(res.exitStatus).toBe('ok');
    expect(res.result).toEqual({ status: 'healthy', summary: 'all good', confidence: 0.9 });
    expect(res.stderr).toBe('');
  });
});
