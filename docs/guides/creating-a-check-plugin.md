# Creating a Check Plugin

This guide walks through building a check plugin from scratch. By the end, you will have a working plugin that `crisismode scan` discovers and runs automatically.

## What Is a Check Plugin?

A check plugin is a standalone executable (typically a shell script) that probes a specific system and reports health status. The CrisisMode scanner discovers check plugins at startup, sends them a JSON request on stdin, and reads a JSON result from stdout.

Check plugins are the lowest-barrier way to extend CrisisMode. They require no TypeScript, no compilation, and no knowledge of the framework internals.

Three verbs are supported:

| Verb | Purpose | Used by |
|---|---|---|
| `health` | Quick health probe with status and confidence score | `crisismode scan` |
| `diagnose` | Deeper read-only inspection that produces findings | `crisismode diagnose` |
| `plan` | Generate suggested recovery steps | `crisismode recover` |

## File Structure

Each check plugin lives in its own directory under `checks/`:

```
checks/
  check-mysql-connection/
    manifest.json       # Plugin metadata and capabilities
    check.sh            # The executable check script
```

Plugins are discovered from three locations, in order:

1. `~/.crisismode/checks/` -- user-installed plugins
2. `./checks/` -- project-local plugins (this repo)
3. Paths in the `CRISISMODE_CHECK_PATH` environment variable (colon-separated)

## Step 1: Create the Manifest

Create `checks/check-mysql-connection/manifest.json`:

```json
{
  "name": "check-mysql-connection",
  "description": "Checks MySQL connection health, thread usage, and basic replication status",
  "version": "1.0.0",
  "targetKinds": ["mysql", "generic"],
  "verbs": ["health", "diagnose", "plan"],
  "executable": "./check.sh"
}
```

**Field reference:**

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique plugin name. Convention: `check-<system>-<aspect>`. |
| `description` | Yes | Human-readable description shown in scan output. |
| `version` | Yes | Semver version string. |
| `targetKinds` | Yes | Array of system kinds this plugin checks. Include `"generic"` if the check can run anywhere. |
| `verbs` | Yes | Which verbs this plugin supports: `"health"`, `"diagnose"`, `"plan"`. You can support a subset. |
| `executable` | Yes | Path to the executable, relative to the plugin directory. |
| `maxRiskLevel` | No | Maximum risk level of any plan step this plugin generates. Defaults to `"routine"`. |
| `timeoutMs` | No | Execution timeout in milliseconds. Default: 10000 (10 seconds). |
| `author` | No | Author name or email. |
| `license` | No | License identifier (e.g., `"Apache-2.0"`). |

## Step 2: Write the Check Script

