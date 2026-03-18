#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// esbuild bundle config for CrisisMode standalone binary.
// Produces dist/crisismode.bundle.cjs — a self-contained CJS bundle for Node.js SEA.

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));

const result = await esbuild.build({
  entryPoints: [resolve(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: resolve(root, 'dist/crisismode.bundle.cjs'),

  define: {
    'process.env.__CRISISMODE_VERSION': JSON.stringify(pkg.version),
  },

  external: ['*.node'],

  plugins: [
    {
      name: 'suppress-optional-requires',
      setup(build) {
        build.onResolve({ filter: /^pg-native$/ }, () => ({
          path: 'pg-native',
          external: true,
        }));
      },
    },
  ],

  treeShaking: true,
  sourcemap: 'external',
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: false,
  logLevel: 'info',
});

if (result.errors.length > 0) {
  process.exit(1);
}
