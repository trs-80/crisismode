# CLI Reference

Every command, flag, exit code, and output-format contract. Run
`crisismode --help` for the same command list from the binary itself.

From a source checkout, substitute `node dist/cli/index.js` (after
`pnpm run build`) or `npx tsx src/cli/index.ts` for `crisismode`.

## Commands

### Diagnosis and recovery

| Command | What it does |
|---|---|
| `crisismode` | Zero-config health scan — the default when no command is given |
| `crisismode scan` | Health scan with a 0–100 score, findings, and next-action hints |
| `crisismode diagnose [<target>]` | Health check plus diagnosis (read-only). The positional is a **target name** from config (`--target` is equivalent), except that a `PLUG-<n>` finding id is routed to that check plugin's diagnose verb |
| `crisismode recover` | Full recovery flow. Dry-run unless `--execute` |
| `crisismode status` | Quick health probe |
| `crisismode ask "<question>"` | Natural-language AI diagnosis |
| `crisismode ask` | Interactive diagnostic REPL |

### Localization and outlook

| Command | What it does |
|---|---|
| `crisismode triage` | Is the problem this machine, its network, or the remote services? Offline. Exits 1 on `local`/`network`/`mixed` |
| `crisismode down [<service>...]` | Is it down for everyone, or just me? Bare form checks the config's `services:` list. Exits 0/1, or 2 on bad usage |
| `crisismode readiness` | Scale-readiness report (read-only): will this stack break under load, and where are the capacity ceilings? See [readiness.md](readiness.md) |

### Setup and operation

| Command | What it does |
|---|---|
| `crisismode init [path]` | Generate `crisismode.yaml` |
| `crisismode init --plugin <name>` | Scaffold a check plugin (`--agent` is a deprecated alias) |
| `crisismode demo` | Simulator demo — full pipeline, no infrastructure |
| `crisismode webhook` | Start a webhook receiver for Prometheus AlertManager |
| `crisismode watch` | Continuous shadow observation |
| `crisismode mcp` | Start the MCP server on stdio (read-only tools) |
| `crisismode completions bash\|zsh\|fish` | Generate shell completions |

### Subcommand groups

| Command | What it does |
|---|---|
| `crisismode agent list` | All registered agents with maturity labels |
| `crisismode agent info <name>` | One agent's targets, risk profile, and maturity |
| `crisismode playbook list` | Discovered playbooks |
| `crisismode playbook validate <path>` | Validate a playbook and its compiled plan |
| `crisismode playbook dry-run <path>` | Preview the compiled recovery plan |
| `crisismode bundle ingest <path\|->` | Read-only AI diagnosis of an SRE evidence bundle (v1) |
| `crisismode bundle respond <path\|->` | Emit AdapterResponse v1 |
| `crisismode bundle execute <path\|->` | Translate a bundle into a RecoveryPlan (dry-run) |
| `crisismode registry list` | Available check plugins |
| `crisismode registry search <query>` | Search check plugins |
| `crisismode registry install <name>` | Install a check plugin |

## Flags

This is the complete set — there are no per-command flags beyond these.

| Flag | Applies to | Effect |
|---|---|---|
| `--config <path>` | all | Path to `crisismode.yaml` |
| `--target <name>` | all | Target name from config |
| `--category <kinds>` | `scan` | Comma-separated service kinds to scan |
| `--plugin <name>` | `init` | Scaffold a check plugin instead of a config file |
| `--agent <name>` | `init` | Deprecated alias for `--plugin`. Still scaffolds, prints a deprecation notice; `--plugin` wins if both are given |
| `--execute` | `recover`, `webhook` | Enable mutations. Without it, everything is dry-run |
| `--health-only` | `recover` | Health check only, no diagnosis |
| `--local` | `registry install` | Install to `./checks/` instead of `~/.crisismode/checks/` |
| `--force` | `registry install` | Overwrite an existing plugin installation |
| `--terse` | all | Suppress plain-language explanations and risk framing. Human output only — `--json` always carries the full data |
| `--json` | all | Machine-readable JSON output |
| `--no-color` | all | Disable colored output |
| `--verbose` | all | Additional detail |
| `-h`, `--help` | all | Show help |
| `-v`, `--version` | all | Show version |

