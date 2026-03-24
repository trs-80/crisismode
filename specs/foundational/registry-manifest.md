# Agent/Playbook Registry Manifest

**Status:** foundational
**Author:** Aaron Johnson

## Purpose

The `crisismode-agent.json` manifest file lives in the root of any published agent or playbook package. It enables local discovery by the spoke runtime and provides the foundation for a future remote registry.

## Manifest Format

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique agent/playbook name (e.g. `gpu-memory-recovery`) |
| `version` | string | yes | Semver version (e.g. `1.0.0`) |
| `description` | string | yes | Human-readable description |
| `kind` | string | yes | `agent` or `playbook` |
| `entryPoint` | string | yes (agents) | Relative path to module exporting `AgentRegistration` |
| `targetKinds` | string[] | yes | Infrastructure types this targets (e.g. `["postgresql", "redis"]`) |
| `riskProfile` | object | no | `{ maxRiskLevel: RiskLevel, dataLossPossible: boolean }` |
| `author` | string | no | Package author |
| `license` | string | no | SPDX license identifier |
| `repository` | string | no | Source repository URL |
| `crisismode.minVersion` | string | yes | Minimum compatible spoke version |
| `crisismode.sdkVersion` | string | no | `@crisismode/agent-sdk` version used to build this package |

## Discovery Locations

The spoke scans these locations in order. Later sources shadow earlier ones by name.

1. **User directory:** `~/.crisismode/agents/` — user-installed plugins
2. **Project directory:** `./agents/` — project-local plugins
3. **Environment variable:** `CRISISMODE_AGENT_PATH` (colon-separated paths)
4. **npm packages:** `node_modules/@crisismode/` — npm-installed agent packages

Each subdirectory containing a valid `crisismode-agent.json` is registered as a plugin.

## Validation Rules

- `name`, `version`, `description`, `kind`, `targetKinds`, and `crisismode.minVersion` are required
- `kind` must be `agent` or `playbook`
- `entryPoint` is required when `kind` is `agent`
- `version` and `crisismode.minVersion` must be valid semver strings
- `targetKinds` must be a non-empty array of strings

## Example Manifest

```json
{
  "name": "gpu-memory-recovery",
  "version": "0.1.0",
  "description": "Detects and recovers from GPU out-of-memory conditions in ML training workloads.",
  "kind": "agent",
  "entryPoint": "./dist/registration.js",
  "targetKinds": ["nvidia-gpu"],
  "riskProfile": {
    "maxRiskLevel": "elevated",
    "dataLossPossible": false
  },
  "author": "ML Infra Team",
  "license": "Apache-2.0",
  "repository": "https://github.com/example/crisismode-gpu-agent",
  "crisismode": {
    "minVersion": "0.3.0",
    "sdkVersion": "0.1.0"
  }
}
```

## Relationship to Built-in Agents

Built-in agents (shipped with CrisisMode) are registered via `src/config/builtin-agents.ts` and do not require a `crisismode-agent.json`. The manifest format is for community and third-party packages only. Both built-in and plugin agents appear together in `crisismode agent list`.
