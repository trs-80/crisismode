// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { synthesizeVerdict } from '../framework/triage.js';
import type { TriageLayerCode, TriageLayerName, TriageLayerResult, TriageLayerStatus } from '../framework/triage.js';

function layer(
  name: TriageLayerName,
  status: TriageLayerStatus,
  code?: TriageLayerCode,
): TriageLayerResult {
  return { layer: name, status, detail: `${name}:${status}`, code, durationMs: 1 };
}

const allPass: TriageLayerResult[] = [
  layer('interfaces', 'pass'),
  layer('gateway', 'pass'),
  layer('dns', 'pass'),
  layer('captive-portal', 'pass'),
  layer('internet', 'pass'),
  layer('targets', 'pass'),
];

function withLayer(base: TriageLayerResult[], replacement: TriageLayerResult): TriageLayerResult[] {
  return base.map((l) => (l.layer === replacement.layer ? replacement : l));
}

describe('synthesizeVerdict', () => {
  it('returns healthy when every layer passes', () => {
    expect(synthesizeVerdict(allPass)).toBe('healthy');
  });

  it('returns healthy when only the gateway is unknown', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('gateway', 'unknown', 'gateway-unknown')))).toBe('healthy');
  });

  it('returns local when no interface has an address', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('interfaces', 'fail', 'no-active-interface')))).toBe('local');
  });

  it('returns local when the system resolver is broken but public resolvers answer', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('dns', 'fail', 'resolver-broken')))).toBe('local');
  });

  it('returns network when no resolver answers', () => {
    const layers = withLayer(withLayer(allPass, layer('dns', 'fail', 'dns-unreachable')), layer('targets', 'fail', 'targets-unreachable'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns network for a captive portal', () => {
    const layers = withLayer(withLayer(allPass, layer('captive-portal', 'fail', 'captive-portal')), layer('targets', 'skipped'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns network when the internet layer fails with no reachable target', () => {
    const layers = withLayer(withLayer(allPass, layer('internet', 'fail', 'internet-unreachable')), layer('targets', 'skipped'));
    expect(synthesizeVerdict(layers)).toBe('network');
  });

  it('returns mixed when a network layer fails but some target still answers', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('internet', 'fail', 'internet-unreachable')))).toBe('mixed');
  });

  it('returns remote when local and network layers pass but no target answers', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'fail', 'targets-unreachable')))).toBe('remote');
  });

  it('returns mixed when only some targets answer', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'fail', 'targets-partial')))).toBe('mixed');
  });

  it('returns mixed when a non-gateway layer could not be assessed', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('captive-portal', 'unknown')))).toBe('mixed');
  });

  it('returns healthy when targets were skipped and everything else passed', () => {
    expect(synthesizeVerdict(withLayer(allPass, layer('targets', 'skipped')))).toBe('healthy');
  });
});

import { explainVerdict, layerCauseLabel, primaryFailureCode } from '../framework/triage.js';

describe('primaryFailureCode', () => {
  it('returns the first failing layer code in probe order', () => {
    const layers = [
      layer('interfaces', 'pass'),
      layer('dns', 'fail', 'dns-unreachable'),
      layer('internet', 'fail', 'internet-unreachable'),
    ];
    expect(primaryFailureCode(layers)).toBe('dns-unreachable');
  });

  it('ignores the gateway layer, which is context only', () => {
    const layers = [layer('gateway', 'fail', 'gateway-unknown'), layer('dns', 'fail', 'dns-unreachable')];
    expect(primaryFailureCode(layers)).toBe('dns-unreachable');
  });

  it('returns null when nothing failed', () => {
    expect(primaryFailureCode([layer('interfaces', 'pass')])).toBeNull();
  });
});

describe('explainVerdict', () => {
  it('names the local cause and offers a machine-level next step', () => {
    const layers = [layer('interfaces', 'pass'), { ...layer('dns', 'fail', 'resolver-broken'), nextStep: 'Fix this machine DNS settings.' }];
    const { explanation, nextStep } = explainVerdict('local', layers);
    expect(explanation).toContain('this machine');
    expect(explanation).toContain(layerCauseLabel('resolver-broken'));
    expect(nextStep).toBe('Fix this machine DNS settings.');
  });

  it('names the network cause', () => {
    const layers = [layer('captive-portal', 'fail', 'captive-portal')];
    const { explanation } = explainVerdict('network', layers);
    expect(explanation).toContain(layerCauseLabel('captive-portal'));
  });

  it('points remote verdicts at scan', () => {
    const { explanation, nextStep } = explainVerdict('remote', [layer('targets', 'fail', 'targets-unreachable')]);
    expect(explanation).toContain('did not answer');
    expect(nextStep).toContain('crisismode scan');
  });

  it('refuses to localize a mixed verdict', () => {
    const { explanation } = explainVerdict('mixed', [layer('captive-portal', 'unknown')]);
    expect(explanation).toContain('cannot');
  });

  it('says nothing is wrong for healthy', () => {
    const { explanation, nextStep } = explainVerdict('healthy', [layer('interfaces', 'pass')]);
    expect(explanation).toContain('look fine');
    expect(nextStep).toContain('crisismode scan');
  });

  it('has a label for every layer code', () => {
    const codes = [
      'no-active-interface', 'gateway-unknown', 'resolver-broken', 'dns-unreachable',
      'captive-portal', 'internet-unreachable', 'targets-unreachable', 'targets-partial',
    ] as const;
    for (const code of codes) {
      expect(layerCauseLabel(code).length).toBeGreaterThan(0);
    }
  });
});
