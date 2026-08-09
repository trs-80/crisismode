# Docs Pass Report — 2026-08-09

Repo-presentation docs pass on branch `chore/repo-presentation`. Goal: make the
repo read well to an employer reviewing it cold, without inflating any claim.

Pre-existing uncommitted edits (Node >= 22 accuracy fixes across the four root
docs) were preserved and extended, not reverted.

## Structure decision

The three-competing-onboarding-paths problem was resolved by **sharply
differentiating** rather than deleting, because the two guides were actually
serving different audiences that had bled into each other. Every concern now has
exactly one home:

| Doc | Audience | Owns |
|---|---|---|
| `README.md` | Cold visitor | What it is, who it's for, install, 60-second demo, honest maturity summary, where to go next |
| `QUICKSTART.md` | Operator using the CLI | Install a binary, first scan, drill in, config, recovery, output modes |
| `GETTING_STARTED.md` | Developer building on it | Clone, build, podman test env, failure injection, project layout, pnpm scripts |
| `CONTRIBUTING.md` | Contributor | Contribution tracks, maturity honesty rule, code standards, testing, PR expectations |
| `docs/cli-reference.md` (new) | Reference lookup | Every command, flag, exit code, output-format contract, `down`, bundles, MCP |
| `docs/coverage.md` (new) | Anyone checking claims | Per-agent maturity, what each harness proves |

Each root doc opens with a one-line pointer to its siblings so a cold reader
routes correctly instead of reading all three.

`README.md` went 477 → 258 lines. Depth moved into the two new `docs/` files
rather than being deleted.

## Honesty corrections

Every one of these was a case where existing text claimed more than the codebase
supports. All were verified against source, not inferred.

### 1. Agent status table overstated live capability (README)

The old table labelled Redis, deploy rollback, DB migration, queue backlog,
config drift, and all three AWS agents as **"Live (execute-capable)"**. Their
manifests declare `maturity: 'simulator_only'`, and CrisisMode's own honesty
layer (`src/framework/agent-maturity.ts`) reports everything except
`live_validated` as best-effort. An employer running `crisismode agent list`
would have seen the README and the tool disagree.

Replaced with the tool's own two-label vocabulary and the real count: **9 of 26
registrations are live-validated** (verified by counting `agent list` output, not
by eye — the first count of 8 was wrong because the LLM-provider agent registers
once per provider).

### 2. `checks/` does not ship with the binary (QUICKSTART)

Old text: scan "Runs bundled check plugins (disk, memory, DNS, HTTP, TLS
certificates)". `package.json` `files` is `dist/**`, `README`, `LICENSE`,
`NOTICE` — `checks/` is not published. A binary or npm user gets **no** check
plugins by default; a real scan from outside the repo prints "No check plugins
found." Softened to state the discovery paths and that the examples live in a
repo checkout.

### 3. `PostgresSaver for production` (docs/architecture.md)

`graph-engine.ts` imports only `MemorySaver` and defaults to it; `PostgresSaver`
appears solely in a source comment. Reworded to "the checkpointer is injectable
and defaults to `MemorySaver`; a durable store is the intended hub deployment but
is not wired up in this repo."

### 4. Vector store maturity (docs/coverage.md)

Given a dedicated call-out rather than a table row, since the table alone would
mislead: `simulator_only`, no real Pinecone or Upstash account ever validated.
The only live checks were invalid-key rejection and secret redaction against the
real Pinecone API; Upstash is simulator/mocked only.

### 5. Smoke-test check counts

`GETTING_STARTED.md` asserted "16 checks" and "6 checks". The scripts compute
`TOTAL` dynamically and I could not run them (no podman session), so I replaced
the hard numbers with "each script prints a `passed/total` tally" rather than
repeat unverified figures.

### 6. Redis execute-verified vs. `simulator_only`

Left as an explicit, labelled tension in `docs/coverage.md` instead of silently
picking a side. Redis memory pressure is execute-verified in the torture harness
(2026-07-13) while its manifest says `simulator_only`. The two claims measure
different things; the doc says so and notes the manifest deliberately makes the
weaker claim.

## Drift fixed

- **Invalid maturity values in both agent guides (3 places).** Guides told readers
  to set `plugin.maturity` to `"beta"` or `"stable"`. Neither is a valid
  `PluginMaturity` — the real set is `experimental`, `simulator_only`,
  `dry_run_only`, `live_validated`, `production_certified`. Fixed, and tied to a
  new CONTRIBUTING section explaining why `simulator_only` is the honest default.
- **`playbook-authoring.md`'s flagship example did not validate.** Verified by
  extracting the fenced block and running it: step 4 lacked `capability`, failing
  with `Missing capabilities on steps: redis-memory-pressure-step-4`. Added
  `capability: cache.expiry.trigger`; the example now passes 13 safety checks
  verbatim from the doc. Also documented where valid capability ids come from,
  since that was the missing information behind the bug.