## Exit codes

Most commands exit 0 on success and non-zero when they fail to run. Two
commands use the exit code to carry a *verdict*, so they can be used in scripts
and CI:

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `triage` | verdict is `healthy` or `remote` | verdict is `local`, `network`, or `mixed` | — |
| `down` | nothing checked looks like a problem | at least one service does | the command was called wrong (unrecognized flag) — the only CrisisMode command that does this |

## Output modes

Three modes, auto-selected:

- **human** (default on a TTY) — colored, emoji severity indicators, and
  plain-language explanations. Suppress the explanations with `--terse`.
- **pipe** (auto-detected when stdout is not a TTY) — plain text, no ANSI,
  tab-separated.
- **machine** (`--json`) — JSON Lines with metadata.

### Pipe format

`crisismode scan` emits tab-separated rows, stable enough to feed `cut`/`awk`.

A `scan` row has 4 fields:

```text
scan\t<score>\t<scanned_at>\t<duration_ms>
```

Every `finding` row has the same 7 fields, whether or not the finding has a
remediation guide, so the column count never shifts:

```text
finding\t<id>\t<service>\t<status>\t<confidence>\t<summary>\t<guide_refs>
```

| # | Field | Notes |
|---|---|---|
| 1 | `finding` | Literal row-type marker |
| 2 | `id` | Finding id, e.g. `PG-001` |
| 3 | `service` | e.g. `postgresql (default-postgres)` |
| 4 | `status` | `healthy` / `recovering` / `unhealthy` / `unknown` |
| 5 | `confidence` | 0–1 |
| 6 | `summary` | Free text; tabs and newlines are stripped so they can't shift later columns |
| 7 | `guide_refs` | `guide:<id>[,<id>...]`, empty when no remediation guide matched |

`triage` uses the same shape with a `triage` row and one `layer` row per probe:

```text
triage\t<verdict>\t<checked_at>\t<duration_ms>
layer\t<name>\t<result>\t<evidence>
```

### JSON format

`--json` emits **JSON Lines** — one object per line, not a single document. Each
line carries a `type`:

| Type | Contents |
|---|---|
| `health` | Health assessment with `status` and a `signals` array |
| `diagnosis` | Diagnosis with `scenario`, `confidence`, and root cause |
| `plan` | Recovery plan with a `steps` array |
| `triage` | Localization verdict (`local`/`network`/`remote`/`mixed`/`healthy`) with per-layer results |
| `readiness` | Scale-readiness report, fields spread at the top level (no sub-key) |

```bash
# Human-readable inspection
crisismode recover --target my-db --json | jq 'select(.type == "diagnosis")'

# Just the plan steps
crisismode recover --target my-db --json | jq 'select(.type == "plan") | .plan.steps'

# Readiness verdict only
crisismode readiness --json | jq 'select(.type == "readiness") | .verdict'
```

## Third-party service checks (`down`)

`crisismode down` keeps two facts separate: what the provider's own status page
reports, and whether *this machine* can reach it. A status-page hiccup is never
reported as an outage. Read-only — escalation level 2 (Diagnose).

```bash
crisismode down stripe github
```

```text
  ✅ Stripe (healthy)
      Stripe is healthy and reachable.
  ✅ GitHub (healthy)
      GitHub is healthy and reachable.
```

Accepted arguments:

- **Catalog ids** — `stripe`, `github`, `vercel`, `netlify`, `supabase`,
  `cloudflare`, `npm`, `twilio`, `sendgrid`, `render`, `fly`, `upstash`
