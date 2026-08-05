// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Autodiscovery reads the real filesystem and environment, and check-plugin
// discovery would find AND EXECUTE this repo's own ./checks/ plugins. Both
// are stubbed so the scan under test is exactly one kafka target. The stub
// objects are built inside the factories because vi.mock is hoisted above
// module-level consts.
vi.mock('../cli/autodiscovery.js', () => ({
  discoverStack: vi.fn(async () => ({
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
  })),
  printOnboardingMessage: vi.fn(),
}));
vi.mock('../framework/check-discovery.js', () => ({
  discoverCheckPlugins: vi.fn(async () => ({ plugins: [], warnings: [] })),
}));

import { runScan } from '../cli/commands/scan.js';

const CONFIG_YAML = [
  'apiVersion: crisismode/v1',
  'kind: SiteConfig',
  'metadata:',
  '  name: test-site',
  '  environment: development',
  'targets:',
  '  - name: test-kafka',
  '    kind: kafka',
  '    primary:',
  '      host: simulator',
  '      port: 9092',
  '',
].join('\n');

describe('runScan — end-to-end best-effort marking', () => {
  let tmpDir: string;
  let configPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crisismode-scan-'));
    configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, CONFIG_YAML, 'utf-8');
    // Keep the plain-language summary on its offline fallback path.
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('marks a simulator-only agent findings best-effort and its visibility entry simulator_only', async () => {
    // kafka registers through createSimulatorRegistration, so this whole scan
    // runs in memory — no broker, no network. `category` narrows the run to
    // kafka, dropping the dns/disk local targets runScan always injects.
    const result = await runScan({ configPath, category: ['kafka'] });

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.service).toContain('kafka');
    expect(finding.bestEffort).toBe(true);

    const watching = result.visibility!.watching.find((e) => e.label === 'kafka');
    expect(watching).toBeDefined();
    expect(watching!.maturity).toBe('simulator_only');
  });
});
