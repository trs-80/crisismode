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

Full setup — prerequisites, build, the podman test environment, failure
injection, and the project layout — lives in
**[GETTING_STARTED.md](GETTING_STARTED.md)**. The short version:

```bash
git clone https://github.com/trs-80/crisismode.git
cd crisismode
pnpm install && pnpm run build
pnpm run typecheck && pnpm test
npx tsx src/cli/index.ts scan        # run the CLI from source
```

## Your First Contribution

### Check plugin (simplest)

Check plugins are standalone shell scripts. No TypeScript needed.

1. Scaffold with `crisismode init --plugin <name>` (creates the directory,
   `manifest.json`, and a stub `check.sh`), or create a directory in `checks/`
   by hand with a `manifest.json` and a `check.sh`
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
3. Declare `metadata.plugin.maturity` honestly (see below)
4. Register in `src/config/builtin-agents.ts`
5. Add tests in `src/__tests__/`
6. Submit a PR

See the [Your First Agent](docs/guides/your-first-agent.md) tutorial for a step-by-step walkthrough. The PostgreSQL agent at `src/agent/pg-replication/` is the canonical reference implementation.

### Declaring maturity honestly

Your manifest's `metadata.plugin.maturity` is a claim operators rely on during an
incident, so it is the one field never to be optimistic about. Valid values are
`experimental`, `simulator_only`, `dry_run_only`, `live_validated`, and
`production_certified`.

**A new agent is `simulator_only`.** That is not a placeholder to be upgraded when
the code feels finished — CrisisMode's honesty layer
(`src/framework/agent-maturity.ts`) treats everything except `live_validated` as
best-effort and labels its findings as leads rather than conclusions in operator
output. That default is the point.

