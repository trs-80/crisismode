// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  agentMaturity,
  buildMaturityByKind,
  bestEffortHint,
  BEST_EFFORT_GROUP_HINT,
  BEST_EFFORT_FINDING_SUFFIX,
} from '../framework/agent-maturity.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { AgentRegistry } from '../config/agent-registry.js';
import type { AgentManifest } from '../types/manifest.js';
import type { PluginMaturity } from '../types/plugin.js';
import type { SiteConfig } from '../config/schema.js';

/** The kinds whose agents have actually been run against real infrastructure. */
const LIVE_VALIDATED_KINDS = ['backup', 'disk', 'dns', 'kubernetes', 'llm-provider.anthropic', 'llm-provider.openai', 'postgresql', 'service-status', 'tls'];

const ALL_PLUGIN_MATURITIES: PluginMaturity[] = [
  'experimental',
  'simulator_only',
  'dry_run_only',
  'live_validated',
  'production_certified',
];

function manifestWith(maturity: PluginMaturity): AgentManifest {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'AgentManifest',
    metadata: {
      name: 'test-agent',
      version: '1.0.0',
      description: 'test',
      authors: ['test'],
      license: 'Apache-2.0',
      tags: [],
      plugin: { id: 'test.domain-pack', kind: 'domain_pack', maturity },
    },
    spec: {
      targetSystems: [],
      triggerConditions: [],
      failureScenarios: [],
      executionContexts: [],
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: { maxRiskLevel: 'routine', dataLossPossible: false, serviceDisruptionPossible: false },
      humanInteraction: { requiresApproval: true, minimumApprovalRole: 'on_call_engineer', escalationPath: [] },
    },
  };
}

const emptyConfig: SiteConfig = {
  apiVersion: 'crisismode/v1',
  kind: 'SiteConfig',
  metadata: { name: 'test-site', environment: 'development' },
  webhook: { port: 3000 },
  execution: { mode: 'dry-run' },
  targets: [],
};

describe('agentMaturity', () => {
  it('treats only live_validated as live-validated', () => {
    expect(agentMaturity(manifestWith('live_validated'))).toBe('live_validated');
  });

  it.each(ALL_PLUGIN_MATURITIES.filter((m) => m !== 'live_validated'))(
    'treats %s as best-effort (simulator_only)',
    (maturity) => {
      expect(agentMaturity(manifestWith(maturity))).toBe('simulator_only');
    },
  );
});

describe('buildMaturityByKind', () => {
  it('maps each kind to its maturity', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
      { kind: 'kafka', manifest: manifestWith('simulator_only') },
    ]);
    expect(map.get('postgresql')).toBe('live_validated');
    expect(map.get('kafka')).toBe('simulator_only');
  });

  it('leaves an unregistered kind absent, so callers apply the best-effort default', () => {
    const map = buildMaturityByKind([{ kind: 'postgresql', manifest: manifestWith('live_validated') }]);
    expect(map.has('mongodb')).toBe(false);
  });

  it('downgrades a kind to best-effort when any agent registered for it is unvalidated', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
      { kind: 'postgresql', manifest: manifestWith('simulator_only') },
    ]);
    expect(map.get('postgresql')).toBe('simulator_only');
  });

  it('downgrades regardless of registration order', () => {
    const map = buildMaturityByKind([
      { kind: 'postgresql', manifest: manifestWith('simulator_only') },
      { kind: 'postgresql', manifest: manifestWith('live_validated') },
    ]);
    expect(map.get('postgresql')).toBe('simulator_only');
  });
});

describe('honesty hint copy', () => {
  it('names the system in the per-system hint', () => {
    expect(bestEffortHint('kafka')).toBe(
      'checks exist but have never been validated against a real kafka; treat findings as leads, not conclusions.',
    );
  });

  it('frames group and finding hints as leads, not conclusions', () => {
    expect(BEST_EFFORT_GROUP_HINT).toContain('leads, not conclusions');
    expect(BEST_EFFORT_FINDING_SUFFIX).toContain('lead, not a conclusion');
  });
});

describe('maturity enforcement across built-in agents', () => {
  it('every registered agent manifest declares a maturity value', () => {
    for (const registration of builtinAgents) {
      expect(
        registration.manifest.metadata.plugin?.maturity,
        `agent '${registration.name}' declares no metadata.plugin.maturity`,
      ).toBeDefined();
      expect(ALL_PLUGIN_MATURITIES).toContain(registration.manifest.metadata.plugin.maturity);
    }
  });

  it('exactly the known-validated kinds are live-validated', () => {
    const map = buildMaturityByKind(
      builtinAgents.map((r) => ({ kind: r.kind, manifest: r.manifest })),
    );
    const live = [...map.entries()]
      .filter(([, maturity]) => maturity === 'live_validated')
      .map(([kind]) => kind)
      .sort();
    expect(live).toEqual(LIVE_VALIDATED_KINDS);
  });
});

describe('AgentRegistry.maturityByKind', () => {
  it('reports maturity for every registered kind', () => {
    const map = new AgentRegistry(emptyConfig).maturityByKind();
    expect(map.get('postgresql')).toBe('live_validated');
    expect(map.get('kafka')).toBe('simulator_only');
    expect(map.get('iac-drift')).toBe('simulator_only');
    expect(map.has('mongodb')).toBe(false);
  });
});
