// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { parsePlaybook, validatePlaybookFrontmatter } from '../framework/playbook/parser.js';

describe('parsePlaybook', () => {
  it('parses a valid playbook with all frontmatter fields', () => {
    const markdown = `---
name: pg-replication-lag
version: "1.0.0"
description: Recover from PostgreSQL replication lag
agent: pg-replication
severity: elevated
triggers:
  - alert: ReplicationLagHigh
    condition: lag > 30s
tags:
  - postgresql
  - replication
author: test-author
estimated_duration: 15m
---

Some body content.
`;

    const result = parsePlaybook(markdown);

    expect(result.frontmatter.name).toBe('pg-replication-lag');
    expect(result.frontmatter.version).toBe('1.0.0');
    expect(result.frontmatter.description).toBe('Recover from PostgreSQL replication lag');
    expect(result.frontmatter.agent).toBe('pg-replication');
    expect(result.frontmatter.severity).toBe('elevated');
    expect(result.frontmatter.triggers).toEqual([
      { alert: 'ReplicationLagHigh', condition: 'lag > 30s' },
    ]);
    expect(result.frontmatter.tags).toEqual(['postgresql', 'replication']);
    expect(result.frontmatter.author).toBe('test-author');
    expect(result.frontmatter.estimatedDuration).toBe('15m');
    expect(result.rawMarkdown).toBe(markdown);
  });

  it('parses steps correctly from H3 headings', () => {
    const markdown = `---
name: multi-step
version: "1.0.0"
description: Multi-step playbook
---

### 1. Check replication status

- type: diagnosis_action
- target: replica

Gather replication metrics.

### 2. Restart replication

- type: system_action
- risk: elevated
- target: replica

Restart the replication process.

### 3. Notify team

- type: human_notification
- channel: slack
- message: "Replication recovered"

Let the team know.
`;

    const result = parsePlaybook(markdown);

    expect(result.steps).toHaveLength(3);

    const step1 = result.steps[0]!;
    const step2 = result.steps[1]!;
    const step3 = result.steps[2]!;

    expect(step1.position).toBe(1);
    expect(step1.title).toBe('Check replication status');
    expect(step1.type).toBe('diagnosis_action');
    expect(step1.target).toBe('replica');

    expect(step2.position).toBe(2);
    expect(step2.title).toBe('Restart replication');
    expect(step2.type).toBe('system_action');
    expect(step2.risk).toBe('elevated');

    expect(step3.position).toBe(3);
    expect(step3.title).toBe('Notify team');
    expect(step3.type).toBe('human_notification');
    expect(step3.channel).toBe('slack');
    expect(step3.message).toBe('Replication recovered');
  });

  it('extracts fenced code blocks from steps', () => {
    const markdown = `---
name: sql-playbook
version: "1.0.0"
description: SQL code block test
---

### 1. Query lag

- type: diagnosis_action

\`\`\`sql
SELECT client_addr, replay_lag FROM pg_stat_replication;
\`\`\`
`;

    const result = parsePlaybook(markdown);

    const step = result.steps[0]!;
    expect(step.codeBlocks).toHaveLength(1);
    const codeBlock = step.codeBlocks[0]!;
    expect(codeBlock.lang).toBe('sql');
    expect(codeBlock.content).toBe(
      'SELECT client_addr, replay_lag FROM pg_stat_replication;',
    );
  });

  it('parses blast_radius nested properties', () => {
    const markdown = `---
name: blast-radius-test
version: "1.0.0"
description: Blast radius parsing
---

### 1. Risky operation

- type: system_action
- risk: high
- blast_radius:
  max_downtime_seconds: 30
  max_affected_rows: 1000
  requires_maintenance_window: true

Execute a risky operation.
`;

    const result = parsePlaybook(markdown);

    expect(result.steps[0]!.blastRadius).toEqual({
      maxDowntimeSeconds: 30,
      maxAffectedRows: 1000,
      requiresMaintenanceWindow: true,
    });
  });

  it('extracts rollback section', () => {
    const markdown = `---
name: rollback-test
version: "1.0.0"
description: Rollback section test
---

### 1. Do something

- type: system_action

Execute the thing.

## Rollback

1. Revert the configuration change
2. Restart the service

## Notes

Additional info.
`;

    const result = parsePlaybook(markdown);

    expect(result.rollback).toBeDefined();
    expect(result.rollback).toContain('Revert the configuration change');
    expect(result.rollback).toContain('Restart the service');
  });

  it('throws on missing frontmatter delimiters', () => {
    const markdown = `No frontmatter here, just plain text.`;

    expect(() => parsePlaybook(markdown)).toThrow('frontmatter delimiter');
  });

  it('throws on invalid YAML in frontmatter', () => {
    const markdown = `---
name: [invalid yaml
  - missing bracket
---

Body.
`;

    expect(() => parsePlaybook(markdown)).toThrow('Invalid YAML');
  });

  it('throws on missing required fields', () => {
    const markdown = `---
version: "1.0.0"
description: Missing name
---

Body.
`;

    expect(() => parsePlaybook(markdown)).toThrow('name');
  });

  it('returns empty steps array when no step headings exist', () => {
    const markdown = `---
name: no-steps
version: "1.0.0"
description: Playbook with no steps
---

Just some narrative text with no H3 step headings.
`;

    const result = parsePlaybook(markdown);

    expect(result.steps).toEqual([]);
    expect(result.frontmatter.name).toBe('no-steps');
  });
});

describe('validatePlaybookFrontmatter', () => {
  it('returns valid for correct frontmatter', () => {
    const result = validatePlaybookFrontmatter({
      name: 'test-playbook',
      version: '1.0.0',
      description: 'A test playbook',
      severity: 'elevated',
      tags: ['db', 'recovery'],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects invalid severity', () => {
    const result = validatePlaybookFrontmatter({
      name: 'test',
      version: '1.0.0',
      description: 'desc',
      severity: 'catastrophic',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe('severity');
    expect(result.errors[0]!.message).toContain('routine');
  });

  it('reports errors for all missing required fields', () => {
    const result = validatePlaybookFrontmatter({});

    expect(result.valid).toBe(false);
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain('name');
    expect(fields).toContain('version');
    expect(fields).toContain('description');
  });
});
