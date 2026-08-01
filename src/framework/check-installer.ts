// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Check plugin installer — downloads, verifies, and installs check plugins.
 *
 * Supports two source types:
 * - `builtin`: downloads individual files from raw GitHub URLs
 * - `community`: downloads a tarball and extracts it
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { CheckRegistryEntry } from '../config/check-registry.js';
import { fetchBuffer } from '../config/check-registry.js';

// ── Types ──

export interface InstallOptions {
  /** Install to ./checks/ instead of ~/.crisismode/checks/ */
  local?: boolean;
  /** Overwrite existing installation */
  force?: boolean;
}

export interface InstallResult {
  name: string;
  version: string;
  installedTo: string;
  filesWritten: string[];
}

// ── Constants ──

const USER_CHECKS_DIR = join(homedir(), '.crisismode', 'checks');
const LOCAL_CHECKS_DIR = resolve('checks');

// ── Public API ──

/** Get the default install directory based on options. */
export function getInstallDir(options?: InstallOptions): string {
  return options?.local ? LOCAL_CHECKS_DIR : USER_CHECKS_DIR;
}

/** Check if a plugin is already installed at a given location. */
export function getInstalledVersion(name: string, searchDirs?: string[]): string | null {
  const dirs = searchDirs ?? [USER_CHECKS_DIR, LOCAL_CHECKS_DIR];
  for (const dir of dirs) {
    const manifestPath = join(dir, name, 'manifest.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return manifest.version ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Reject plugin filenames that are anything other than plain basenames.
 *
 * `entry.files` arrives from the registry index — off the machine — and each
 * name is joined onto the staging directory and written before any checksum
 * is verified. A name containing `..`, a separator, or an absolute path would
 * therefore write outside the staging area, and verifying integrity afterwards
 * cannot undo a write that already landed. Plugin layouts are flat
 * (manifest.json + the executable), so basenames are the whole legitimate
 * surface.
 */
export function assertSafePluginFiles(files: string[]): void {
  for (const name of files) {
    const unsafe =
      !name ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      isAbsolute(name) ||
      basename(name) !== name;

    if (unsafe) {
      throw new Error(
        `Unsafe plugin filename ${JSON.stringify(name)} in registry entry — ` +
          `files must be plain basenames with no path separators or traversal.`,
      );
    }
  }
}

/** Install a check plugin from the registry. */
export async function installCheck(
  entry: CheckRegistryEntry,
  options?: InstallOptions,
): Promise<InstallResult> {
  // Validate before anything is fetched or written: the write is the damage.
  if (entry.files) {
    assertSafePluginFiles(entry.files);
  }

  const baseDir = getInstallDir(options);
  const destDir = join(baseDir, entry.name);

  // Check if already installed
  if (existsSync(destDir) && !options?.force) {
    const installed = getInstalledVersion(entry.name, [baseDir]);
    if (installed === entry.version) {
      throw new Error(`${entry.name}@${entry.version} is already installed at ${destDir}. Use --force to reinstall.`);
    }
  }

  // Download to temp directory first (atomic install)
  const tempDir = join(tmpdir(), `crisismode-install-${entry.name}-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    let filesWritten: string[];

    if (entry.source === 'builtin' && entry.files) {
      filesWritten = await downloadBuiltinFiles(entry, tempDir);

      // Verify the downloaded file set. Tarball entries are deliberately not
      // re-verified here: downloadAndExtractTarball has already checked
      // entry.sha256 against the archive bytes, and that same value cannot
      // also equal a digest over the extracted files.
      verifyChecksum(
        tempDir,
        filesWritten,
        entry.sha256v2 !== undefined
          ? { sha256: entry.sha256, sha256v2: entry.sha256v2 }
          : { sha256: entry.sha256 },
      );
    } else {
      filesWritten = await downloadAndExtractTarball(entry, tempDir);
    }

    // Ensure parent directory exists
    mkdirSync(baseDir, { recursive: true });

    // Atomic move: remove existing, rename temp to final
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true });
    }
    renameSync(tempDir, destDir);

    // Set executable permissions on the check script
    setExecutablePermissions(destDir);

    return {
      name: entry.name,
      version: entry.version,
      installedTo: destDir,
      filesWritten: filesWritten.map((f) => join(destDir, f)),
    };
  } catch (err) {
    // Clean up temp directory on failure
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
    throw err;
  }
}

// ── Internal helpers ──

async function downloadBuiltinFiles(entry: CheckRegistryEntry, destDir: string): Promise<string[]> {
  const files = entry.files ?? [];
  const written: string[] = [];

  for (const filename of files) {
    const url = entry.url.endsWith('/') ? `${entry.url}${filename}` : `${entry.url}/${filename}`;
    const data = await fetchBuffer(url);
    writeFileSync(join(destDir, filename), data);
    written.push(filename);
  }

  return written;
}

async function downloadAndExtractTarball(entry: CheckRegistryEntry, destDir: string): Promise<string[]> {
  const data = await fetchBuffer(entry.url);

  // Verify tarball checksum
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.name}: expected ${entry.sha256}, got ${hash}`);
  }

  // Extract tarball
  const tarballPath = join(destDir, 'download.tar.gz');
  writeFileSync(tarballPath, data);
  // --no-same-owner: never let archive-declared ownership survive extraction
  // (matters when the spoke runs as root in a container). tar refuses `..`
  // members by default, which covers traversal inside the archive itself.
  execFileSync('tar', [
    'xzf',
    tarballPath,
    '-C',
    destDir,
    '--strip-components=1',
    '--no-same-owner',
  ]);
  rmSync(tarballPath);

  // List extracted files
  const { readdirSync } = await import('node:fs');
  return readdirSync(destDir);
}

/**
 * Compute the integrity digest for a set of plugin files.
 *
 * The digest is a sha256 over a SHA256SUMS-style manifest: one
 * `<sha256>  <name>\n` line per file, sorted by name. That construction binds
 * three things the previous concatenation could not:
 *
 *   - **Names.** Renaming a file changes the digest.
 *   - **Boundaries.** Contents are represented by fixed-width hashes, so bytes
 *     cannot be shifted between files. Concatenating raw contents meant
 *     {"xy","z"} and {"x","yz"} hashed identically.
 *   - **Presence.** A missing file is an error, not a silent skip, so a
 *     partial download can no longer verify successfully.
 *
 * The format is deliberately reproducible with standard tools:
 *   `sha256sum check.sh manifest.json | LC_ALL=C sort | sha256sum`
 */
export function computeChecksum(dir: string, files: string[]): string {
  const manifest = [...files]
    .sort()
    .map((file) => {
      const filePath = join(dir, file);
      if (!existsSync(filePath)) {
        throw new Error(`Cannot compute checksum: file is missing from ${dir}: ${file}`);
      }
      const fileHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      return `${fileHash}  ${file}\n`;
    })
    .join('');

  return createHash('sha256').update(manifest, 'utf-8').digest('hex');
}

/**
 * The pre-v2 digest: contents of the sorted file list, concatenated.
 *
 * Retained because CrisisMode binaries already in the wild compute this and
 * compare against the registry's `sha256`. Keeping the field correct is what
 * lets those clients keep installing checks while `sha256v2` rolls out.
 *
 * It is weak by construction — no delimiters, so bytes can be shifted between
 * files invisibly, and filenames are not covered. Prefer computeChecksum().
 * The one behaviour that did change: a missing file is now an error rather
 * than a silent skip, which does not alter the digest of a complete file set.
 */
export function computeLegacyChecksum(dir: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const filePath = join(dir, file);
    if (!existsSync(filePath)) {
      throw new Error(`Cannot compute checksum: file is missing from ${dir}: ${file}`);
    }
    hash.update(readFileSync(filePath));
  }
  return hash.digest('hex');
}

/** The digests a registry entry can carry. */
export interface ExpectedChecksums {
  /** Legacy digest — concatenated contents. Always present. */
  sha256: string;
  /** Manifest-bound digest. Preferred when present. */
  sha256v2?: string;
}

/**
 * Verify installed files against the registry's digests.
 *
 * `sha256v2` is preferred and, when present, is the only value consulted —
 * falling back to the weaker digest after a v2 mismatch would let an attacker
 * choose which check to face. Entries without a v2 (older or third-party
 * indexes) still verify against the legacy digest.
 */
export function verifyChecksum(dir: string, files: string[], expected: ExpectedChecksums): void {
  const useV2 = expected.sha256v2 !== undefined;
  const target = useV2 ? expected.sha256v2! : expected.sha256;

  let computed: string;
  try {
    computed = useV2 ? computeChecksum(dir, files) : computeLegacyChecksum(dir, files);
  } catch (err) {
    throw new Error(
      `Checksum verification failed for files in ${dir}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (computed !== target) {
    throw new Error(
      `Checksum verification failed for files in ${dir}:\n` +
      `  Expected: ${target} (${useV2 ? 'sha256v2' : 'sha256'})\n` +
      `  Computed: ${computed}\n` +
      `Files may have been tampered with or the registry is outdated.`,
    );
  }
}

function setExecutablePermissions(dir: string): void {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
    const executable = manifest.executable as string | undefined;
    if (executable) {
      const execPath = resolve(dir, executable);
      if (existsSync(execPath)) {
        chmodSync(execPath, 0o755);
      }
    }
  } catch {
    // Best effort — if manifest is missing or malformed, skip
  }
}
