// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Integration tests for built-in check plugins.
 *
 * Discovers every plugin in `checks/` and validates it against the check-plugin
 * contract using the test harness. This catches:
 *   - Scripts that crash silently (e.g. pipefail + grep no-match)
 *   - Missing or malformed JSON output
 *   - Missing required fields per verb (status, summary, confidence, etc.)
 *   - Exit codes outside [0,3]
 *   - Manifest/executable mismatches
 *
 * These tests run against the real check.sh scripts — no mocks.
 */

import { describe, it, expect } from 'vitest';
import { discoverCheckPlugins } from '../framework/check-discovery.js';
import { validateCheckPlugin } from '../framework/agent-test-harness.js';
import { join } from 'node:path';

// Discover plugins from the project's checks/ directory
const projectDir = join(import.meta.dirname, '..', '..');
const { plugins } = await discoverCheckPlugins({ projectDir });

describe('built-in check plugins', () => {
  // Ensure we actually found plugins — guards against discovery silently finding nothing
  it('discovers at least one plugin', () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    describe(plugin.manifest.name, () => {
      it('passes contract validation for all declared verbs', async () => {
        const result = await validateCheckPlugin(
          plugin.executablePath,
          plugin.manifest,
          { cwd: plugin.pluginDir },
        );

        // Build a readable failure message from individual check results
        const failures = result.checks
          .filter((c) => !c.passed)
          .map((c) => `  ${c.name}: ${c.message}`);

        expect(failures, `Contract violations:\n${failures.join('\n')}`).toHaveLength(0);
        expect(result.passed).toBe(true);
      });
    });
  }
});
