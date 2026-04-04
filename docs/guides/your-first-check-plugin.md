# Your First Check Plugin

You can add health checks to CrisisMode with a simple shell script. No TypeScript, no compilation, no framework internals. If you can write a bash script that talks to your system, you can write a check plugin.

This tutorial walks through building a check plugin from scratch. You will create a plugin that checks whether a TCP port is accepting connections -- useful for verifying that a service is running and reachable.

**Time:** 20-30 minutes

**Prerequisites:** A Unix-like system with `bash` and a CrisisMode checkout.

For the full wire protocol reference and advanced topics (Nagios, Goss, and Sensu format adapters), see the [Check Plugin Reference](creating-a-check-plugin.md).

## How Check Plugins Work

A check plugin is a standalone executable that:

1. Receives a JSON request on **stdin** with a verb (`health`, `diagnose`, or `plan`)
2. Probes a system and determines its status
3. Prints a JSON result to **stdout**
4. Exits with a status code: `0` (OK), `1` (warning), `2` (critical), `3` (unknown)

The CrisisMode scanner discovers plugins at startup, runs them during `crisismode scan`, and incorporates their results into the health report.

## Step 1: Create the Plugin Directory

Each check plugin lives in its own directory with two files: a manifest and a script.

```bash
mkdir -p checks/check-port-open
```

## Step 2: Write the Manifest

Create `checks/check-port-open/manifest.json`:

```json
{
  "name": "check-port-open",
  "description": "Checks whether a TCP port is accepting connections",
  "version": "1.0.0",
  "targetKinds": ["application", "generic"],
  "verbs": ["health", "diagnose"],
  "executable": "./check.sh"
}
```

The manifest tells CrisisMode what this plugin does and how to run it.

**Required fields:**

| Field | Description |
|---|---|
| `name` | Unique plugin name. Convention: `check-<system>-<aspect>`. |
| `description` | Shown in scan output and `crisismode agent list`. |
| `version` | Semver version string. |
| `targetKinds` | System kinds this plugin checks. Use `"generic"` if the check can run on any system. |
| `verbs` | Which verbs this plugin supports: `"health"`, `"diagnose"`, `"plan"`. Start with a subset -- you can add more later. |
| `executable` | Path to the script, relative to the plugin directory. |

**Optional fields:** `maxRiskLevel`, `timeoutMs` (default 10000), `author`, `license`.

## Step 3: Write the Check Script

Create `checks/check-port-open/check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# check-port-open: Checks whether a TCP port is accepting connections
#
# Environment variables:
#   CHECK_HOST  — host to check (default: from stdin target, or 127.0.0.1)
#   CHECK_PORT  — port to check (default: from stdin target, or 8080)
#
# Stdin:  JSON CheckRequest
# Stdout: JSON CheckResult
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

# ── Read the request ──

INPUT=$(cat)
VERB=$(printf '%s' "$INPUT" | sed -n 's/.*"verb" *: *"\([^"]*\)".*/\1/p' | head -1)

# Target info can come from the request or from environment variables
REQ_HOST=$(printf '%s' "$INPUT" | sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' | head -1)
REQ_PORT=$(printf '%s' "$INPUT" | sed -n 's/.*"port" *: *\([0-9]*\).*/\1/p' | head -1)

HOST="${CHECK_HOST:-${REQ_HOST:-127.0.0.1}}"
PORT="${CHECK_PORT:-${REQ_PORT:-8080}}"

# ── Helper: test TCP connectivity ──

check_port() {
  # Use bash built-in /dev/tcp, fall back to nc
  if (echo >/dev/tcp/"$HOST"/"$PORT") 2>/dev/null; then
    return 0
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w 3 "$HOST" "$PORT" 2>/dev/null
    return $?
  else
    return 1
  fi
}

# ── Handle verbs ──

case "$VERB" in
  health)
    if check_port; then
      printf '{"status":"healthy","summary":"Port %s is open on %s","confidence":0.95,"signals":[{"source":"tcp_connect","status":"healthy","detail":"TCP connection to %s:%s succeeded"}],"recommendedActions":[]}\n' \
        "$PORT" "$HOST" "$HOST" "$PORT"
      exit 0
    else
      printf '{"status":"unhealthy","summary":"Port %s is not reachable on %s","confidence":0.9,"signals":[{"source":"tcp_connect","status":"critical","detail":"TCP connection to %s:%s failed"}],"recommendedActions":["Verify the service is running","Check firewall rules","Check network connectivity"]}\n' \
        "$PORT" "$HOST" "$HOST" "$PORT"
      exit 2
    fi
    ;;

  diagnose)
    START_NS=$(date +%s%N 2>/dev/null || echo "0")

    if check_port; then
      END_NS=$(date +%s%N 2>/dev/null || echo "0")
      if [ "$START_NS" != "0" ] && [ "$END_NS" != "0" ]; then
        LATENCY_MS=$(( (END_NS - START_NS) / 1000000 ))
      else
        LATENCY_MS=-1
      fi

      printf '{"healthy":true,"summary":"Port %s is open on %s (connect time: %sms)","findings":[{"id":"port-open","severity":"info","title":"Port reachable","detail":"TCP connection to %s:%s succeeded in %sms"}]}\n' \
        "$PORT" "$HOST" "$LATENCY_MS" "$HOST" "$PORT" "$LATENCY_MS"
    else
      printf '{"healthy":false,"summary":"Port %s is not reachable on %s","findings":[{"id":"port-closed","severity":"critical","title":"Port unreachable","detail":"Cannot establish TCP connection to %s:%s. The service may be down, the port may be firewalled, or the host may be unreachable."}]}\n' \
        "$PORT" "$HOST" "$HOST" "$PORT"
    fi
    exit 0
    ;;

  *)
    printf '{"status":"unknown","summary":"Unsupported verb: %s","confidence":0.0,"signals":[],"recommendedActions":[]}\n' "$VERB"
    exit 3
    ;;
esac
```