- **Aliases** — e.g. `flyio` → `fly`
- **Raw domains** — reachability only, since there's no known status page. A
  `down` verdict there means "can't reach it," not "provider incident"
- **`anthropic` / `openai`** — routed through the LLM Provider agent's own status
  source. Ad-hoc only; see the config note below

### Standing list in config

Run bare `crisismode down` to check a configured list. A `services:` block is
valid on its own — no `targets:` required:

```yaml
apiVersion: crisismode/v1
kind: SiteConfig
metadata:
  name: my-stack
services:
  - stripe
  - example.com
```

Each entry is a catalog id/alias, a raw domain, or `{ host, port }` for a
non-default port.

`anthropic` and `openai` are **rejected** here with a config validation error.
They're already covered by the LLM Provider agent in `scan`/`watch` whenever the
matching API key is set. Listing them under `services:` would make CrisisMode DNS-probe
the literal hostname instead of reading the provider's real status source — a
strictly worse check, so it's refused rather than silently accepted.

## Evidence bundles

CrisisMode speaks the SRE evidence-bundle v1 format, so external incident tooling
can hand it a bundle (logs, metrics, operator notes) and get a diagnosis back.

| Command | Output |
|---|---|
| `bundle ingest` | Read-only AI diagnosis of the evidence |
| `bundle respond` | AdapterResponse v1: ranked hypotheses with evidence citations, actions gated by action-class policy, and explicit abstention when evidence is insufficient |
| `bundle execute` | A validated RecoveryPlan (dry-run) |

All three take a file path or `-` for stdin:

```bash
cat incident-bundle.json | crisismode bundle respond -
```

## MCP server

`crisismode mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io)
server on stdio.

```bash
claude mcp add crisismode -- crisismode mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "crisismode": { "command": "crisismode", "args": ["mcp"] }
  }
}
```

All 8 tools are read-only and annotated `readOnlyHint: true` — the MCP surface
never mutates infrastructure:

| Tool | What it does |
|---|---|
| `crisismode_scan` | Zero-config health scan with a 0–100 score and per-service findings |
| `crisismode_diagnose` | Health assessment plus diagnosis for one target (AI-powered with `ANTHROPIC_API_KEY`, rule-based otherwise) |
| `crisismode_status` | Quick UP/DOWN probe of configured or detected services |
| `crisismode_list_agents` | The registered recovery agent roster with maturity labels |
| `crisismode_bundle_ingest` | Read-only diagnosis of an SRE evidence bundle (v1) |
| `crisismode_bundle_respond` | Ranked hypotheses with evidence citations and policy-gated actions |
| `crisismode_bundle_plan` | Translate a bundle into a dry-run RecoveryPlan (returned, never executed) |
| `crisismode_readiness` | Scale-readiness report including capacity ceilings and the conditional weak-link verdict — see [readiness.md](readiness.md) |

## Check plugin ecosystem

CrisisMode consumes external health checks through an adapter layer, so existing
checks work without a rewrite:

- **Native check plugins** — JSON wire protocol for purpose-built checks
- **Nagios / Icinga / Checkmk plugins** — thousands of existing infrastructure checks
- **Goss** — declarative YAML system-state assertions
- **Sensu checks** — Graphite, InfluxDB, OpenTSDB, and Prometheus metric formats

Discovered from `~/.crisismode/checks/`, `./checks/`, or `$CRISISMODE_CHECK_PATH`
(colon-separated). See
[Your First Check Plugin](guides/your-first-check-plugin.md) to write one, and the
[check plugin reference](guides/creating-a-check-plugin.md) for the wire protocol
and adapters.

## See also

- [QUICKSTART.md](../QUICKSTART.md) — guided first run
- [coverage.md](coverage.md) — what each agent has actually been validated against
- [readiness.md](readiness.md) — the readiness rules, ceilings, and honesty contract
- [architecture.md](architecture.md) — how the engine, safety layers, and plugins fit together
