// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Integrity checking for installed check plugins.
 *
 * The digest is what stands between a downloaded plugin and being marked
 * executable, so it has to actually bind the file set: which names, which
 * contents, and that every promised file arrived.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeChecksum,
  computeLegacyChecksum,
  verifyChecksum,
} from '../framework/check-installer.js';
import { loadLocalRegistry } from '../config/check-registry.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crisismode-checksum-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe('computeChecksum', () => {
  it('binds content to filenames', () => {
    // Same bytes overall, different distribution across the same file names.
    // A digest over concatenated contents cannot tell these apart.
    const a = stage({ 'check.sh': 'xy', 'manifest.json': 'z' });
    const b = stage({ 'check.sh': 'x', 'manifest.json': 'yz' });

    expect(computeChecksum(a, ['check.sh', 'manifest.json'])).not.toBe(
      computeChecksum(b, ['check.sh', 'manifest.json']),
    );
  });

  it('changes when a file is renamed but contents are identical', () => {
    const a = stage({ 'check.sh': 'same', 'manifest.json': 'body' });
    const b = stage({ 'run.sh': 'same', 'manifest.json': 'body' });

    expect(computeChecksum(a, ['check.sh', 'manifest.json'])).not.toBe(
      computeChecksum(b, ['manifest.json', 'run.sh']),
    );
  });

  it('is stable regardless of the order files are listed in', () => {
    const dir = stage({ 'check.sh': 'body', 'manifest.json': '{}' });

    expect(computeChecksum(dir, ['check.sh', 'manifest.json'])).toBe(
      computeChecksum(dir, ['manifest.json', 'check.sh']),
    );
  });

  it('refuses to hash a file that is missing rather than skipping it', () => {
    const dir = stage({ 'check.sh': 'body' });

    expect(() => computeChecksum(dir, ['check.sh', 'manifest.json'])).toThrow(
      /missing|not found/i,
    );
  });
});

describe('computeLegacyChecksum', () => {
  it('reproduces the historical construction: sorted contents, concatenated', () => {
    // "xy" + "z" === "xyz"; sha256("xyz") is a published vector.
    const dir = stage({ 'check.sh': 'xy', 'manifest.json': 'z' });

    expect(computeLegacyChecksum(dir, ['check.sh', 'manifest.json'])).toBe(
      '3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282',
    );
  });

  it('still collides across file boundaries — the reason v2 exists', () => {
    const a = stage({ 'check.sh': 'xy', 'manifest.json': 'z' });
    const b = stage({ 'check.sh': 'x', 'manifest.json': 'yz' });

    expect(computeLegacyChecksum(a, ['check.sh', 'manifest.json'])).toBe(
      computeLegacyChecksum(b, ['check.sh', 'manifest.json']),
    );
  });

  it('no longer skips a missing file, even on the legacy path', () => {
    const dir = stage({ 'check.sh': 'body' });

    expect(() => computeLegacyChecksum(dir, ['check.sh', 'manifest.json'])).toThrow(
      /missing|not found/i,
    );
  });
});

describe('verifyChecksum dual-field transition', () => {
  it('prefers sha256v2 when the entry carries one', () => {
    const dir = stage({ 'check.sh': 'body', 'manifest.json': '{}' });
    const files = ['check.sh', 'manifest.json'];

    expect(() =>
      verifyChecksum(dir, files, {
        sha256: 'deadbeef'.repeat(8), // wrong legacy value must not be consulted
        sha256v2: computeChecksum(dir, files),
      }),
    ).not.toThrow();
  });

  it('rejects a bad sha256v2 even when the legacy digest is correct', () => {
    const dir = stage({ 'check.sh': 'body', 'manifest.json': '{}' });
    const files = ['check.sh', 'manifest.json'];

    expect(() =>
      verifyChecksum(dir, files, {
        sha256: computeLegacyChecksum(dir, files),
        sha256v2: 'deadbeef'.repeat(8),
      }),
    ).toThrow();
  });

  it('falls back to the legacy digest when no sha256v2 is present', () => {
    const dir = stage({ 'check.sh': 'body', 'manifest.json': '{}' });
    const files = ['check.sh', 'manifest.json'];

    expect(() =>
      verifyChecksum(dir, files, { sha256: computeLegacyChecksum(dir, files) }),
    ).not.toThrow();
  });

  it('fails when a promised file never arrived', () => {
    const dir = stage({ 'check.sh': 'body' });

    expect(() =>
      verifyChecksum(dir, ['check.sh', 'manifest.json'], { sha256: 'a'.repeat(64) }),
    ).toThrow();
  });

  it('rejects tampered content', () => {
    const dir = stage({ 'check.sh': 'body', 'manifest.json': '{}' });
    const files = ['check.sh', 'manifest.json'];
    const expected = { sha256: computeLegacyChecksum(dir, files), sha256v2: computeChecksum(dir, files) };
    writeFileSync(join(dir, 'check.sh'), 'tampered');

    expect(() => verifyChecksum(dir, files, expected)).toThrow();
  });
});

describe('bundled registry integrity', () => {
  it('every builtin entry sha256 matches the files shipped in checks/', () => {
    const registry = loadLocalRegistry();
    const builtin = registry.checks.filter((c) => c.source === 'builtin' && c.files);
    expect(builtin.length).toBeGreaterThan(0);

    const stale: string[] = [];
    for (const entry of builtin) {
      const dir = join(process.cwd(), 'checks', entry.name);
      if (!existsSync(dir)) {
        stale.push(`${entry.name}: checks/${entry.name}/ does not exist`);
        continue;
      }

      // Both fields must track the files: sha256v2 for current clients, and
      // sha256 for v0.8.0 binaries still computing the legacy construction.
      const legacy = computeLegacyChecksum(dir, entry.files!);
      if (legacy !== entry.sha256) {
        stale.push(`${entry.name}: sha256 is ${entry.sha256}, files hash to ${legacy}`);
      }

      if (!entry.sha256v2) {
        stale.push(`${entry.name}: missing sha256v2`);
        continue;
      }
      const v2 = computeChecksum(dir, entry.files!);
      if (v2 !== entry.sha256v2) {
        stale.push(`${entry.name}: sha256v2 is ${entry.sha256v2}, files hash to ${v2}`);
      }
    }

    // Drift here means `crisismode registry install <name>` fails for real
    // users with "Files may have been tampered with or the registry is
    // outdated." Regenerate with: node scripts/compute-check-checksums.mjs --write
    expect(stale).toEqual([]);
  });

  it('registry files lists match what is on disk', () => {
    const registry = loadLocalRegistry();
    for (const entry of registry.checks) {
      if (entry.source !== 'builtin' || !entry.files) continue;
      for (const file of entry.files) {
        const path = join(process.cwd(), 'checks', entry.name, file);
        expect(existsSync(path), `${entry.name}/${file} listed in registry but absent`).toBe(true);
        expect(readFileSync(path).length).toBeGreaterThan(0);
      }
    }
  });
});
