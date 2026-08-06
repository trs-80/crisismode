// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUnreachableFinding, reframeFindings } from '../cli/observer-reframe.js';
import { configure, printScanSummary, printTriageContext } from '../cli/output.js';
import type { ScanFinding, ScanResult } from '../cli/output.js';
import type { TriageReport } from '../framework/triage.js';
import { resetNetworkProfile } from '../framework/network-profile.js';
import { resetTriageReport } from '../framework/triage.js';

// The runScan wiring tests below exercise runScan for real. Autodiscovery
// reads the real filesystem and environment, and check-plugin discovery
// would find AND EXECUTE this repo's own ./checks/ plugins (live DNS lookups,
// curl to localhost). Both are stubbed so the scan under test never touches
// the network — mirrors src/__tests__/scan-run-best-effort.test.ts. The stub
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

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    id: 'PG-001',
    service: 'postgresql (main-pg)',
    status: 'unknown',
    summary: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    confidence: 0,
    escalationLevel: 2,
    signals: [],
    ...over,
  };
}

function reportWith(verdict: TriageReport['verdict']): TriageReport {
  return {
    verdict,
    explanation: 'explanation',
    nextStep: 'Fix this machine\'s DNS settings.',
    observerContext: 'laptop',
    observerContextEvidence: 'test fixture',
    escalationLevel: 2,
    checkedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 900,
    layers: [
      { layer: 'interfaces', status: 'pass', detail: 'en0', durationMs: 1 },
      { layer: 'dns', status: 'fail', code: 'resolver-broken', detail: 'system resolver failed', durationMs: 40 },
    ],
  };
}

describe('isUnreachableFinding', () => {
  it('matches a connection error on an unknown finding', () => {
    expect(isUnreachableFinding(finding())).toBe(true);
  });

  it('matches an unreachable signal on an unhealthy finding', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replica lag unknown',
      signals: [{ status: 'critical', detail: 'host unreachable: EHOSTUNREACH', source: 'pg_connection' }],
    }))).toBe(true);
  });

  it('does not match a healthy finding', () => {
    expect(isUnreachableFinding(finding({ status: 'healthy', summary: 'All good' }))).toBe(false);
  });

  it('does not match a degraded-but-reachable service', () => {
    expect(isUnreachableFinding(finding({
      status: 'unhealthy',
      summary: 'Replication lag is 45s and growing',
    }))).toBe(false);
  });

  // A service-level timeout is a real outage reported BY a reachable service.
  // Matching it here would collapse a genuine incident out of human output
  // whenever triage happened to blame the network.
  it('does not match service-level timeouts', () => {
    for (const summary of [
      'canceling statement due to statement_timeout',
      'ERROR: canceling statement due to lock_timeout',
      'BLPOP timed out after 30s',
      'Query timeout: 5 queries exceeded 30s',
    ]) {
      expect(isUnreachableFinding(finding({ status: 'unhealthy', summary }))).toBe(false);
    }
  });

  it('still matches an ETIMEDOUT errno, which is unambiguous', () => {
    expect(isUnreachableFinding(finding({
      summary: 'Error: connect ETIMEDOUT 10.0.0.5:5432',
    }))).toBe(true);
  });
});

describe('reframeFindings', () => {
  const unreachable = finding();
  const lagging = finding({ id: 'REDIS-001', status: 'unhealthy', summary: 'Memory usage at 95%' });

  it('leaves findings untouched when the verdict is healthy', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('healthy'));
    expect(result.reframe).toBeNull();
    expect(result.findings[0]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leaves findings untouched when the verdict is remote', () => {
    expect(reframeFindings([unreachable], reportWith('remote')).reframe).toBeNull();
  });

  it('flags only the unreachable findings when the verdict is local', () => {
    const result = reframeFindings([unreachable, lagging], reportWith('local'));
    expect(result.reframe).not.toBeNull();
    expect(result.reframe!.findingIds).toEqual(['PG-001']);
    expect(result.findings[0]!.possiblyObserverCaused).toBe(true);
    expect(result.findings[1]!.possiblyObserverCaused).toBeUndefined();
  });

  it('leads the headline with the count and the named cause', () => {
    const { reframe } = reframeFindings([unreachable], reportWith('network'));
    expect(reframe!.headline).toContain('1 service appears unreachable');
    expect(reframe!.headline).toContain('DNS resolver');
    expect(reframe!.headline).toContain('Fix that first.');
    expect(reframe!.nextStep).toBe('Fix this machine\'s DNS settings.');
  });

  it('pluralizes the headline for several findings', () => {
    const { reframe } = reframeFindings([unreachable, finding({ id: 'REDIS-002' })], reportWith('network'));
    expect(reframe!.headline).toContain('2 services appear unreachable');
  });

  it('returns no reframe when nothing looks unreachable', () => {
    expect(reframeFindings([lagging], reportWith('local')).reframe).toBeNull();
  });
});

