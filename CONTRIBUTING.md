# Contributing to CrisisMode

CrisisMode is built to be extended. Whether you are adding a health check for a system you operate, codifying a runbook your team uses during incidents, or building a full recovery agent, there is a contribution path for you.

## Ways to Contribute

Choose based on what you need and how much time you have:

| Contribution | What it is | Skill required | Time | Guide |
|---|---|---|---|---|
| **Check plugin** | A shell script that probes a system and reports health | Bash | 30 min | [Your First Check Plugin](docs/guides/your-first-check-plugin.md) |
| **Playbook** | A Markdown runbook that compiles to a recovery plan | Markdown + YAML | 1 hour | [Playbook Authoring Guide](docs/playbook-authoring.md) |
| **Recovery agent** | A TypeScript module with programmatic diagnosis and planning | TypeScript | Half day | [Your First Agent](docs/guides/your-first-agent.md) |
| **Core framework** | Changes to the execution engine, validator, or safety layers | TypeScript | Varies | Requires discussion -- open an issue first |

**Not sure which to pick?**

- You want to add monitoring for a system? Start with a **check plugin**.
- You have a step-by-step recovery procedure? Write a **playbook**.
- You need dynamic diagnosis that builds different plans for different failures? Build an **agent**.
- You want to change how plans are validated or executed? That is **core framework** -- open an issue to discuss the approach before writing code.

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+

### Quick start

```bash
git clone <repo-url>
cd crisismode
pnpm install
pnpm run typecheck    # Verify types
pnpm test             # Run unit tests
```

### Running the CLI

```bash
npx tsx src/cli/index.ts scan        # Health scan
npx tsx src/cli/index.ts demo        # Simulator demo
npx tsx src/cli/index.ts diagnose    # AI-powered diagnosis
```

### Test environment

For testing against real infrastructure:

```bash
./test/podman/scripts/start.sh       # Start PG, Prometheus, etc.
./test/smoke/run-all.sh              # Validate the test environment
pnpm run live                        # Dry-run against test PG
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for full setup instructions.

## Your First Contribution

### Check plugin (simplest)

Check plugins are standalone shell scripts. No TypeScript needed.

1. Create a directory in `checks/` with a `manifest.json` and a `check.sh`
2. Test with `crisismode scan`
3. Submit a PR

See the [Your First Check Plugin](docs/guides/your-first-check-plugin.md) tutorial for a complete walkthrough. Browse `checks/` for examples.

### Playbook

Playbooks are Markdown files with YAML frontmatter and structured steps.

1. Create a `.md` file in `playbooks/`
2. Validate with `crisismode playbook validate`
3. Preview with `crisismode playbook dry-run`
4. Submit a PR

See the [Playbook Authoring Guide](docs/playbook-authoring.md) for the format reference and a complete example.

### Recovery agent

Agents are TypeScript modules that follow the 6-file pattern (`backend.ts`, `simulator.ts`, `live-client.ts`, `manifest.ts`, `agent.ts`, `registration.ts`).

1. Build the simulator first -- it enables testing without real infrastructure
2. Implement `assessHealth`, `diagnose`, `plan`, `replan`
3. Register in `src/config/builtin-agents.ts`
4. Add tests in `src/__tests__/`
5. Submit a PR

See the [Your First Agent](docs/guides/your-first-agent.md) tutorial for a step-by-step walkthrough. The PostgreSQL agent at `src/agent/pg-replication/` is the canonical reference implementation.

## Code Standards

- **TypeScript strict mode** with ESM modules (`"type": "module"`)
- **`.js` extensions** on all imports (NodeNext module resolution)
- **Named exports only** -- no default exports
- **Async by default** -- backend interfaces return `Promise<T>`
- **Type imports** -- use `import type { ... }` for type-only imports
- **SPDX license header** on all new source files:
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **Conventional Commits** for all commit messages:
  ```
  feat(agent): add MySQL recovery agent
  fix(engine): handle timeout in step execution
  test(redis): add memory pressure scenario tests
  docs(guides): add check plugin tutorial
  ```

## Testing Requirements

- All new code needs tests
- Run `pnpm test` before submitting
- Run `pnpm run typecheck` to verify type safety
- Build the simulator first -- it enables testing without real infrastructure
- Use the agent test harness (`src/framework/agent-test-harness.ts`) for standardized agent testing
- Follow existing test patterns in `src/__tests__/`

## PR Review Expectations

When you open a pull request:

- **Title:** Use Conventional Commits format (e.g., `feat(agent): add website health agent`)
- **Description:** Explain what the PR does and why. For agents, describe the failure scenarios it handles.
- **Tests:** Include tests that run against the simulator. Live infrastructure tests are welcome but not required for initial contributions.
- **Scope:** Keep PRs focused. One check plugin, one playbook, or one agent per PR. Core framework changes should be discussed in an issue before implementation.
- **Review turnaround:** Maintainers aim to review within a few business days. Complex PRs (agents, framework changes) may take longer.

### What reviewers look for

- **Safety:** Does the agent respect risk levels? Are `statePreservation` captures in place for elevated+ actions?
- **Simulator quality:** Does the simulator model realistic state transitions? Does it cover degraded, recovering, and recovered states?
- **Manifest accuracy:** Does the manifest declare the correct `maxRiskLevel`, `targetSystems`, and `failureScenarios`?
- **Test coverage:** Do tests exercise the main diagnosis scenarios and plan generation?
- **No hardcoded infrastructure:** Agents must discover infrastructure at diagnosis time, not hardcode IPs or hostnames.

## What NOT to Do

- **Don't weaken safety layers** -- every `system_action` at `elevated` risk or higher must have state preservation captures
- **Don't add unnecessary dependencies** -- spokes target 256Mi memory; every dependency counts
- **Don't hardcode IPs or hostnames** -- discover infrastructure at diagnosis time
- **Don't store secrets in code** -- credentials come from environment variables or K8s Secrets
- **Don't modify hub code** -- hub coordination is managed separately
- **Don't skip pre-commit hooks** -- they enforce safety invariants
- **Don't create agents with `maxRiskLevel: 'critical'`** without explicit discussion

## Further Reading

- [Agent Development Guide](docs/guides/creating-a-recovery-agent.md) -- full agent contract, manifest reference, and safety checklist
- [Check Plugin Reference](docs/guides/creating-a-check-plugin.md) -- wire protocol, Nagios/Goss/Sensu adapters
- [Architecture Overview](docs/architecture.md) -- system architecture and key abstractions
- [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md) -- the authoritative specification
- [Plugin Platform Guide](specs/architecture/plugin-platform.md) -- plugin taxonomy and platform architecture
