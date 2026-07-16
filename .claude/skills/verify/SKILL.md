---
name: verify
description: Build, launch, and drive the crisismode CLI end-to-end to verify a change at its real surface (not tests/typecheck)
---

# Verifying crisismode changes at the CLI surface

The distributed artifact is the esbuild bundle. Always rebuild it first —
`eval:diagnosis` and manual runs both execute the bundle, and a stale bundle
has produced false verification results before:

```bash
pnpm run build:bundle          # ~300ms; writes dist/crisismode.bundle.cjs
BUNDLE=$PWD/dist/crisismode.bundle.cjs
```

`npx tsx src/cli/index.ts <cmd>` also works for source-level runs, but tsx
needs an IPC socket that sandboxed shells block (EPERM on *.pipe) — run it
unsandboxed or prefer the bundle.

## Flows worth driving

```bash
node $BUNDLE agent list                # loads all 19 manifests
node $BUNDLE agent info dns-recovery   # renders one manifest's metadata
node $BUNDLE scan --json               # machine mode: JSONL {type, ...} records
node $BUNDLE diagnose                  # config resolution + health assessment
timeout 10 node $BUNDLE watch          # continuous mode; runs forever without timeout
node $BUNDLE ask "one-sentence question"   # live AI call (needs ANTHROPIC_API_KEY)
node $BUNDLE playbook dry-run playbooks/examples/pg-replication-lag.md
```

## Config-resolution paths (pick the one the change touches)

- **File config:** `--config <path>` or `./crisismode.yaml` → label `Config: <path>`
- **Env fallback:** no file → PG_HOST/PG_USER/etc. defaults (localhost) → label
  `Config: env-var fallback`. This path almost always succeeds, so…
- **Detection fallback:** to force the "No configuration found, scanning
  localhost..." branch, point at a missing file:
  `CRISISMODE_CONFIG=/nonexistent/nope.yaml node $BUNDLE diagnose`
- Run no-config cases from `mktemp -d` so a stray ./crisismode.yaml can't leak in.

## Gotchas

- This machine usually has the podman test Postgres up (primary + 1 replica on
  localhost:5432), so diagnose/scan/watch report REAL healthy Postgres data —
  that's live-path verification, not simulator output.
- `scan` with ANTHROPIC_API_KEY set makes a real (paid) API call for its
  aiSummary; `ask` always does. Probe the keyless path with
  `env -u ANTHROPIC_API_KEY` (expect a remediation error, exit 1).
- Exit-code probes: don't pipe to head before reading `$?` — you'll capture
  head's status. Redirect to a file or use PIPESTATUS.
- `pnpm run eval:diagnosis:gate` (14-case AI benchmark, gate ≥13) runs the
  bundle and does NOT rebuild it. Scores have run-to-run abstention variance:
  a 12/14 followed by 14/14 on identical code has happened twice — re-run once
  before investigating.
