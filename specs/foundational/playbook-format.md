# Playbook Format Specification

**Version:** 0.1.0-draft
**Status:** Draft
**Date:** 2026-03-23
**Authors:** Aaron Johnson

---

## Abstract

This specification defines the Markdown-based playbook format for CrisisMode. Playbooks are declarative recovery procedures written as Markdown files with YAML frontmatter. They compile to `RecoveryPlan` objects and use the same safety infrastructure, validation rules, and execution engine as code-based agents.

Playbooks exist to make recovery knowledge accessible without writing TypeScript. An operator who can describe a recovery procedure in Markdown can create a playbook that benefits from CrisisMode's safety guarantees, forensic recording, and execution engine.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

## Table of Contents

1. [Overview](#1-overview)
2. [File Structure](#2-file-structure)
3. [Frontmatter Schema](#3-frontmatter-schema)
4. [Step Format](#4-step-format)
5. [Code Blocks](#5-code-blocks)
6. [Variable Interpolation](#6-variable-interpolation)
7. [Rollback Section](#7-rollback-section)
8. [Validation Rules](#8-validation-rules)
9. [Compilation](#9-compilation)
10. [Discovery](#10-discovery)
11. [Complete Example](#11-complete-example)

---

## 1. Overview

A playbook is a `.md` file that describes a recovery procedure declaratively. The lifecycle is:

1. **Author** — an operator writes a Markdown file with YAML frontmatter and numbered steps.
2. **Discover** — the CLI finds playbooks in well-known directories.
3. **Parse** — the parser extracts frontmatter, steps, code blocks, and rollback sections into a `ParsedPlaybook`.
4. **Validate** — the validator checks schema conformance and safety rules.
5. **Compile** — the runtime compiles the `ParsedPlaybook` into a `RecoveryPlan` with variable interpolation.
6. **Execute** — the `ExecutionEngine` runs the plan with the same safety guarantees as any agent-generated plan.

Playbooks are intentionally a subset of what code-based agents can express. They trade flexibility for accessibility: any procedure that can be described as a linear sequence of the 7 step types (with optional conditionals) can be a playbook.

## 2. File Structure

A playbook file has three sections:

```
---
(YAML frontmatter)
---

(Steps as H3 headings)

## Rollback
(Optional rollback procedure)
```

- The file MUST begin with YAML frontmatter delimited by `---`.
- The body MUST contain at least one step as an H3 heading (`### N. Title`).
- The file MAY end with a `## Rollback` section.
- The file extension MUST be `.md`.

## 3. Frontmatter Schema

The frontmatter is YAML between `---` delimiters. Required and optional fields:

### Required Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique playbook identifier. MUST match `^[a-z0-9-]+$`. |
| `version` | string | Semantic version (e.g., `"1.0.0"`). |
| `description` | string | Human-readable description of what this playbook recovers. |

### Optional Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `agent` | string | — | Existing agent name to delegate diagnosis to. When set, the agent's `diagnose()` output populates `{diagnosis.*}` variables. |
| `provider` | string | — | Infrastructure provider hint (e.g., `aws`, `gcp`, `bare-metal`). |
| `severity` | RiskLevel | `"routine"` | Default severity: `routine`, `elevated`, `high`, `critical`. |
| `triggers` | Trigger[] | — | Alert matching rules (see below). |
| `requires` | Requirements | — | Execution requirements (see below). |
| `tags` | string[] | — | Searchable tags for filtering and discovery. |
| `author` | string | — | Contributor handle or name. |
| `estimatedDuration` | string | — | Estimated wall-clock duration (e.g., `"15m"`, `"2h"`). |

### Trigger Object

Each trigger describes an alert pattern that activates this playbook:

```yaml
triggers:
  - alert: PostgreSQLReplicationLag
    condition: lag_seconds > 120
    duration: 5m
```

| Field | Type | Required | Description |
|---|---|---|---|
| `alert` | string | Yes | Alert name to match. |
| `condition` | string | No | Expression evaluated against alert labels/values. |
| `duration` | string | No | How long the condition must persist before triggering. |

### Requirements Object

Declares what the playbook needs to execute:

```yaml
requires:
  contexts:
    - type: postgresql
      target: primary
    - type: postgresql
      target: replica
  tools:
    - pg_basebackup
```

| Field | Type | Description |
|---|---|---|
| `contexts` | Array<{type, target}> | Execution contexts the playbook requires. |
| `tools` | string[] | External tools that must be available on the spoke. |

## 4. Step Format

Each step is an H3 heading followed by properties as a YAML-like list and optional body content.

### Heading Format

```markdown
### N. Step title
```

- `N` is a positive integer starting at 1. Step numbers MUST be sequential.
- The title is free-form text after the number and period.

### Step Properties

Properties are specified as Markdown list items with `key: value` syntax:

```markdown
### 1. Check replication lag
- type: diagnosis_action
- risk: none
- target: replica
- executionContext: postgresql-replica
- success: lag_seconds < 300
```

All properties:

| Property | Required | Applies To | Description |
|---|---|---|---|
| `type` | Yes | All | One of the 7 step types (see below). |
| `description` | No | All | Step description. |
| `risk` | No | system_action | Risk level: `none`, `routine`, `elevated`, `high`, `critical`. |
| `target` | No | diagnosis_action, system_action | Step target identifier. |
| `executionContext` | No | diagnosis_action, system_action | Named execution context from `requires.contexts`. |
| `precondition` | No | system_action | Expression that must be true before execution. |
| `success` | No | system_action, diagnosis_action | Success criteria expression. |
| `blast_radius` | No | system_action | YAML block with blast radius constraints. |
| `preserve` | For `elevated`+ risk | system_action | Comma-separated state-capture names recorded before the step executes (see State Preservation). |
| `capability` | Yes (validator-enforced) | system_action | Comma-separated registered capability ids the step requires (e.g. `db.replica.disconnect`). |
| `channel` | No | human_notification | Notification channel (e.g., `slack`, `pagerduty`, `email`). |
| `message` | No | human_notification | Message template with variable interpolation. |
| `timeout` | No | system_action, human_approval | Step timeout (e.g., `"30s"`, `"5m"`). |
| `escalation` | No | human_approval | Escalation target if approval times out. |
| `condition` | No | conditional | Conditional expression. |
| `on_success` | No | conditional | Step or action on condition success. |
| `on_failure` | No | conditional | Step or action on condition failure. |
| `template` | No | human_notification | Named message template. |

### Step Types

The 7 step types match those defined in the Recovery Agent Contract:

| Type | Description |
|---|---|
| `diagnosis_action` | Read-only data gathering. No mutations. |
| `human_notification` | Send alerts to stakeholders. |
| `checkpoint` | Capture system state before mutations. |
| `system_action` | Execute commands with safety constraints. |
| `human_approval` | Gate execution pending human decision. |
| `replanning_checkpoint` | Allow plan revision mid-flight. |
| `conditional` | Branch execution based on system state. |

### State Preservation

Every `system_action` at `elevated` risk or higher MUST declare `preserve`
with at least one state-capture name. Captures compile to
`statePreservation.before` entries with `capturePolicy: required` — if a
declared capture fails at execution time, the step is blocked. This is the
same safety rule the plan validator enforces for code-based agents; compiled
playbook plans run through the identical validator (`crisismode playbook
validate` / `dry-run`), so a missing `preserve` fails validation rather than
silently compiling an unprotected plan.

```markdown
- preserve: replication_slot_state, replica_connection_info
```

### Capabilities

Every `system_action` MUST declare `capability` with one or more registered
capability ids (see `src/framework/capability-registry.ts`, e.g.
`db.query.read`, `db.replica.disconnect`, `cache.config.set`). The validator
rejects steps with no declared capabilities and ids not present in the
registry.

```markdown
- capability: db.replica.disconnect
```

### Blast Radius

For `system_action` steps at `elevated` risk or higher, `blast_radius` MUST be specified:

```markdown
- blast_radius:
    max_affected_rows: 1
    max_downtime_seconds: 0
    requires_maintenance_window: false
```

## 5. Code Blocks

Fenced code blocks within a step provide the commands to execute. The language tag indicates the execution method:

````markdown
```sql
SELECT client_addr, state, sent_lsn, replay_lsn,
       EXTRACT(EPOCH FROM replay_lag) AS lag_seconds
FROM pg_stat_replication;
```
````

Supported language tags include: `sql`, `sh`, `bash`, `python`, `curl`, `redis-cli`, `etcdctl`, `kubectl`, and any tag the execution backend recognizes.

A step MAY contain multiple code blocks. They execute sequentially within the step.

Free-form Markdown between code blocks is treated as documentation and is preserved in the parsed playbook but not executed.

## 6. Variable Interpolation

Playbooks support variable interpolation using `{variable.path}` syntax. Variables are resolved at compile time from the agent context and diagnosis results.

### Variable Sources

| Prefix | Source | Example |
|---|---|---|
| `target.*` | Execution context targets | `{target.replica.host}` |
| `diagnosis.*` | Diagnosis result fields | `{diagnosis.lag_seconds}` |
| `context.*` | Agent context metadata | `{context.cluster_name}` |
| `env.*` | Environment variables | `{env.PG_PORT}` |
| `step.*` | Previous step outputs | `{step.1.output}` |

### Interpolation Rules

- Variables are delimited by `{` and `}`.
- Undefined variables cause a compilation error unless a default is provided: `{diagnosis.lag_seconds|0}`.
- Variables are interpolated in: code blocks, message templates, condition expressions, and precondition/success expressions.
- Frontmatter values are NOT interpolated — they are static metadata.

## 7. Rollback Section

An optional `## Rollback` section at the end of the playbook describes fallback procedures:

```markdown
## Rollback

If WAL replay fails, reconnect the replica to the primary:

1. Stop the replica
2. Re-initialize from primary using pg_basebackup
3. Restart the replica and verify replication
```

The rollback section compiles to the `rollbackStrategy` field of the `RecoveryPlan`. Its content is free-form Markdown. Structured rollback steps (using the same H3 format) MAY be used for machine-parseable rollback procedures.

The `rollbackStrategy.type` is inferred:
- If no rollback section exists: `"none"`
- If rollback contains numbered H3 steps: `"stepwise"`
- Otherwise: `"full"` with the section content as the description

## 8. Validation Rules

A playbook MUST pass the following validation checks:

### Frontmatter Validation

1. `name`, `version`, and `description` MUST be present and non-empty.
2. `name` MUST match `^[a-z0-9-]+$`.
3. `version` MUST be valid semver.
4. `severity`, if present, MUST be a valid `RiskLevel`.
5. `triggers`, if present, MUST each have an `alert` field.

### Step Validation

6. At least one step MUST be present.
7. Step positions MUST be sequential starting at 1.
8. Each step MUST have a valid `type`.
9. `system_action` steps with `risk` of `elevated`, `high`, or `critical` MUST include `blast_radius`.
10. Plans containing `elevated+` risk steps MUST include at least one `human_notification` step.

### Compilation Validation

11. The compiled `RecoveryPlan` MUST pass the existing plan validator (`src/framework/validator.ts`).
12. All referenced variables MUST be resolvable or have defaults.

## 9. Compilation

The compiler transforms a `ParsedPlaybook` into a `RecoveryPlan`:

| Playbook Field | RecoveryPlan Field |
|---|---|
| `frontmatter.name` | `metadata.agentName` |
| `frontmatter.version` | `metadata.agentVersion` |
| `frontmatter.description` | `metadata.summary` |
| `frontmatter.estimatedDuration` | `metadata.estimatedDuration` |
| Step list | `steps[]` (mapped to typed step objects) |
| `## Rollback` section | `rollbackStrategy` |

The `metadata.planId` is generated at compile time. The `metadata.scenario` is derived from the playbook name and trigger context.

## 10. Discovery

Playbooks are discovered from three sources, in priority order:

1. **User** — `~/.crisismode/playbooks/` — personal playbooks
2. **Project** — `./playbooks/` or `./.crisismode/playbooks/` — project-local playbooks
3. **Environment** — `$CRISISMODE_PLAYBOOK_PATH` — colon-separated list of directories

Files MUST have a `.md` extension. The parser attempts to load each file and emits a warning (not an error) for files that fail to parse, so a single malformed playbook does not block discovery.

When multiple playbooks share the same `name`, the highest-priority source wins (user > project > env).

## 11. Complete Example

```markdown
---
name: pg-replication-lag
version: "1.0.0"
description: Recover PostgreSQL streaming replication when lag exceeds thresholds
agent: pg-replication
severity: elevated
triggers:
  - alert: PostgreSQLReplicationLag
    condition: lag_seconds > 120
    duration: 5m
requires:
  contexts:
    - type: postgresql
      target: primary
    - type: postgresql
      target: replica
tags:
  - postgresql
  - replication
  - lag
author: "@infra-team"
estimatedDuration: "15m"
---

### 1. Check replication status
- type: diagnosis_action
- target: replica
- executionContext: postgresql-replica
- description: Query pg_stat_replication to assess current lag

```sql
SELECT client_addr, state, sent_lsn, replay_lsn,
       EXTRACT(EPOCH FROM replay_lag) AS lag_seconds
FROM pg_stat_replication;
```

### 2. Notify on-call
- type: human_notification
- channel: slack
- message: "Replication lag detected on {target.replica.host}: {diagnosis.lag_seconds}s behind primary"

### 3. Checkpoint replication state
- type: checkpoint
- description: Capture current WAL positions before any intervention

### 4. Approve recovery action
- type: human_approval
- timeout: 10m
- escalation: platform-lead
- description: Confirm proceeding with WAL replay acceleration

### 5. Restart WAL replay
- type: system_action
- risk: elevated
- target: replica
- executionContext: postgresql-replica
- precondition: replica_connected = true
- success: lag_seconds < 10
- blast_radius:
    max_affected_rows: 0
    max_downtime_seconds: 30
    requires_maintenance_window: false

```sql
SELECT pg_wal_replay_resume();
```

### 6. Verify recovery
- type: conditional
- condition: lag_seconds < 10
- on_success: "Recovery complete — lag within threshold"
- on_failure: "Escalate to DBA — manual WAL management required"

## Rollback

If WAL replay fails or causes further divergence:

1. Pause WAL replay: `SELECT pg_wal_replay_pause();`
2. Reconnect replica to primary using pg_basebackup
3. Restart the replica and verify replication resumes
```
