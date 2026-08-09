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
| `capability` | system_action | Comma-separated registered capability ids (required by the validator) |
| `preserve` | system_action | Comma-separated state-capture names (required for elevated+ risk) |
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
Execute a command that mutates system state. Must declare `risk` and `capability`; at `elevated` risk or higher must also declare `preserve` (state captured before the step runs, blocking on failure). Should have `precondition`, `success`, and `blast_radius`. Include a code block with the command. `crisismode playbook validate` runs the compiled plan through the same safety validator as code-based agents and reports exactly which rule a step violates.

`capability` values must be ids that are already registered in
`src/framework/capability-registry.ts` — for example `db.query.read`,
`db.replica.disconnect`, `cache.expiry.trigger`, `k8s.node.drain`,
`queue.workers.restart`. An unregistered id fails validation with
`Missing capabilities on steps: <step-id>`, which is the most common reason a
playbook parses but will not validate.

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

````markdown
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
redis-cli -e info memory
```

### 2. Notify on-call
- type: human_notification
- channel: slack
- message: "Redis memory at {diagnosis.used_memory_ratio}%"

### 3. Capture state
- type: checkpoint

### 4. Reclaim keys already past their TTL
- type: system_action
- risk: routine
- capability: cache.expiry.trigger
- target: redis-primary
- preserve: keyspace_before
- precondition: "Redis is accepting commands"
- success: "Memory usage below 85%"

```sh
# Bounded sample of the keyspace. Reading a key that is already past its TTL is
# what makes Redis reclaim it; keys still inside their TTL, and keys with no TTL
# at all, are read and left alone. This step deletes nothing itself.
# Every redis-cli call runs with -e and is checked, so a failed SCAN or TTL fails
# the step rather than reporting a cleanup that never happened. Without -e,
# redis-cli exits 0 even when Redis answers with an error reply such as NOAUTH.
set -u
limit=1000
cursor=0
scanned=0
rounds=0

while [ "$scanned" -lt "$limit" ] && [ "$rounds" -lt 50 ]; do
  rounds=$((rounds + 1))
  if ! reply=$(redis-cli -e SCAN "$cursor" COUNT 100); then
    echo "SCAN failed at cursor $cursor" >&2
    exit 1
  fi

  # First line of a SCAN reply is the next cursor; the rest are keys.
  first=1
  while IFS= read -r key; do
    if [ "$first" -eq 1 ]; then cursor=$key; first=0; continue; fi
    [ -n "$key" ] || continue
    if ! redis-cli -e TTL "$key" > /dev/null; then
      echo "TTL failed for key: $key" >&2
      exit 1
    fi
    scanned=$((scanned + 1))
    [ "$scanned" -lt "$limit" ] || break
  done <<EOF
$reply
EOF

  [ "$cursor" != "0" ] || break
done

echo "touched $scanned keys, deleted none"
```

### 5. Verify recovery
- type: conditional
- condition: "memory_usage_ratio < 0.85"
- on_success: "Memory pressure resolved"
- on_failure: "Escalate to team for maxmemory tuning"

## Rollback

Reclaiming already-expired keys is not reversible, and does not remove anything
applications can still read. If memory stays above 85%:
1. Escalate for `maxmemory` and eviction-policy tuning
2. Watch the hit rate for 5 minutes before any further change
````

**Why step 4 is `routine`.** The command only reclaims keys Redis already considers
expired, and it is bounded to a 1000-key sample, so it cannot cause a cache-miss
storm. Deleting keys that have *not* expired — what
`redis-cli --scan --pattern '*' | xargs redis-cli unlink` would do — is a different
action: it drops live cache entries, so it belongs at `elevated` risk with
`preserve` declared and a blast radius that admits the impact. That is exactly how
the built-in Redis agent declares its aggressive-expiry step (`elevated`, with an
`INFO keyspace` capture — see `src/agent/redis/agent.ts`). Risk labels are read
under incident pressure; a mislabelled step is how a "routine" playbook takes out a
cache.

**Why step 4 checks every command.** The obvious one-liner —
`redis-cli --scan --count 100 | head -n 1000 | while read -r key; do redis-cli TTL "$key"; done`
— exits `0` even when the `SCAN` never connected, because a pipeline reports the status of
its *last* command and a `while` loop reports the status of its *final* iteration. The
engine would record step 4 as a success and move on to step 5 believing memory pressure
had been addressed. Reaching for `set -o pipefail` trades that for the opposite bug:
`head` closes the pipe after 1000 lines, `redis-cli` dies of `SIGPIPE`, and a perfectly
healthy Redis reports exit 141. The loop above has no pipeline at all — it feeds the
`SCAN` reply in through a here-document and tests each `redis-cli` exit status directly.

Testing the exit status is only half of it, because `redis-cli` exits `0` even when Redis
answers with an error reply — a `NOAUTH` on a password-protected instance, a `NOPERM` from
an ACL-restricted `--user`, a `WRONGTYPE`, an unknown command. The step would print
`touched 0 keys` and succeed having run nothing. `-e` is what makes an error reply an exit
code (`redis-cli --help`: "Return exit error code when command execution fails"), so every
call in the loop carries it. `-e` reacts to error *replies* only: an empty `SCAN` result,
a missing key, and a `TTL` of `-1` or `-2` are ordinary replies, so a healthy Redis still
exits `0`. A step that silently succeeds after its cleanup failed is worse than one that
fails loudly.

**The rule is not specific to step 4.** Every `redis-cli` call in a playbook carries `-e`,
including the read-only `INFO` in step 1: a diagnosis that could not reach the instance
should fail rather than hand the following steps an empty reading. It matters most on
mutating steps. `redis-cli CONFIG SET maxmemory 8gb` exits `0` when Redis *rejects* the
value — a bad unit is enough, no auth failure required — so an `elevated` step would report
that the memory ceiling had been raised when nothing changed, and the plan would carry on
under that belief. That is the failure this framework exists to prevent, so the mutating
step gets `-e` even more than the read-only one does.

**A block is one command to the engine.** The runtime compiles each step's `sh` block into
a single `structured_command`, so a block's exit status is its *last* line's. `-e` alone is
not enough where a step runs several commands: step 1's block opens with `set -e` so a
failing `INFO` aborts it instead of being overwritten by a successful `DBSIZE`. Step 4 does
not need `set -e` — it tests every status itself and exits explicitly.

For more playbook examples, see the `playbooks/examples/` directory.