Create `checks/check-mysql-connection/check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# check-mysql-connection: Checks MySQL connection health
# Stdin: JSON with verb, target, context
# Stdout: JSON result
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)

# Check that mysql client is available
if ! command -v mysql >/dev/null 2>&1; then
  printf '{"status":"unknown","summary":"mysql client not available","confidence":0.0,"signals":[],"recommendedActions":["Install mysql client"]}\n'
  exit 3
fi

# Connection parameters — use environment variables or defaults
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"

# Helper: run a MySQL query and return the result
mysql_query() {
  mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" \
    --skip-column-names --batch -e "$1" 2>/dev/null
}

case "$VERB" in
  health)
    # Test basic connectivity
    if ! mysql_query "SELECT 1" >/dev/null 2>&1; then
      printf '{"status":"unhealthy","summary":"Cannot connect to MySQL at %s:%s","confidence":0.95,"signals":[{"source":"mysql_connection","status":"critical","detail":"Connection refused or authentication failed"}],"recommendedActions":["Verify MySQL is running","Check credentials","Check network connectivity"]}\n' \
        "$MYSQL_HOST" "$MYSQL_PORT"
      exit 2
    fi

    # Check thread usage
    MAX_CONN=$(mysql_query "SHOW VARIABLES LIKE 'max_connections'" | awk '{print $2}')
    CUR_CONN=$(mysql_query "SHOW STATUS LIKE 'Threads_connected'" | awk '{print $2}')
    PCT=$((CUR_CONN * 100 / MAX_CONN))

    SIGNALS="[{\"source\":\"mysql_threads\",\"status\":"
    if [ "$PCT" -ge 90 ]; then
      STATUS="unhealthy"
      SIGNALS="${SIGNALS}\"critical\",\"detail\":\"Thread usage at ${PCT}% (${CUR_CONN}/${MAX_CONN})\"}"
      SUMMARY="Critical: MySQL thread usage at ${PCT}%"
      ACTIONS='["Investigate idle connections","Increase max_connections if appropriate","Check for connection leaks"]'
      EXIT_CODE=2
    elif [ "$PCT" -ge 70 ]; then
      STATUS="recovering"
      SIGNALS="${SIGNALS}\"warning\",\"detail\":\"Thread usage at ${PCT}% (${CUR_CONN}/${MAX_CONN})\"}"
      SUMMARY="Warning: MySQL thread usage at ${PCT}%"
      ACTIONS='["Monitor connection growth","Review connection pool settings"]'
      EXIT_CODE=1
    else
      STATUS="healthy"
      SIGNALS="${SIGNALS}\"healthy\",\"detail\":\"Thread usage at ${PCT}% (${CUR_CONN}/${MAX_CONN})\"}"
      SUMMARY="MySQL connection health normal, thread usage at ${PCT}%"
      ACTIONS='[]'
      EXIT_CODE=0
    fi
    SIGNALS="${SIGNALS}]"

    printf '{"status":"%s","summary":"%s","confidence":0.9,"signals":%s,"recommendedActions":%s}\n' \
      "$STATUS" "$SUMMARY" "$SIGNALS" "$ACTIONS"
    exit "$EXIT_CODE"
    ;;

  diagnose)
    if ! mysql_query "SELECT 1" >/dev/null 2>&1; then
      printf '{"healthy":false,"summary":"Cannot connect to MySQL","findings":[{"id":"conn-1","severity":"critical","title":"Connection failed","detail":"Cannot establish connection to MySQL at %s:%s"}]}\n' \
        "$MYSQL_HOST" "$MYSQL_PORT"
      exit 0
    fi

    MAX_CONN=$(mysql_query "SHOW VARIABLES LIKE 'max_connections'" | awk '{print $2}')
    CUR_CONN=$(mysql_query "SHOW STATUS LIKE 'Threads_connected'" | awk '{print $2}')
    PCT=$((CUR_CONN * 100 / MAX_CONN))

    FINDINGS="["
    HEALTHY=true
    IDX=0

    if [ "$PCT" -ge 70 ]; then
      HEALTHY=false
      IDX=$((IDX + 1))
      SEV="warning"
      [ "$PCT" -ge 90 ] && SEV="critical"
      FINDINGS="${FINDINGS}{\"id\":\"conn-${IDX}\",\"severity\":\"${SEV}\",\"title\":\"High thread usage\",\"detail\":\"${CUR_CONN} of ${MAX_CONN} threads in use (${PCT}%)\"}"
    fi

    FINDINGS="${FINDINGS}]"

    if [ "$HEALTHY" = true ]; then
      SUMMARY="MySQL connection health is normal"
    else
      SUMMARY="MySQL connection pressure detected (${PCT}% thread usage)"
    fi

    printf '{"healthy":%s,"summary":"%s","findings":%s}\n' "$HEALTHY" "$SUMMARY" "$FINDINGS"
    exit 0
    ;;

  plan)
    if ! mysql_query "SELECT 1" >/dev/null 2>&1; then
      printf '{"name":"mysql-restore-connection","description":"Restore MySQL connectivity","steps":[{"id":"mysql-plan-1","description":"Verify MySQL process is running","riskLevel":"routine"},{"id":"mysql-plan-2","description":"Check MySQL error log for crash or shutdown messages","riskLevel":"routine"}]}\n'
      exit 0
    fi

    MAX_CONN=$(mysql_query "SHOW VARIABLES LIKE 'max_connections'" | awk '{print $2}')
    CUR_CONN=$(mysql_query "SHOW STATUS LIKE 'Threads_connected'" | awk '{print $2}')
    PCT=$((CUR_CONN * 100 / MAX_CONN))

    if [ "$PCT" -lt 70 ]; then
      printf '{"name":"mysql-no-action","description":"MySQL connection usage is acceptable, no action needed","steps":[]}\n'
      exit 0
    fi

    STEPS='[{"id":"mysql-plan-1","description":"Identify and kill idle connections older than 8 hours","riskLevel":"routine"}'
    STEPS="${STEPS},{\"id\":\"mysql-plan-2\",\"description\":\"Review application connection pool max-size settings\",\"riskLevel\":\"routine\"}"
    if [ "$PCT" -ge 90 ]; then
      STEPS="${STEPS},{\"id\":\"mysql-plan-3\",\"description\":\"Temporarily increase max_connections\",\"riskLevel\":\"elevated\"}"
    fi
    STEPS="${STEPS}]"

    printf '{"name":"mysql-connection-relief","description":"Reduce MySQL thread pressure","steps":%s}\n' "$STEPS"
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
```

Make it executable:

```bash
chmod +x checks/check-mysql-connection/check.sh
```

### Key Points

**Reading input:** The framework writes a JSON `CheckRequest` to your script's stdin. Parse the `verb` field to determine what to do. The full input structure is:

```json
{
  "verb": "health",
  "target": {
    "name": "my-mysql",
    "kind": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "metadata": {}
  },
  "context": {}
}
```

**Writing output:** Print exactly one JSON object to stdout, then exit. The format depends on the verb (see the wire protocol reference below).

**Exit codes:** The exit code signals overall status to the framework:

| Exit Code | Meaning |
|---|---|
| 0 | OK / healthy |
| 1 | Warning |
| 2 | Critical |
| 3 | Unknown (error, unsupported verb, missing dependency) |

## Step 3: Test Locally

Run a scan to see your check in action:

```bash
# From the project root
npx tsx src/cli/index.ts scan
```

Or if you have the CLI installed:

```bash
crisismode scan
```

The scanner automatically discovers plugins in `./checks/`. Your new check will appear in the scan output alongside the built-in checks.

To test a specific verb manually, you can pipe JSON directly to your script:

```bash
echo '{"verb":"health","target":{"name":"local-mysql","kind":"mysql"}}' | ./checks/check-mysql-connection/check.sh
```

## Wire Protocol Reference

### Input: CheckRequest

Every invocation receives a `CheckRequest` as JSON on stdin:

| Field | Type | Description |
|---|---|---|
| `verb` | `"health" \| "diagnose" \| "plan"` | The operation to perform |
| `target` | `CheckTargetInfo` | Information about the system being checked |
| `context` | `Record<string, unknown>` | Optional caller-provided context |

`CheckTargetInfo` fields:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Target system name |
| `kind` | `string` | Target system kind (e.g., `"mysql"`, `"redis"`) |
| `host` | `string?` | Hostname or IP |
| `port` | `number?` | Port number |
| `metadata` | `Record<string, unknown>?` | Additional metadata |

### Output: health verb

Return a `CheckHealthResult`:

```json
{
  "status": "healthy",
  "summary": "MySQL connection health normal",
  "confidence": 0.9,
  "signals": [
    {
      "source": "mysql_threads",
      "status": "healthy",
      "detail": "Thread usage at 35% (140/400)"
    }
  ],
  "recommendedActions": []
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"healthy" \| "recovering" \| "unhealthy" \| "unknown"` | Overall health status |
| `summary` | `string` | One-line human-readable summary |
| `confidence` | `number` | Confidence in the assessment (0.0 to 1.0) |
| `signals` | `CheckSignal[]?` | Individual health signals |
| `recommendedActions` | `string[]?` | Suggested next steps |

### Output: diagnose verb

Return a `CheckDiagnoseResult`:

```json
{
  "healthy": false,
  "summary": "MySQL connection pressure detected",
  "findings": [
    {
      "id": "conn-1",
      "severity": "warning",
      "title": "High thread usage",
      "detail": "280 of 400 threads in use (70%)"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `healthy` | `boolean` | Whether the system is healthy |
| `summary` | `string` | One-line summary |
| `findings` | `CheckFinding[]` | List of findings with IDs, severities, and details |

Each `CheckFinding` has:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique finding identifier |
| `severity` | `"info" \| "warning" \| "critical"` | Finding severity |
| `title` | `string` | Short finding title |
| `detail` | `string` | Detailed explanation |
| `evidence` | `Record<string, unknown>?` | Optional structured evidence data |

### Output: plan verb

Return a `CheckPlanResult`:

```json
{
  "name": "mysql-connection-relief",
  "description": "Reduce MySQL thread pressure",
  "steps": [
    {
      "id": "mysql-plan-1",
      "description": "Kill idle connections older than 8 hours",
      "riskLevel": "routine"
    },
    {
      "id": "mysql-plan-2",
      "description": "Temporarily increase max_connections",
      "riskLevel": "elevated"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Plan name |
| `description` | `string` | What this plan does |
| `steps` | `CheckPlanStep[]` | Ordered list of recovery steps |

Each `CheckPlanStep` has:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique step identifier |
| `description` | `string` | What this step does |
| `riskLevel` | `"routine" \| "elevated" \| "high" \| "critical"` | Risk level |
| `command` | `string?` | Optional command to execute |
| `rollback` | `string?` | Optional rollback command |

## Using External Check Formats

CrisisMode can consume checks from existing monitoring ecosystems without rewriting them. Set the `format` field in `manifest.json` to tell the framework which adapter to use.

### Nagios Plugin Format

Thousands of Nagios/Icinga/Checkmk plugins exist. Wrap any of them:

**`checks/example-nagios-uptime/manifest.json`:**
```json
{
  "name": "example-nagios-uptime",
  "description": "System uptime and load (Nagios plugin format example)",
  "version": "1.0.0",
  "targetKinds": ["linux", "generic"],
  "verbs": ["health", "diagnose"],
  "executable": "./check.sh",
  "format": "nagios"
}
```

Nagios plugins receive **no stdin**. They output a status line optionally followed by `|` and performance data:

```
OK - Load 0.85 (16 CPUs), up 5d 3h | load=0.85;32;64;0; uptime=445736s;;;;
```

Exit codes: 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN.

The adapter parses the text output and performance data into CrisisMode health signals and diagnose findings automatically. Performance data items that exceed their warn/crit thresholds become findings.

See `checks/example-nagios-uptime/` for a complete working example.

### Goss YAML Assertion Format

[Goss](https://github.com/goss-org/goss) validates system state declaratively using YAML. Wrap it:

**`checks/example-goss-system/manifest.json`:**
```json
{
  "name": "example-goss-system",
  "description": "System state validation via Goss YAML assertions",
  "version": "1.0.0",
  "targetKinds": ["linux", "generic"],
  "verbs": ["health", "diagnose"],
  "executable": "./check.sh",
  "format": "goss"
}
```

**`checks/example-goss-system/goss.yaml`:**
```yaml
file:
  /etc/resolv.conf:
    exists: true
  /etc/hosts:
    exists: true
    contains:
      - "localhost"
command:
  uname -s:
    exit-status: 0
```

**`checks/example-goss-system/check.sh`:**
```bash
#!/usr/bin/env bash
exec goss -g "$(dirname "$0")/goss.yaml" validate --format json
```

Goss plugins receive **no stdin**. They output structured JSON with a `results` array and `summary` object. Failed assertions become diagnose findings; passed assertions are reported as healthy signals.

Use `goss add` to auto-generate assertions from the current system state. See `checks/example-goss-system/` for a complete working example.

### Sensu Check Format

[Sensu](https://sensu.io/) checks use Nagios-compatible exit codes but support additional metric output formats. Set `sensuMetricFormat` in the manifest:

**`checks/example-sensu-metrics/manifest.json`:**
```json
{
  "name": "example-sensu-metrics",
  "description": "System metrics in Prometheus exposition format",
  "version": "1.0.0",
  "targetKinds": ["linux", "generic"],
  "verbs": ["health", "diagnose"],
  "executable": "./check.sh",
  "format": "sensu",
  "sensuMetricFormat": "prometheus_text"
}
```

Supported metric formats:

| Format | `sensuMetricFormat` value | Example line |
|---|---|---|
| Nagios perfdata | `nagios_perfdata` (default) | `label=value;warn;crit;min;max` |
| Graphite plaintext | `graphite_plaintext` | `metric.name value timestamp` |
| InfluxDB line protocol | `influxdb_line` | `measurement,tag=val field=val timestamp` |
| OpenTSDB | `opentsdb_line` | `metric timestamp value tag=val` |
| Prometheus exposition | `prometheus_text` | `metric{label="val"} value [timestamp]` |

Sensu plugins receive **no stdin**. See `checks/example-sensu-metrics/` for a complete working example that emits Prometheus-format metrics.

### Format Reference

| `format` value | Stdin | Output | Adapter |
|---|---|---|---|
| *(unset)* | JSON `CheckRequest` | JSON `CheckResult` | Native CrisisMode protocol |
| `nagios` | None | Status text + optional perfdata | Nagios adapter |
| `goss` | None | `goss validate --format json` output | Goss adapter |
| `sensu` | None | Metric text in the specified format | Sensu adapter |

## Tips

**Portability.** Avoid bash-specific features if you want your check to run on minimal containers. Stick to POSIX shell (`#!/usr/bin/env sh`) where possible, or use `#!/usr/bin/env bash` and document the dependency.

**Error handling.** If your check cannot determine status (missing command, connection refused, parse error), output a result with `"status": "unknown"` and exit with code 3. The scanner treats unknown results gracefully and reports them without penalizing the health score.

**Timeouts.** The default execution timeout is 10 seconds. If your check needs longer (e.g., a slow network query), set `timeoutMs` in your manifest. Keep checks as fast as possible -- they run during every scan.

**No side effects.** Check plugins must be read-only. They should never modify the systems they probe. Even the `plan` verb only *suggests* actions -- it does not execute them.

**Credential handling.** Use environment variables for connection credentials. Never hardcode passwords in check scripts. Document which environment variables your check expects in a comment at the top of the script.

**JSON output.** Output exactly one JSON object on stdout per invocation. Do not print debug output to stdout -- use stderr for debug messages if needed. The framework parses stdout as JSON and will report a parse failure if it contains anything else.

**Testing without the target system.** You can test the structural correctness of your plugin by sending it a request and verifying the output is valid JSON with the expected fields, even if the underlying system is not available (the check should return `"status": "unknown"` or `"status": "critical"` with exit code 2 or 3).
