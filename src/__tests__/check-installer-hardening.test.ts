// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Path-safety for the check plugin installer.
 *
 * `entry.files` comes from the registry index, i.e. from off the machine. The
 * installer joins each name onto its staging directory and writes the
 * downloaded bytes there — before any checksum has been verified. A name
 * containing `..` or an absolute path therefore writes wherever it likes, and
 * integrity checking cannot undo a write that already happened. Plugin files
 * are flat by design, so names must be plain basenames.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafePluginFiles, installCheck } from '../framework/check-installer.js';
import type { CheckRegistryEntry } from '../config/check-registry.js';

const escapeTarget = join(tmpdir(), 'crisismode-traversal-canary.txt');

afterEach(() => {
  rmSync(escapeTarget, { force: true });
});

function entryWithFiles(files: string[]): CheckRegistryEntry {
  return {
    name: 'evil-check',
    description: 'traversal probe',
    version: '1.0.0',
    targetKinds: ['postgresql'],
    verbs: ['health'],
    source: 'builtin',
    url: 'https://registry.invalid/evil-check',
    sha256: 'f'.repeat(64),
    files,
  };
}

describe('assertSafePluginFiles', () => {
  it('accepts plain basenames', () => {
    expect(() => assertSafePluginFiles(['manifest.json', 'check.sh'])).not.toThrow();
  });

  it('rejects parent-directory traversal', () => {
    expect(() => assertSafePluginFiles(['../../crisismode-traversal-canary.txt'])).toThrow(
      /unsafe|traversal|basename/i,
    );
  });

  it('rejects nested paths', () => {
    expect(() => assertSafePluginFiles(['sub/dir.txt'])).toThrow(/unsafe|traversal|basename/i);
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafePluginFiles(['/etc/crontab'])).toThrow(/unsafe|traversal|basename/i);
  });

  it('rejects backslash separators', () => {
    expect(() => assertSafePluginFiles(['..\\windows\\system32'])).toThrow(
      /unsafe|traversal|basename/i,
    );
  });

  it('rejects dot entries', () => {
    expect(() => assertSafePluginFiles(['..'])).toThrow(/unsafe|traversal|basename/i);
    expect(() => assertSafePluginFiles(['.'])).toThrow(/unsafe|traversal|basename/i);
  });

  it('rejects empty names', () => {
    expect(() => assertSafePluginFiles([''])).toThrow(/unsafe|traversal|basename/i);
  });
});

describe('installCheck path safety', () => {
  it('refuses a traversing entry and writes nothing outside the staging directory', async () => {
    const entry = entryWithFiles(['../../crisismode-traversal-canary.txt']);

    await expect(installCheck(entry, { local: false })).rejects.toThrow(
      /unsafe|traversal|basename/i,
    );

    // The decisive assertion: the escape target must not exist. Validation has
    // to happen before the download, since the write is what does the damage.
    expect(existsSync(escapeTarget)).toBe(false);
  }, 20_000);
});