- **`GETTING_STARTED.md` said "19 agents"** — actual count is 26. Rather than
  re-listing the roster (the redundancy that caused this drift), it now points at
  `crisismode agent list` and `docs/coverage.md`.
- **Missing recent subsystems.** `docs/architecture.md` had no coverage of
  escalation levels, the honesty layer, triage, service-status, or the
  remediation-guidance registry. Added sections for each.
- **New test scripts undocumented:** `inject-pgvector-unindexed.sh`,
  `reset-pgvector.sh`, `test-alert-pipeline.sh`.

## Verification performed

Everything documented was checked at the real surface after `pnpm run build`.

- **Flags:** the complete flag set was taken from `node dist/cli/index.js --help`.
  No invented flags — an audit of every `--flag` across all docs found only
  `--json`, `--target`, `--agent`, all real. (Subcommand `--help` prints the
  global help, so the top-level list is authoritative.)
- **Commands run:** `scan`, `scan --category dns`, `scan --json`/pipe, `triage`,
  `down stripe github`, `down --badflag` (exit 2 confirmed), `agent list`,
  `completions zsh`, `init --agent`, `init --plugin`, `playbook validate`,
  `playbook dry-run`, `diagnose PG-001`, `diagnose default-postgres`.
- **Output-format contracts confirmed against real output:** the 4-field `scan`
  row and 7-field `finding` row (including a populated `guide_refs` cell), and
  the `triage`/`layer` rows.
- **Counts confirmed:** 26 agent registrations, 9 live-validated, 8 MCP tools, 8
  readiness rules, 9 hook points, 12 service-catalog ids, 9 default probe ports.
- **Links:** 0 broken file links and 0 broken anchors across all root docs and
  `docs/**` (excluding `docs/superpowers/`, untouched — 26 files intact). Also
  confirmed nothing in the repo still links to README anchors I removed
  (`#cli-reference`, `#install`, `#validation-status`).

## Two `src/` bugs — found during the audit, fixed in a follow-up

Both were cases where the CLI printed a copy-pasteable command that does not
work. Initially reported as out-of-scope (the docs dispatch excluded `src/`), then
fixed on explicit follow-up instruction.

### 1. Scan suggested a `diagnose` command that fails

`src/cli/incident-summary.ts` emitted
``Investigate: `crisismode diagnose ${first.id}` `` using a finding id such as
`PG-001`. `diagnose` resolves its positional as a **target name**, so the
suggested command died with `Target "PG-001" not found in config`.

The nuance that made this more than a one-liner: `runDiagnose` *does* special-case
`/^PLUG-(\d+)$/i` and route it to a check plugin's diagnose verb by index. So the
old hint was correct for plugin findings and broken for every agent finding — a
blanket replacement would have broken the working half.

Fix: extracted `diagnoseCommandFor(finding)`, which keeps the id for `PLUG-*`,
otherwise uses the target name (the trailing parenthesized group of scan's
`${kind} (${target.name})` service string), and falls back to bare
`crisismode diagnose` when no name is recoverable — never a dead end.

Two existing tests asserted the broken output (`toContain('crisismode diagnose
PG-001')`) using fixtures whose `service` had no parenthesized target, which is
not a shape real scan produces. Fixtures made realistic, assertions corrected, and
6 dedicated tests added for the helper.

### 2. Scan suggested a flag that does not exist

`src/cli/commands/scan.ts` printed
`scaffold one with: crisismode init --plugin my-check`. `--plugin` is not
recognized: it falls through to the positional path argument and writes a *config
file* named `my-check` instead of scaffolding a plugin. Corrected to `--agent`,
which I verified produces `manifest.json` + an executable `check.sh`.

### Verification

`pnpm run typecheck`, `pnpm run lint`, and `pnpm test` (3179 passed / 24 skipped,
0 failures) all clean, then rebuilt and confirmed at the real surface:

- Failing check-plugin fixture → `Investigate: crisismode diagnose PLUG-001`, and
  that command runs the plugin's diagnose verb.
- PostgreSQL target on a wrong port → `Investigate: crisismode diagnose prod-db`,
  and `diagnose prod-db` resolves (`Target: prod-db (postgresql)`) while the old
  `diagnose PG-001` still errors.
- Scan with no plugins discovered → hint now reads `crisismode init --agent my-check`.

## Noted, not changed

`specs/foundational/recovery-agent-contract.md` was not modified. An anchor there
initially looked broken but is valid — GitHub's em-dash slugging produces the
double hyphen the link uses.

## Not drifted

Audited and found accurate, so left alone: `docs/readiness.md` (already the
strongest honesty document in the repo — 8 rules, thresholds, and its uncovered
validation paths all verified correct), the check-plugin wire protocol in
`docs/guides/your-first-check-plugin.md` (matches the live scaffold's manifest
and verb handling), and `docs/agents/backup-verification.md` (all commands valid).
