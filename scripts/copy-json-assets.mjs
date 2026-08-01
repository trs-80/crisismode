#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Mirror JSON assets from src/ into dist/.
 *
 * `tsc` type-checks imported JSON but never emits it, so a statically imported
 * index such as src/config/check-registry.json leaves dist/config/*.js with an
 * import that resolves to a file nobody wrote. esbuild and bun inline JSON, so
 * only the tsc output needs this.
 *
 * Runs as part of `pnpm build`. Exits non-zero if nothing was copied, since a
 * silent no-op here reappears later as a runtime ENOENT in a published package.
 */

import { readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'src');
const outDir = join(repoRoot, 'dist');

/** Every .json under src/, recursively, excluding tests. */
function findJson(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      found.push(...findJson(full));
    } else if (entry.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

if (!existsSync(outDir)) {
  console.error(`copy-json-assets: ${outDir} does not exist — run tsc first.`);
  process.exit(1);
}

const files = findJson(srcDir);
for (const file of files) {
  const target = join(outDir, relative(srcDir, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  console.log(`  ${relative(repoRoot, file)} -> ${relative(repoRoot, target)}`);
}

if (files.length === 0) {
  console.error('copy-json-assets: no JSON assets found under src/ — expected at least the check registry.');
  process.exit(1);
}

console.log(`copy-json-assets: copied ${files.length} file(s)`);
