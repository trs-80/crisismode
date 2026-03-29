// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Tests that `crisismode recover --json` emits structured JSON lines
 * instead of human-formatted display output.
 *
 * Uses the AWS S3 simulator (no real AWS needed) to exercise the full
 * recover flow through live.ts with machine output mode enabled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Anthropic SDK (used by AI explainer)
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { configure, getOutputMode } from '../cli/output.js';

describe('recover --json output', () => {
  let tmpDir: string;
  let origCwd: string;
  let consoleOutput: string[];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `crisismode-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    origCwd = process.cwd();

    // Capture all console.log output
    consoleOutput = [];
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Configure machine output mode
    configure({ json: true });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits JSON lines for health, diagnosis, and plan in machine mode', async () => {
    // Write a config with an S3 target using the simulator region
    const configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, `
apiVersion: crisismode/v1
kind: SiteConfig
metadata:
  name: test
  environment: development
targets:
  - name: test-s3
    kind: aws-s3
    aws:
      region: simulator
      bucket: test-bucket
`);

    // Create the output directory for forensic records
    mkdirSync(join(tmpDir, 'output'), { recursive: true });
    process.chdir(tmpDir);

    const { runRecovery } = await import('../live.js');
    await runRecovery({
      configPath,
      targetName: 'test-s3',
      execute: false,
      healthOnly: false,
    });

    // Parse all JSON lines from output
    const jsonLines = consoleOutput
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);

    // Should have structured output types
    const types = jsonLines.map((l: Record<string, unknown>) => l.type);
    expect(types).toContain('health');
    expect(types).toContain('diagnosis');
    expect(types).toContain('plan');

    // Health assessment should be structured
    const health = jsonLines.find((l: Record<string, unknown>) => l.type === 'health');
    expect(health.assessment).toBeDefined();
    expect(health.assessment.status).toBeDefined();
    expect(health.assessment.signals).toBeInstanceOf(Array);

    // Diagnosis should be structured
    const diagnosis = jsonLines.find((l: Record<string, unknown>) => l.type === 'diagnosis');
    expect(diagnosis.diagnosis).toBeDefined();
    expect(diagnosis.diagnosis.scenario).toBeDefined();

    // Plan should be structured
    const plan = jsonLines.find((l: Record<string, unknown>) => l.type === 'plan');
    expect(plan.plan).toBeDefined();
    expect(plan.plan.steps).toBeInstanceOf(Array);

    // No human-readable display text (banner, phase headers, etc.)
    const humanLines = consoleOutput.filter((line) =>
      line.includes('CRISISMODE') ||
      line.includes('Phase ') ||
      line.includes('──────') ||
      line.includes('🔴 LIVE MODE'),
    );
    expect(humanLines).toHaveLength(0);
  });

  it('emits no human display text in machine mode for healthy targets', async () => {
    // Write a config with an S3 target using the simulator
    const configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, `
apiVersion: crisismode/v1
kind: SiteConfig
metadata:
  name: test
  environment: development
targets:
  - name: test-s3
    kind: aws-s3
    aws:
      region: simulator
      bucket: test-bucket
`);

    process.chdir(tmpDir);

    const { runRecovery } = await import('../live.js');
    await runRecovery({
      configPath,
      targetName: 'test-s3',
      execute: false,
      healthOnly: true,
    });

    // All output should be valid JSON or empty
    const nonJsonLines = consoleOutput.filter((line) =>
      line.trim().length > 0 && !line.trim().startsWith('{'),
    );
    expect(nonJsonLines).toHaveLength(0);
  });
});
