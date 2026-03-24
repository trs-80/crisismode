# Writing Playbooks

Playbooks are Markdown files that describe recovery procedures. They compile to the same `RecoveryPlan` structure used by code-based agents, with the same safety infrastructure — blast radius validation, approval gates, state preservation, and forensic recording.

## What Is a Playbook

A playbook is a `.md` file with two parts:

1. **YAML frontmatter** — Metadata: name, version, description, triggers, requirements.
2. **Markdown body** — Numbered H3 headings, each describing one recovery step.

Playbooks are discovered from three locations:
- `~/.crisismode/playbooks/` (user)
- `./playbooks/` (project)
- `$CRISISMODE_PLAYBOOK_PATH` environment variable

## Frontmatter Reference

The frontmatter block is delimited by `---` lines at the top of the file.

### Required fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique playbook identifier |
| `version` | string | Semver version |
| `description` | string | What this playbook recovers |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `agent` | string | Which agent this playbook targets |
| `provider` | string | Cloud provider (aws, gcp, azure) |
| `severity` | string | Default risk level: `routine`, `elevated`, `high`, `critical` |
| `triggers` | array | Alert conditions that activate this playbook |
| `requires` | object | Execution contexts and tools needed |
| `tags` | array | Searchable tags |
| `author` | string | Author name or email |
| `estimated_duration` | string | ISO 8601 duration (e.g., `30m`, `PT15M`) |

### Trigger format

```yaml
triggers:
  - alert: pg_replication_lag_seconds
    condition: "> 300"
    duration: 5m
```

### Requirements format

```yaml
requires:
  contexts:
    - type: database_read
      target: primary
    - type: database_write
      target: primary
  tools:
    - psql
    - pg_basebackup
```

## Step Format

Each step is an H3 heading with a number and title, followed by properties and an optional body.

```markdown
### 1. Step title here
- type: diagnosis_action
- description: What this step does
- target: primary

Optional prose description or notes.
```

Properties use `- key: value` syntax. Available properties vary by step type:

| Property | Used By | Description |
|---|---|---|
| `type` | All | Step type (required) |
| `description` | All | Human-readable explanation |
| `target` | system_action, diagnosis_action | Target system identifier |
| `execution_context` | system_action, diagnosis_action | Named execution context |
| `risk` | system_action | Risk level: routine, elevated, high, critical |
| `precondition` | system_action | Condition that must be true before execution |
| `success` | system_action | Condition that must be true after execution |
| `channel` | human_notification | Notification channel (pagerduty, slack, default) |
| `message` | human_notification | Notification message text |
| `template` | human_notification | Named message template |
| `timeout` | human_approval, replanning_checkpoint | How long to wait |
| `escalation` | human_approval | Who to escalate to on timeout |
| `condition` | conditional | Boolean expression to evaluate |
| `on_success` | conditional | Action if condition is true |
| `on_failure` | conditional | Action if condition is false |

### Blast radius (sub-properties)

```markdown
- blast_radius:
  max_affected_rows: 0
  max_downtime_seconds: 30
  requires_maintenance_window: true
```

## Step Types

### `diagnosis_action`
Read-only data gathering. Use for initial assessment, replication status queries, health checks. Include a code block with the diagnostic command.

### `human_notification`
Alert stakeholders. Set `channel` and `message`. No commands are executed.

### `checkpoint`
Capture system state before mutations. The framework snapshots the configured targets for rollback and audit.

### `system_action`
Execute a command that mutates system state. Must declare `risk`, should have `precondition`, `success`, and `blast_radius`. Include a code block with the command.

### `human_approval`
Pause execution until a human approves. Set `timeout` and `escalation`. The body text is shown to the approver as context.

### `replanning_checkpoint`
Allow the agent to re-evaluate and potentially revise the remaining plan. Set `timeout`.

### `conditional`
Branch based on system state. Set `condition`, `on_success`, and `on_failure`.

## Code Blocks

Fenced code blocks with language tags specify the commands to execute:

````markdown
### 4. Disconnect lagging replica
- type: system_action
- risk: elevated

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_replication
WHERE client_addr = '{target.replica.host}';
```
````

Supported language tags: `sql`, `sh`, `bash`, `yaml`, `json`. The language tag determines how the command is interpreted by the execution backend.

## Variable Interpolation

Use curly braces to reference diagnosis data and target configuration:

- `{diagnosis.lag_seconds}` — Value from diagnosis findings
- `{target.replica.host}` — Target system address
- `{target.primary.port}` — Target system port

Variables are resolved at plan compilation time from the active agent context.

## Validation

Validate a playbook without executing it:

```bash
crisismode playbook validate path/to/playbook.md
```

This parses the frontmatter, validates required fields, parses all steps, and compiles the playbook to a `RecoveryPlan`. Errors are reported with the field name and reason.

For machine-readable output:

```bash
crisismode playbook validate path/to/playbook.md --json
```

## Dry Run

Preview the compiled recovery plan:

```bash
crisismode playbook dry-run path/to/playbook.md
```

This shows each step with its type, risk level, and name. Use `--json` for the full plan as structured JSON.

## Listing Discovered Playbooks

See all playbooks CrisisMode can find:

```bash
crisismode playbook list
```

## Rollback Section

Add a `## Rollback` section at the end of your playbook to describe the rollback procedure:

```markdown
## Rollback

If replica resync fails:
1. Restore read traffic to remaining healthy replicas
2. Page the DBA team with the forensic record
3. Do NOT attempt a second resync without human approval
```

The rollback section is captured as free-text and included in the compiled plan's rollback strategy.

## Complete Example

```markdown
---
name: "redis-memory-pressure"
version: "1.0.0"
description: "Recovery for Redis memory pressure exceeding maxmemory"
agent: redis
severity: elevated
triggers:
  - alert: redis_memory_usage_ratio
    condition: "> 0.9"
    duration: 5m
tags:
  - redis
  - memory
author: "sre-team"
estimated_duration: "15m"
---

# Redis Memory Pressure Recovery

### 1. Assess memory usage
- type: diagnosis_action
- target: redis-primary

```sh
redis-cli info memory
```

### 2. Notify on-call
- type: human_notification
- channel: slack
- message: "Redis memory at {diagnosis.used_memory_ratio}%"

### 3. Capture state
- type: checkpoint

### 4. Evict expired keys
- type: system_action
- risk: routine
- target: redis-primary
- precondition: "Redis is accepting commands"
- success: "Memory usage below 85%"

```sh
redis-cli --scan --pattern '*' | head -1000 | xargs redis-cli unlink
```

### 5. Verify recovery
- type: conditional
- condition: "memory_usage_ratio < 0.85"
- on_success: "Memory pressure resolved"
- on_failure: "Escalate to team for maxmemory tuning"

## Rollback

If eviction causes cache miss storms:
1. Monitor hit rate for 5 minutes
2. If hit rate drops below 80%, alert the application team
```

For more playbook examples, see the `playbooks/examples/` directory.