Only claim `live_validated` when the agent has actually been run against a real
deployment of its target system and diagnosed it correctly, and say in the PR
description what you ran it against. "The live client compiles" is not validation.
The label describes *diagnosis*: a diagnosis-only agent can be `live_validated`
without any mutating run — `src/agent/tls/`, `src/agent/disk/`, and
`src/agent/backup/` are. If your agent has a mutating recovery path and its only
live exposure was dry-run, `dry_run_only` is the accurate label. Whether a
mutating plan ran and the fault was verified resolved is a separate, stricter
claim, tracked under
[Execute-verified recovery](docs/coverage.md#execute-verified-recovery).

Where each agent currently stands is tracked in
[docs/coverage.md](docs/coverage.md) — update it in the same PR that changes a
maturity value.

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
  ```text
  feat(agent): add MySQL recovery agent
  fix(engine): handle timeout in step execution
  test(redis): add memory pressure scenario tests
  docs(guides): add check plugin tutorial
  ```

### Remediation guides (`src/framework/guidance/`)

Guides are the "open this URL, click this, expect that" instructions CrisisMode
shows for fixes it must not perform itself (console actions on managed
platforms). They are static data — one `RemediationGuide` per fix, keyed to the
finding types it answers.

Rules for editing them:

- **`applicableFindingTypes` must name something the codebase emits** — a
  registered readiness rule id (`src/readiness/rules/index.ts`) or an agent
  `checkId` constant. `src/__tests__/guidance-registry.test.ts` fails the build
  otherwise, which is how a renamed rule gets caught instead of silently
  orphaning its guidance.
- **Changing a guide's steps means re-verifying the path.** Open the console,
  follow your own steps, then set `verifiedOn` to the date you did it. A test
  fails when any guide's `verifiedOn` is more than 12 months old, so stale
  paths surface on their own schedule rather than in someone's incident.
- **Re-verification has a guided workflow.** `pnpm run guides:walkthrough`
  generates a per-platform checklist under `docs/guide-verification/` from the
  live registry; walk the consoles, mark each guide `MATCHES` or `DIFFERS`,
  then `pnpm run guides:apply <checklist>` stamps `verifiedOn` for every
  `MATCHES` guide and lists the `DIFFERS` ones for text fixes. No account on
  a platform? Mark its guides `BLOCKED` with a one-line reason — they stay
  unverified on purpose and are reported as a coverage gap needing someone
  with access. Partial passes are fine — re-run `apply` on the same file as
  you go.
- **No account-specific deep links, no screenshots.** Top-level console URLs
  and click paths only — they survive UI changes better and work for every
  reader.
- **Use `<placeholder>` tokens** (`<instance>`, `<db-port>`) for anything
  target-specific; callers substitute them with `applyGuideVariables()`.

## Correlation Rules Are Frozen

`CORRELATION_RULES` in `src/framework/root-cause-synthesis.ts` is a closed set.
**Do not add a correlation rule** unless both of these are true:

1. A new agent class is shipping, and
2. it brings a concretely evidenced signal pairing -- an incident actually
   observed, with both signals named. Not a plausible-sounding story.

No speculative incident templates. Real incidents are combinatorial: every
rule multiplies the interaction surface between rules, and every bug this file
has had came from rules interacting rather than from a rule being individually
wrong.

A rule match means "these signals have co-occurred in this shape before" -- an
investigation hint, not a diagnosis. Output surfaces must render it that way,
and `CorrelationCluster.confidence` is an ordering weight, never a probability.
The same applies to `ADVISORY_RULE_NAMES`, the small set of overlay rules that
answer "is the problem this machine?" and are exempt from the
one-agent-one-cluster de-dup: adding to it is a policy decision, because an
overlay is never suppressed by a stronger cluster.
`CORRELATION_RULE_NAMES` is pinned by a test in
`src/__tests__/root-cause-synthesis.test.ts`; changing the rule set means
updating that test, this section, and the policy header in the source file.

## Testing Requirements

- All new code needs tests
- Run `pnpm test` before submitting
- Run `pnpm run typecheck` to verify type safety
- Build the simulator first -- it enables testing without real infrastructure
- Use the agent test harness (`src/framework/agent-test-harness.ts`) for standardized agent testing
- Follow existing test patterns in `src/__tests__/`

## Validation Beyond Unit Tests

Two harnesses validate CrisisMode against realistic incidents. Changes to
diagnosis, `bundle respond`, or agent behavior should be checked against them:

### Diagnosis eval (14 incident families)

Runs the [sre-incident-agent-skills](https://github.com/Dbochman/sre-incident-agent-skills)
compatibility benchmark against the real CLI:

```bash
# Requires a sibling checkout (or set SRE_SKILLS_REPO to its path)
# and ANTHROPIC_API_KEY for AI-powered runs
pnpm run eval:diagnosis          # Full run, writes eval/reports/
pnpm run eval:diagnosis:gate     # Fails below the 13/14 score gate
```

Re-run the gate after any change to `bundle respond`, diagnosis prompts, or
agent routing. The eval families are defined by the external benchmark — to
add one, contribute to that repo.

### Torture harness (real degraded infrastructure)

Disaster scenarios (inject a real failure, verify detection → diagnosis →
recovery) live in the separate
[crisismode-torture](https://github.com/trs-80/crisismode-torture) repo. To
add a scenario, see "Writing a Scenario" in its README. Reports distinguish
dry-run passes from execute-verified recoveries — a blocked execution is
never counted as a recovery.

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
- **Don't add correlation rules** -- the rule set is frozen; see [Correlation Rules Are Frozen](#correlation-rules-are-frozen)

## Further Reading

- [GETTING_STARTED.md](GETTING_STARTED.md) -- development setup, test environment, project layout
- [Agent Development Guide](docs/guides/creating-a-recovery-agent.md) -- full agent contract, manifest reference, and safety checklist
- [Check Plugin Reference](docs/guides/creating-a-check-plugin.md) -- wire protocol, Nagios/Goss/Sensu adapters
- [Architecture Overview](docs/architecture.md) -- system architecture and key abstractions
- [CLI Reference](docs/cli-reference.md) -- every command, flag, exit code, and output format
- [Coverage & Validation Status](docs/coverage.md) -- what each agent has actually been validated against
- [Recovery Agent Contract](specs/foundational/recovery-agent-contract.md) -- the authoritative specification
- [Plugin Platform Guide](specs/architecture/plugin-platform.md) -- plugin taxonomy and platform architecture
