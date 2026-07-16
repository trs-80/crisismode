// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Lint-time TypeScript pin.
 *
 * The build uses TypeScript 7 (native compiler), but typescript-eslint's
 * supported peer range is >=4.8.4 <6.1.0 and its typescript-estree crashes
 * against the TS 7 package's reduced JS API surface. Give the lint packages
 * their own TypeScript 6.0.2 (the newest supported release) as a hard
 * dependency so ESLint parses with a compiler it supports while tsc stays
 * on 7. Remove this file once typescript-eslint supports TypeScript 7.
 */

const LINT_TS_VERSION = '6.0.2';

function readPackage(pkg) {
  const wantsLintTs =
    pkg.name === 'ts-api-utils' ||
    pkg.name === 'typescript-eslint' ||
    (pkg.name && pkg.name.startsWith('@typescript-eslint/'));

  if (wantsLintTs && pkg.peerDependencies && pkg.peerDependencies.typescript) {
    delete pkg.peerDependencies.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: LINT_TS_VERSION };
  }

  return pkg;
}

module.exports = { hooks: { readPackage } };
