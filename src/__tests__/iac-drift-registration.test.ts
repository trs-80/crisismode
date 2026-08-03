// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { builtinAgents } from '../config/builtin-agents.js';
import { resolveTarget } from '../config/resolve.js';

describe('iac-drift registration', () => {
  const reg = builtinAgents.find((r) => r.kind === 'iac-drift');

  it('is registered with a read-only risk profile', () => {
    expect(reg).toBeDefined();
    expect(reg!.name).toBe('iac-drift-recovery');
    expect(reg!.manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(reg!.manifest.spec.riskProfile.dataLossPossible).toBe(false);
  });

  it('resolveTarget passes the iac options block through', () => {
    const resolved = resolveTarget({
      name: 't', kind: 'iac-drift', primary: { host: 'auto', port: 0 }, iac: { dir: '/tmp/project' },
    });
    expect(resolved.iac).toEqual({ dir: '/tmp/project' });
  });

  it('creates a simulator-backed agent when iac.dir is "simulator"', async () => {
    const resolved = resolveTarget({
      name: 't', kind: 'iac-drift', primary: { host: 'auto', port: 0 }, iac: { dir: 'simulator' },
    });
    const instance = await reg!.createAgent(resolved);
    expect(instance.agent.manifest.metadata.name).toBe('iac-drift-recovery');
    const status = await (instance.backend as unknown as { getStateStatus(): Promise<{ readable: boolean }> }).getStateStatus();
    expect(status.readable).toBe(true);
    await instance.backend.close();
  });
});
