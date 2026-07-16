// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Playbook `preserve:` / `capability:` support and safety-validator wiring
 * (issue #64): compiled playbook plans run through the same validatePlan()
 * checks as agent plans — no shortcuts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlaybook } from '../framework/playbook/parser.js';
import { playbookToPlan, buildPlaybookManifest } from '../framework/playbook/runtime.js';
import { validatePlan } from '../framework/validator.js';
import type { SystemActionStep } from '../types/step-types.js';

function makePlaybook(stepProps: string): string {
  return `---
name: preserve-test
version: "1.0.0"
description: State preservation test scenario
agent: pg-replication
severity: elevated
---

### 1. Notify operators
- type: human_notification
- channel: default
- message: recovery starting

### 2. Mutate the system
- type: system_action
${stepProps}
- success: "system recovered"

\`\`\`sql
SELECT 1;
\`\`\`

## Rollback

Restore from the preserved state.
`;
}

const ELEVATED_FULL = `- risk: elevated
- capability: db.replica.disconnect
- preserve: replication_slot_state, replica_connection_info`;

describe('preserve/capability parsing', () => {
  it('parses preserve into a trimmed name list', () => {
    const parsed = parsePlaybook(makePlaybook(ELEVATED_FULL));
    const step = parsed.steps[1]!;
    expect(step.preserve).toEqual(['replication_slot_state', 'replica_connection_info']);
  });

  it('parses capability into a trimmed id list', () => {
    const parsed = parsePlaybook(makePlaybook(ELEVATED_FULL));
    expect(parsed.steps[1]!.capabilities).toEqual(['db.replica.disconnect']);
  });

  it('omits preserve/capabilities when absent or empty', () => {
    const parsed = parsePlaybook(makePlaybook('- risk: routine\n- preserve: ,  ,'));
    const step = parsed.steps[1]!;
    expect(step.preserve).toBeUndefined();
    expect(step.capabilities).toBeUndefined();
  });
});

describe('runtime mapping', () => {
  it('maps preserve to required statePreservation.before captures', () => {
    const plan = playbookToPlan(parsePlaybook(makePlaybook(ELEVATED_FULL)));
    const action = plan.steps.find((s) => s.type === 'system_action') as SystemActionStep;
    expect(action.statePreservation.before).toEqual([
      {
        name: 'replication_slot_state',
        captureType: 'command_output',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
      {
        name: 'replica_connection_info',
        captureType: 'command_output',
        captureCost: 'negligible',
        capturePolicy: 'required',
      },
    ]);
  });

  it('maps capability to requiredCapabilities', () => {
    const plan = playbookToPlan(parsePlaybook(makePlaybook(ELEVATED_FULL)));
    const action = plan.steps.find((s) => s.type === 'system_action') as SystemActionStep;
    expect(action.requiredCapabilities).toEqual(['db.replica.disconnect']);
  });

  it('compiles empty statePreservation.before when preserve is absent', () => {
    const plan = playbookToPlan(parsePlaybook(makePlaybook('- risk: routine\n- capability: db.query.read')));
    const action = plan.steps.find((s) => s.type === 'system_action') as SystemActionStep;
    expect(action.statePreservation.before).toEqual([]);
  });
});

describe('buildPlaybookManifest', () => {
  it('derives execution contexts, capabilities, and max risk from the steps', () => {
    const manifest = buildPlaybookManifest(parsePlaybook(makePlaybook(ELEVATED_FULL)));
    expect(manifest.spec.failureScenarios).toEqual(['State preservation test scenario']);
    expect(manifest.spec.riskProfile.maxRiskLevel).toBe('elevated');
    expect(manifest.spec.executionContexts).toEqual([
      expect.objectContaining({ name: 'default', capabilities: ['db.replica.disconnect'] }),
    ]);
  });
});

describe('safety validation of compiled playbook plans', () => {
  it('passes for a fully declared elevated step', () => {
    const parsed = parsePlaybook(makePlaybook(ELEVATED_FULL));
    const validation = validatePlan(playbookToPlan(parsed), buildPlaybookManifest(parsed));
    expect(validation.checks.filter((c) => !c.passed)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('fails state preservation for an elevated step without preserve', () => {
    const parsed = parsePlaybook(makePlaybook('- risk: elevated\n- capability: db.replica.disconnect'));
    const validation = validatePlan(playbookToPlan(parsed), buildPlaybookManifest(parsed));
    expect(validation.valid).toBe(false);
    const failed = validation.checks.find((c) => c.name.includes('State preservation'));
    expect(failed?.passed).toBe(false);
  });

  it('fails capability declaration for a system_action without capability', () => {
    const parsed = parsePlaybook(makePlaybook('- risk: elevated\n- preserve: some_state'));
    const validation = validatePlan(playbookToPlan(parsed), buildPlaybookManifest(parsed));
    expect(validation.valid).toBe(false);
    const failed = validation.checks.find((c) => c.name.includes('declare required capabilities'));
    expect(failed?.passed).toBe(false);
  });

  it('fails for capability ids not present in the registry', () => {
    const parsed = parsePlaybook(
      makePlaybook('- risk: elevated\n- capability: db.made.up\n- preserve: some_state'),
    );
    const validation = validatePlan(playbookToPlan(parsed), buildPlaybookManifest(parsed));
    expect(validation.valid).toBe(false);
    const failed = validation.checks.find((c) => c.name.includes('capabilities are registered'));
    expect(failed?.passed).toBe(false);
  });

  for (const example of ['pg-replication-lag.md', 'redis-memory-pressure.md']) {
    it(`shipped example ${example} passes all safety checks`, () => {
      const content = readFileSync(`playbooks/examples/${example}`, 'utf-8');
      const parsed = parsePlaybook(content, example);
      const validation = validatePlan(playbookToPlan(parsed), buildPlaybookManifest(parsed));
      expect(validation.checks.filter((c) => !c.passed)).toEqual([]);
      expect(validation.valid).toBe(true);
    });
  }
});