Make the script executable:

```bash
chmod +x checks/check-port-open/check.sh
```

### What this script does

1. **Reads the JSON request** from stdin and extracts the `verb`, `host`, and `port` fields.
2. **Tests TCP connectivity** using bash's `/dev/tcp` built-in (or `nc` as a fallback).
3. **Returns a JSON result** describing what it found, with an appropriate exit code.

## Step 4: Test It

### Manual test

Pipe a JSON request directly to the script:

```bash
echo '{"verb":"health","target":{"name":"local-service","kind":"application","host":"127.0.0.1","port":22}}' \
  | ./checks/check-port-open/check.sh
```

If SSH is running locally, you should see:

```json
{"status":"healthy","summary":"Port 22 is open on 127.0.0.1","confidence":0.95,...}
```

Try a port that is not open:

```bash
echo '{"verb":"health","target":{"name":"nothing","kind":"application","host":"127.0.0.1","port":59999}}' \
  | ./checks/check-port-open/check.sh
echo "Exit code: $?"
```

You should see `"status":"unhealthy"` and exit code `2`.

### Test with the scanner

Run `crisismode scan` from the project root. The scanner automatically discovers plugins in `./checks/`:

```bash
npx tsx src/cli/index.ts scan
```

Your new check appears alongside the built-in checks in the scan output.

### Test the diagnose verb

```bash
echo '{"verb":"diagnose","target":{"name":"local-ssh","kind":"application","host":"127.0.0.1","port":22}}' \
  | ./checks/check-port-open/check.sh
```

## Step 5: Install for Global Use

To make your check available across all projects on your machine, copy it to the user plugin directory:

```bash
mkdir -p ~/.crisismode/checks/
cp -r checks/check-port-open ~/.crisismode/checks/
```

CrisisMode discovers plugins from three locations, in order:

1. `~/.crisismode/checks/` -- user-installed plugins
2. `./checks/` -- project-local plugins
3. Paths in the `CRISISMODE_CHECK_PATH` environment variable (colon-separated)

## Adding a `plan` Verb

Once your check can detect problems, you can add a `plan` verb that suggests recovery steps. Update your manifest to include `"plan"` in the `verbs` array, then add a `plan)` case to your script:

```bash
  plan)
    if check_port; then
      printf '{"name":"port-no-action","description":"Port is already open, no action needed","steps":[]}\n'
      exit 0
    fi

    printf '{"name":"port-recovery","description":"Restore service on port %s","steps":[{"id":"port-1","description":"Check if the service process is running","riskLevel":"routine"},{"id":"port-2","description":"Restart the service","riskLevel":"elevated","command":"systemctl restart my-service","rollback":"systemctl stop my-service"}]}\n' "$PORT"
    exit 0
    ;;
```

Plan steps are suggestions -- CrisisMode validates them against the safety rules before any execution occurs.

## Sharing Your Plugin

To share a check plugin with others:

1. Publish the plugin directory (containing `manifest.json` and the executable) to a git repository, package registry, or tarball.
2. Users install by copying the directory to `~/.crisismode/checks/`.
3. To include your plugin in the CrisisMode built-in catalog, open a PR adding it to `checks/` and registering it in `src/config/check-registry.json`.

## Key Rules

- **No side effects.** Check plugins must be read-only. Even the `plan` verb only suggests actions -- it does not execute them.
- **One JSON object on stdout.** Do not print debug output to stdout. Use stderr for diagnostics.
- **Exit codes matter.** The framework uses exit codes to determine overall health: `0`=OK, `1`=warning, `2`=critical, `3`=unknown.
- **No hardcoded credentials.** Use environment variables for connection details. Document which variables your check expects.
- **Keep it fast.** Checks run during every scan. The default timeout is 10 seconds.

## Next Steps

- Read the [Check Plugin Reference](creating-a-check-plugin.md) for the full wire protocol, all output formats, and Nagios/Goss/Sensu adapter support.
- Browse `checks/` for built-in examples: disk usage, certificate expiry, DNS resolution, HTTP endpoints, memory usage.
- If your check needs to trigger automated recovery, consider writing a [recovery agent](your-first-agent.md) or a [playbook](../playbook-authoring.md) instead.
