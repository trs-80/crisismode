// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/demo/**',
        'src/index.ts',
        'src/live.ts',
        'src/webhook.ts',
        'src/init.ts',
      ],
    },
  },
});
