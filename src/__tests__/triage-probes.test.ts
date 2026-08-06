// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { classifyObserverContext, detectObserverContext } from '../framework/triage-probes.js';

describe('classifyObserverContext', () => {
  it('calls a Kubernetes pod a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
      dmi: null,
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('KUBERNETES_SERVICE_HOST');
  });

  it('calls a cloud DMI vendor string a server', () => {
    const result = classifyObserverContext({
      platform: 'linux',
      env: {},
      dmi: 'Amazon EC2 t3.medium',
    });
    expect(result.context).toBe('server');
    expect(result.evidence).toContain('amazon');
  });

  it('assumes darwin with no server markers is a laptop, and says it is an assumption', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: {}, dmi: null });
    expect(result.context).toBe('laptop');
    expect(result.evidence).toContain('assumption');
  });

  it('returns unknown for a bare Linux host with no markers', () => {
    const result = classifyObserverContext({ platform: 'linux', env: {}, dmi: 'LENOVO 20XW' });
    expect(result.context).toBe('unknown');
  });

  it('ignores an empty environment marker', () => {
    const result = classifyObserverContext({ platform: 'darwin', env: { DYNO: '' }, dmi: null });
    expect(result.context).toBe('laptop');
  });
});

describe('detectObserverContext', () => {
  it('classifies the real host without throwing', () => {
    const result = detectObserverContext();
    expect(['laptop', 'server', 'unknown']).toContain(result.context);
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});
