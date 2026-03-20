# Contributing to CrisisMode

Thank you for your interest in contributing to CrisisMode. This document explains how to get started, what kinds of contributions we are looking for, and the standards your code needs to meet.

CrisisMode is licensed under [Apache 2.0](LICENSE). By contributing, you agree that your contributions will be licensed under the same terms.

## What to Contribute

Contributions fall into three tiers, ordered from lowest to highest barrier to entry.

### Tier 1: Check Plugins (no TypeScript required)

Check plugins are standalone shell scripts that probe a specific system and report health status. They are the fastest way to expand CrisisMode's coverage.

**Examples of checks we would welcome:**

- MySQL connection health and replication status
- MongoDB replica set health
- SSL/TLS certificate expiry
- HTTP endpoint health and latency
- NGINX/HAProxy upstream status
- DNS resolution validation
- NTP clock drift

Each check plugin is a single directory under `checks/` containing a `manifest.json` and an executable script. No TypeScript, no compilation, no framework knowledge required.

See [Creating a Check Plugin](docs/guides/creating-a-check-plugin.md) for a step-by-step tutorial.

### Tier 2: Recovery Agents (TypeScript)

Recovery agents are TypeScript modules that diagnose failures and build validated recovery plans for a specific system. Each agent follows a 6-file pattern and implements the `RecoveryAgent` interface.

**Examples of agents we would welcome:**

- MySQL replication recovery
- MongoDB sharding recovery
- RabbitMQ queue recovery
- Consul service mesh recovery
- Vault seal/unseal recovery
- ElastiCache failover

Building an agent requires understanding the agent contract and the recovery plan structure, but not the framework internals. The framework handles validation, approval workflows, forensic recording, and execution.

See [Creating a Recovery Agent](docs/guides/creating-a-recovery-agent.md) for a guide to the pattern.

### Tier 3: Framework Improvements

Core framework changes touch the execution engine, validator, CLI, safety layer, or coordination logic. These require understanding the full architecture.

**Examples:**

- New recovery step types
- Execution engine improvements
- CLI command enhancements
- Safety validator rules
- Signal source integrations (DataDog, CloudWatch, PagerDuty)

For framework changes, open an issue first to discuss the approach before writing code.

## Development Setup

### Prerequisites

- **Node.js** >= 18 (recommended: [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** -- `npm install -g pnpm`
- **Git**

Optional (required by pre-commit hooks):

- **shellcheck** -- `brew install shellcheck`
- **gitleaks** -- `brew install gitleaks`

### First-Time Setup

```bash
git clone git@github.com:trs-80/crisismode.git
cd crisismode
pnpm install
```

### Verify Everything Works

```bash
pnpm test          # Unit tests (vitest)
pnpm run typecheck # TypeScript compilation check
```

For full development environment details including the containerized test stack, see [GETTING_STARTED.md](GETTING_STARTED.md).

## Pull Request Workflow

### Branch and Fork

1. Fork the repository on GitHub.
2. Create a branch from `main` using the naming convention:
   - `feat/<scope>` -- new features
   - `fix/<scope>` -- bug fixes
   - `docs/<scope>` -- documentation changes

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The commit-msg hook enforces this format.

```
type(scope): description
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`

Examples:

```
feat(agent): add MySQL replication recovery agent
fix(scan): handle timeout in check plugin executor
docs(guides): add check plugin tutorial
test(redis): add memory pressure scenario tests
```

### PR Requirements

All pull requests must:

- **Pass CI** -- typecheck and unit tests run automatically on every PR.
- **Include tests** -- new code needs new tests. See the testing section below.
- **Contain no secrets** -- no API keys, tokens, passwords, or credentials. The gitleaks pre-commit hook catches most of these, but review your changes manually as well.
- **Follow code conventions** -- see below.

### Review Process

Maintainers review pull requests within a few business days. For larger changes, expect discussion about approach and design before approval. Framework-level changes may require multiple rounds of review.

## Code Conventions

These conventions are enforced by CI and pre-commit hooks. For the full list, see the "Code Conventions" and "What NOT to Do" sections in [CLAUDE.md](CLAUDE.md).

- **TypeScript strict mode** with ESM modules (`"type": "module"`).
- **Module resolution is NodeNext** -- all imports must use `.js` extensions, even for `.ts` source files.
- **Named exports only** -- no default exports.
- **Async by default** -- backend interfaces return `Promise<T>`.
- **Type imports** -- use `import type { ... }` for type-only imports.
- **SPDX license header** on all new source files:
  ```typescript
  // SPDX-License-Identifier: Apache-2.0
  // Copyright 2026 CrisisMode Contributors
  ```
- **No hardcoded IPs or hostnames** in agents -- discover infrastructure at diagnosis time.
- **No new dependencies** without considering the spoke's 256Mi memory target.
- **No secrets in code** -- credentials come from environment variables or Kubernetes Secrets at runtime.

## Safety Rules

CrisisMode operates during crises when wrong actions are most costly. The safety rules exist to prevent agents from causing more harm than they fix.

- **Agents propose, the framework disposes.** Agents build recovery plans. The framework validates, gates, and executes them.
- **State preservation is mandatory.** Every `system_action` at `elevated` risk or higher must include `statePreservation.before` captures.
- **Notification is mandatory.** Every plan containing `elevated` or higher risk steps must include a `human_notification` step.
- **Rollback strategies are mandatory.** Every `RecoveryPlan` must declare a `rollbackStrategy`.
- **Blast radius must be declared.** Every `system_action` must specify which components are affected.
- **Step IDs must be unique** within a plan.
- **No nested conditionals.** Conditional steps cannot contain other conditional steps.

These rules are enforced by the validator (`src/framework/validator.ts`). Violations cause plan rejection before any execution occurs.

## Testing Requirements

### Check plugins

- Test your check script manually and include the test commands and expected output in the PR description.
- If your check requires a specific system to be running, document how to set it up.

### Recovery agents

- **Unit tests** for the agent's `assessHealth`, `diagnose`, `plan`, and `replan` methods using the simulator backend.
- **Simulator** that models both healthy and degraded states so the agent can be exercised without real infrastructure.
- Follow the existing test patterns in `src/__tests__/`.
- `pnpm test` and `pnpm typecheck` must pass.

### Framework changes

- Unit tests are required for all framework changes.
- If modifying the validator, add test cases for both valid and invalid plans.
- If modifying the execution engine, test both dry-run and execute paths.
- `pnpm test` and `pnpm typecheck` must pass.

## Getting Help

- **Issues** -- open an issue on GitHub for bugs, feature requests, or questions.
- **Discussions** -- for design discussions or questions about approach, open an issue before writing code.
- **Existing code** -- the Redis agent (`src/agent/redis/`) is a good reference for the full agent pattern, and `checks/check-disk-usage/` is the reference check plugin.
