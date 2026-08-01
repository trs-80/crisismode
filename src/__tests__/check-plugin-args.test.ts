// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  interpolateCheckArgs,
  CheckArgInterpolationError,
  dispatchPluginExecution,
} from '../framework/check-plugin.js';
import type { CheckRequest, CheckTargetInfo } from '../framework/check-plugin.js';
import type { CheckHealthResult } from '../framework/check-plugin.js';

const target: CheckTargetInfo = {
  name: 'primary-db',
  kind: 'postgresql',
  host: 'db.example.test',
  port: 5432,
  metadata: { database: 'orders', sslmode: 'require' },
};

// ── interpolateCheckArgs ──

describe('interpolateCheckArgs', () => {
  it('substitutes {host} and {port} from the target', () => {
    expect(interpolateCheckArgs(['-H', '{host}', '-p', '{port}'], target)).toEqual([
      '-H', 'db.example.test', '-p', '5432',
    ]);
  });

  it('substitutes {name} and {kind}', () => {
    expect(interpolateCheckArgs(['{name}', '{kind}'], target)).toEqual([
      'primary-db', 'postgresql',
    ]);
  });

  it('substitutes {metadata.*} keys', () => {
    expect(interpolateCheckArgs(['--db={metadata.database}'], target)).toEqual([
      '--db=orders',
    ]);
  });

  it('substitutes multiple placeholders inside one argument', () => {
    expect(interpolateCheckArgs(['{host}:{port}'], target)).toEqual([
      'db.example.test:5432',
    ]);
  });

  it('passes literal arguments through untouched', () => {
    expect(interpolateCheckArgs(['-w', '80%', '-c', '90%'], target)).toEqual([
      '-w', '80%', '-c', '90%',
    ]);
  });

  it('throws when the target has no value for a placeholder', () => {
    const hostless: CheckTargetInfo = { name: 'x', kind: 'generic' };
    expect(() => interpolateCheckArgs(['-H', '{host}'], hostless)).toThrow(
      CheckArgInterpolationError,
    );
    expect(() => interpolateCheckArgs(['-H', '{host}'], hostless)).toThrow(/\{host\}/);
  });

  it('throws on a missing metadata key', () => {
    expect(() => interpolateCheckArgs(['{metadata.nope}'], target)).toThrow(
      CheckArgInterpolationError,
    );
  });

  it('throws on an unknown placeholder', () => {
    expect(() => interpolateCheckArgs(['{bogus}'], target)).toThrow(
      CheckArgInterpolationError,
    );
  });

  it('throws when a metadata value is not a primitive', () => {
    const t: CheckTargetInfo = { name: 'x', kind: 'generic', metadata: { obj: { a: 1 } } };
    expect(() => interpolateCheckArgs(['{metadata.obj}'], t)).toThrow(
      CheckArgInterpolationError,
    );
  });
});

// ── dispatch threads manifest args to format executors ──

describe('dispatchPluginExecution with manifest args', () => {
  let pluginDir: string | null = null;

  afterEach(async () => {
    if (pluginDir) {
      await rm(pluginDir, { recursive: true, force: true });
      pluginDir = null;
    }
  });

  async function writeArgvEcho(): Promise<string> {
    pluginDir = await mkdtemp(join(tmpdir(), 'crisismode-args-'));
    const path = join(pluginDir, 'check.sh');
    await writeFile(path, '#!/bin/sh\necho "OK args:$*|x=1"\nexit 0\n');
    await chmod(path, 0o755);
    return path;
  }

  const request: CheckRequest = { verb: 'health', target };

  it('interpolates and passes args to a nagios-format plugin', async () => {
    const executablePath = await writeArgvEcho();
    const res = await dispatchPluginExecution(
      { executablePath, manifest: { format: 'nagios', args: ['-H', '{host}', '-p', '{port}'] } },
      'health',
      undefined,
      request,
    );

    expect(res.exitStatus).toBe('ok');
    expect((res.result as CheckHealthResult).summary).toBe('OK args:-H db.example.test -p 5432');
  });

  it('interpolates and passes args to a sensu-format plugin', async () => {
    const executablePath = await writeArgvEcho();
    const res = await dispatchPluginExecution(
      { executablePath, manifest: { format: 'sensu', args: ['{host}'] } },
      'health',
      undefined,
      request,
    );

    expect(res.exitStatus).toBe('ok');
    expect((res.result as CheckHealthResult).summary).toBe('OK args:db.example.test');
  });

  it('returns unknown with a clear error when a placeholder cannot resolve', async () => {
    const executablePath = await writeArgvEcho();
    const hostless: CheckRequest = { verb: 'health', target: { name: 'x', kind: 'generic' } };
    const res = await dispatchPluginExecution(
      { executablePath, manifest: { format: 'nagios', args: ['-H', '{host}'] } },
      'health',
      undefined,
      hostless,
    );

    expect(res.exitStatus).toBe('unknown');
    expect(res.result).toBeNull();
    expect(res.stderr).toContain('{host}');
  });

  it('runs a nagios plugin with no args exactly as before', async () => {
    const executablePath = await writeArgvEcho();
    const res = await dispatchPluginExecution(
      { executablePath, manifest: { format: 'nagios' } },
      'health',
      undefined,
      request,
    );

    expect(res.exitStatus).toBe('ok');
    expect((res.result as CheckHealthResult).summary).toBe('OK args:');
  });
});
