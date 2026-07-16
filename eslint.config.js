// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'packages/agent-sdk/dist/',
      'eval/reports/',
      'site/',
      'scripts/',
      '.pnpm-store/',
    ],
  },
  js.configs.recommended,
  // Syntax-level rules only. The type-aware (recommendedTypeChecked) configs
  // need the TS compiler API, which typescript-eslint does not yet support on
  // the TypeScript 7 native compiler — revisit when the peer range includes 7.
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Match the codebase conventions established in the July 2026 audit.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ExportDefaultDeclaration",
          message: 'Use named exports (repo convention: no default exports).',
        },
      ],
    },
  },
  {
    files: ['src/__tests__/**/*.ts', 'test/**/*.ts'],
    rules: {
      // Tests assert on fixture-guaranteed data; a failed assertion is the
      // desired failure mode.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Tool configs and ambient declarations are required to default-export.
    files: ['*.config.{js,ts,mjs}', 'eslint.config.js', '**/*.d.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
