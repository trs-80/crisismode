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

function configYaml(host: string): string {
  return [
    'apiVersion: crisismode/v1',
    'kind: SiteConfig',
    'metadata:',
    '  name: test-site',
    '  environment: development',
    'targets:',
    '  - name: test-kafka',
    '    kind: kafka',
    '    primary:',
    `      host: ${host}`,
    '      port: 9092',
    '',
  ].join('\n');
}

const CONFIG_YAML = configYaml('simulator');

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

  /**
   * The caller-level half of the "refuse to fabricate" contract.
   *
   * simulator-only-honest-failure.test.ts proves `createAgent` THROWS for a
   * real host. That only protects the operator if `checkTargetHealth`
   * (cli/commands/scan.ts) converts the throw into an honest finding — and
   * scan.test.ts covers that conversion with a hand-stubbed registry that
   * rejects, so it would stay green even if the refusal itself were deleted.
   *
   * This test wires the two halves together through the real stack: real
   * config file -> real AgentRegistry -> real kafka registration -> real
   * refusal -> real rendered finding. It fails if either half regresses:
   * remove the throw and the finding becomes fabricated `unhealthy`; break
   * scan's per-target catch and `runScan` rejects instead of returning.
   */
  it('renders a simulator-only agent pointed at a real host as an honest unknown finding', async () => {
    writeFileSync(configPath, configYaml('kafka-1.prod.internal'), 'utf-8');

    const result = await runScan({ configPath, category: ['kafka'] });

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;

    // 1. Honest status — not a verdict CrisisMode did not earn.
    expect(finding.status).toBe('unknown');
    expect(finding.confidence).toBe(0);

    // 2. The operator is told WHY, and which endpoint was refused.
    expect(finding.summary).toContain('No live client for kafka');
    expect(finding.summary).toContain('kafka-1.prod.internal:9092');

    // 3. Not a healthy result. `scan` has no exit-code contract on main
    //    today (cli/index.ts's `case 'scan'` sets no process.exitCode), so
    //    the score is the available non-healthy signal: `unknown` weighs 0.3
    //    in computeHealthScore, and this is the only finding. Tighten to
    //    ExitCode.INDETERMINATE (3) once PR #118 lands.
    expect(result.score).toBeLessThan(100);
    expect(result.findings.some((f) => f.status === 'healthy')).toBe(false);

    // 4. None of the simulator's invented telemetry reached the operator.
    //    These are the literals in agent/kafka/simulator.ts that the old
    //    unconditional-simulator path would have surfaced for this host.
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('10.0.1.10');
    expect(rendered).not.toContain('order-processor');
  });
});