describe('scan rendering with a reframe', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  const base: ScanResult = {
    score: 30,
    findings: [
      { ...finding(), possiblyObserverCaused: true },
      finding({ id: 'REDIS-001', status: 'unhealthy', summary: 'Memory usage at 95%' }),
    ],
    recentChanges: [],
    scannedAt: '2026-08-05T12:00:00.000Z',
    durationMs: 900,
  };

  const reframe = {
    verdict: 'network' as const,
    findingIds: ['PG-001'],
    cause: 'DNS is not resolving from this machine',
    headline: '1 service appears unreachable, but the likely cause is this machine\'s network (DNS is not resolving from this machine). Fix that first.',
    nextStep: 'Check the network you are on.',
  };

  it('leads with the reframe and collapses the attributed finding in human mode', () => {
    configure({ noColor: true, mode: 'human' });
    printScanSummary({ ...base, observerReframe: reframe });
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('1 service appears unreachable');
    expect(out).toContain('Check the network you are on.');
    // The reframed finding is collapsed, not listed with the real service problems.
    expect(out).not.toContain('connect ECONNREFUSED');
    // Findings triage cannot explain are still shown.
    expect(out).toContain('Memory usage at 95%');
  });

  it('keeps every finding and the triage report in machine mode', () => {
    configure({ json: true });
    printScanSummary({ ...base, observerReframe: reframe, triage: reportWith('network') });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(parsed.type).toBe('scan');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].possiblyObserverCaused).toBe(true);
    expect(parsed.observerReframe.findingIds).toEqual(['PG-001']);
    expect(parsed.triage.verdict).toBe('network');
  });

  it('lists findings normally when there is no reframe', () => {
    configure({ noColor: true, mode: 'human' });
    printScanSummary(base);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('connect ECONNREFUSED');
  });
});

describe('printTriageContext', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    configure({ noColor: true, mode: 'human' });
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  it('notes that triage passed for a healthy verdict', () => {
    printTriageContext(reportWith('healthy'));
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('triage passed');
  });

  it('says nothing when the verdict already produced a reframe', () => {
    printTriageContext(reportWith('network'));
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// The wiring test: unit tests cover reframeFindings and the renderers, but
// only this covers runScan's Promise.all -> reframe -> ScanResult path. The
// injected report keeps it off the network; findings still depend on what is
// running locally, so assertions are about relationships, not fixed values.
describe('runScan step 0 wiring', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Machine mode keeps the console quiet and the output structured.
    configure({ json: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // runScan calls generatePlainEnglishSummary, which makes a real Anthropic
    // API call when a key is present. A unit test must never do that.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
    configure({ json: false, noColor: false, verbose: false });
    resetNetworkProfile();
    resetTriageReport();
  });

  it('carries the injected triage report into the result and flags only unreachable findings', async () => {
    const { runScan } = await import('../cli/commands/scan.js');
    const injected = reportWith('network');

    const result = await runScan({ triageReport: injected });

    expect(result.triage).toBe(injected);
    // Every flagged finding is one isUnreachableFinding would have picked.
    for (const f of result.findings) {
      if (f.possiblyObserverCaused === true) expect(isUnreachableFinding(f)).toBe(true);
    }
    // And the reframe exists exactly when there was something to reframe.
    const hasUnreachable = result.findings.some(isUnreachableFinding);
    expect(result.observerReframe !== undefined).toBe(hasUnreachable);
    if (result.observerReframe) {
      expect(result.observerReframe.findingIds.length).toBeGreaterThan(0);
      expect(result.observerReframe.headline).toContain('Fix that first.');
    }
  }, 30_000);

  it('leaves findings unflagged when the injected verdict is healthy', async () => {
    const { runScan } = await import('../cli/commands/scan.js');

    const result = await runScan({ triageReport: reportWith('healthy') });

    expect(result.observerReframe).toBeUndefined();
    expect(result.findings.every((f) => f.possiblyObserverCaused === undefined)).toBe(true);
  }, 30_000);
});
