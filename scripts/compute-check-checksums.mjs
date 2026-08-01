#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Recompute the sha256 of every builtin entry in the check registry.
 *
 * The registry index pins a digest per plugin; editing anything under
 * `checks/` invalidates it, and a stale digest makes `crisismode registry
 * install <name>` fail with "Files may have been tampered with". Run this
 * whenever a bundled check changes.
 *
 *   node scripts/compute-check-checksums.mjs            # report drift
 *   node scripts/compute-check-checksums.mjs --write    # rewrite the index
 *
 * `src/__tests__/check-installer-checksum.test.ts` enforces this in CI, so
 * forgetting to run it fails the build rather than reaching users.
 *
 * Must stay in step with computeChecksum() in src/framework/check-installer.ts.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = join(repoRoot, 'src/config/check-registry.json');
const write = process.argv.includes('--write');

function read(dir, file) {
  const filePath = join(dir, file);
  if (!existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  return readFileSync(filePath);
}

/** sha256v2: sha256 over a SHA256SUMS-style manifest, sorted by filename. */
function computeChecksum(dir, files) {
  const manifest = [...files]
    .sort()
    .map((file) => `${createHash('sha256').update(read(dir, file)).digest('hex')}  ${file}\n`)
    .join('');

  return createHash('sha256').update(manifest, 'utf-8').digest('hex');
}

/** sha256 (legacy): contents of the sorted file list, concatenated. */
function computeLegacyChecksum(dir, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(read(dir, file));
  return hash.digest('hex');
}

const raw = readFileSync(registryPath, 'utf-8');
const registry = JSON.parse(raw);

const updates = [];
for (const entry of registry.checks) {
  if (entry.source !== 'builtin' || !entry.files) continue;

  const dir = join(repoRoot, 'checks', entry.name);
  const legacy = computeLegacyChecksum(dir, entry.files);
  const v2 = computeChecksum(dir, entry.files);

  if (legacy !== entry.sha256 || v2 !== entry.sha256v2) {
    console.log(`${entry.name}`);
    if (legacy !== entry.sha256) console.log(`  sha256   ${entry.sha256} -> ${legacy}`);
    if (v2 !== entry.sha256v2) console.log(`  sha256v2 ${entry.sha256v2 ?? '(absent)'} -> ${v2}`);
    updates.push({ name: entry.name, legacy, v2 });
  }
}

if (updates.length === 0) {
  console.log('All builtin check digests are current.');
  process.exit(0);
}

if (!write) {
  console.log(
    `\n${updates.length} entr${updates.length === 1 ? 'y' : 'ies'} out of date. Re-run with --write.`,
  );
  process.exit(1);
}

/**
 * Patch digests in place rather than re-serialising: the index uses compact
 * inline arrays that JSON.stringify would expand, burying a small change in a
 * 150-line reformat. Edits are anchored to each entry's unique "name" line so
 * two entries sharing a digest cannot be confused.
 */
let out = raw;
for (const { name, legacy, v2 } of updates) {
  const anchor = out.indexOf(`"name": "${name}"`);
  if (anchor === -1) {
    console.error(`Could not locate entry ${name} — aborting without writing.`);
    process.exit(1);
  }

  const shaStart = out.indexOf('"sha256":', anchor);
  if (shaStart === -1) {
    console.error(`Could not locate the sha256 line for ${name} — aborting without writing.`);
    process.exit(1);
  }

  // Span the sha256 line, plus an existing sha256v2 line if one follows, so
  // re-running replaces it rather than appending a duplicate key.
  let spanEnd = out.indexOf('\n', shaStart);
  const nextLineStart = spanEnd + 1;
  const nextLineEnd = out.indexOf('\n', nextLineStart);
  if (out.slice(nextLineStart, nextLineEnd).trimStart().startsWith('"sha256v2":')) {
    spanEnd = nextLineEnd;
  }

  const indent = ' '.repeat(shaStart - (out.lastIndexOf('\n', shaStart) + 1));
  const hadComma = out.slice(shaStart, spanEnd).trimEnd().endsWith(',');

  const replacement =
    `"sha256": "${legacy}",\n${indent}"sha256v2": "${v2}"${hadComma ? ',' : ''}`;

  out = out.slice(0, shaStart) + replacement + out.slice(spanEnd);
}

// Re-parse to be certain the surgical edit produced valid, equivalent JSON.
let patched;
try {
  patched = JSON.parse(out);
} catch (err) {
  console.error(`Patched index is not valid JSON — not writing. ${err.message}`);
  process.exit(1);
}
for (const { name, legacy, v2 } of updates) {
  const entry = patched.checks.find((c) => c.name === name);
  if (!entry || entry.sha256 !== legacy || entry.sha256v2 !== v2) {
    console.error(`Verification of the patched index failed for ${name} — not writing.`);
    process.exit(1);
  }
}

writeFileSync(registryPath, out, 'utf-8');
console.log(`\nUpdated ${updates.length} entr${updates.length === 1 ? 'y' : 'ies'} in ${registryPath}`);
