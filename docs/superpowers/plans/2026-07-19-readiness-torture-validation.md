# Readiness Torture Validation & Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate `crisismode readiness` against real infrastructure via two torture scenarios (`readiness-at-risk`, `readiness-honest-limits`) and ship a comprehensive `docs/readiness.md`.

**Architecture:** Two self-contained scenarios in crisismode-torture on a NEW stock-PostgreSQL compose stack (`infra/compose/readiness-pg.yml`), following the `pg-connection-exhaustion` scenario shape (setup → inject → verify → teardown, JSONL parsing of `crisismodeCli` output). One documentation task in crisismode on the existing `docs/readiness-doc` branch.

**Tech Stack:** TypeScript (NodeNext ESM, strict), tsx runner, docker/podman compose, postgres:16.

**Spec:** `docs/superpowers/specs/2026-07-19-readiness-validation-and-doc-design.md` (crisismode repo, branch `docs/readiness-doc`).

## Spec deviations (verified against source — the spec's assumptions were wrong in two places)

1. **New compose file instead of reusing `pg-connection.yml`.** The spec says "shared compose PG stack" AND assumes stock `max_connections=100`. Those conflict: `infra/compose/pg-connection.yml` pins `-c max_connections=25`, and the `connection-limit-tier` rule (`src/readiness/rules/connection-limit-tier.ts:7,26`) fires `at_risk` whenever `max_connections <= 25` — the baseline false-alarm guard (verdict `ready`) is impossible on that stack. Resolution: new `infra/compose/readiness-pg.yml` with a stock postgres:16 (default max_connections=100), shared by both new scenarios. This honors the spec's explicit numbers (70/100 = 70%, "stock image").
2. **Target wiring via `DATABASE_URL` env, not `crisismode.yaml`.** `runReadiness()` (crisismode `src/readiness/run.ts:260-283`) picks its PG target from `discoverStack().derivedTargets`, which is built ONLY from env hints + gated derivation (`src/cli/autodiscovery.ts:372`) — config-file targets never appear there. The spec's "mirror how pg-connection-exhaustion wires its target" (config-file write) would yield "no PostgreSQL target found". Resolution: scenarios set `process.env.DATABASE_URL` in `setup()` and delete it in `teardown()`; `crisismodeCli` spreads `process.env` into the child (`harness/src/exec.ts:322-328`), so the CLI inherits it. No harness changes — spec constraint preserved.

**Candidate bug to surface (do not fix in this plan):** the can't-assess message says "set DATABASE_URL or configure crisismode.yaml" (`src/readiness/run.ts:276`) but crisismode.yaml targets are NOT consulted by readiness. Either the message or the resolution is wrong. Report to the user after Task 4.

## Global Constraints

- crisismode-torture: NodeNext ESM — **all relative imports use `.js` extensions**; strict TS; no default exports; TypeScript ^7.0.2; typecheck via `pnpm typecheck` (`tsc --noEmit`).
- Torture scenarios live in `scenarios/<id>/scenario.ts` (one file per scenario) and register in `scenarios/index.ts` only — `package.json` needs no change (`pnpm scenario` = `tsx harness/src/run.ts`).
- No harness changes (spec constraint): touch nothing under `harness/`.
- Distinct compose project names per scenario (`torture-readiness-atrisk`, `torture-readiness-limits`) — host port 5432 is shared, safe because the runner executes scenarios sequentially with teardown in `finally`.
- JSONL field names (verified in crisismode `src/readiness/types.ts`): report verdict is HYPHENATED (`ready` / `at-risk` / `not-ready` / `unknown`); finding status is UNDERSCORED (`ready` / `at_risk` / `blocking` / `unknown`); finding key is `ruleId` (not `id`).
- The JSONL record is `{ "type": "readiness", ...ReadinessReport }` — report fields spread at TOP level, no sub-key (`src/cli/output.ts:67-70`).
- `readiness` is read-only: both scenarios return `plannedRecovery: false`, `recoverySucceeded: null`, `executeOutcome: null`, and ignore `VerifyOptions.execute`.
- Missing `readiness` record in CLI output = scenario FAIL with raw stdout captured in `notes` (spec error-handling rule).
- Teardown must succeed even if inject partially failed (best-effort try/catch inside; runner also calls teardown in `finally`).
- Conventional commits. crisismode-torture branch: `feat/readiness-scenarios` off `main` (PR #12 is merged — the 18-scenario README text is on main). crisismode work stays on existing branch `docs/readiness-doc`.
- Pre-flight for scenario runs: sibling CLI must be built — `cd ../crisismode && pnpm build` (torture's `resolveCli()` uses `../crisismode/dist/cli/index.js`). Podman/Docker must be running.

## Verified reference facts (quoted from source — reuse in assertions and docs, do not re-derive)

| Fact | Value | Source (crisismode repo) |
|---|---|---|
| connection-headroom thresholds | `AT_RISK_USAGE = 0.6`, `BLOCKING_USAGE = 0.8` | `src/readiness/rules/connection-headroom.ts:7,9` |
| connection-limit-tier threshold | `SMALL_MAX_CONNECTIONS = 25` (at_risk when max ≤ 25) | `src/readiness/rules/connection-limit-tier.ts:7` |
| long-transactions threshold | `LONG_IDLE_SECONDS = 60` (idle-in-txn age ≥ 60s → at_risk; never blocking) | `src/readiness/rules/long-transactions.ts:7` |
| missing-index thresholds | `MIN_ROWS = 10_000`, `SEQ_TO_IDX_RATIO = 10`; offender: `rowEstimate >= 10000 && seqScans > max(1, idxScans) * 10` | `src/readiness/rules/missing-index.ts:7,9,29` |
| slow-queries threshold | `SLOW_MEAN_MS = 250`; missing pg_stat_statements → status `unknown`, reason `'pg_stat_statements is not available — enable it with CREATE EXTENSION pg_stat_statements (most managed providers support it)'` | `src/readiness/rules/slow-queries.ts:7,23-30` |
| serverless-pooling | heuristic; `applicable` only when serverless platform detected — NOT present in torture runs (non-applicable rules are skipped entirely, `src/readiness/run.ts:35`) | `src/readiness/rules/serverless-pooling.ts:14` |
| Verdict computation | any blocking → `not-ready`; any at_risk → `at-risk`; no known findings → `unknown`; else `ready` | `src/readiness/report.ts:22-26` |
| Scoring | 100 − 30/blocking − 10/at_risk, floored at 0 | `src/readiness/report.ts:6-20` |
| DB unreachable | exit code 0; single finding `ruleId: 'readiness'`, status `unknown`, `reason` = raw connection error; verdict `unknown`, `evaluated: 0`, `unknown: 1`; NO `ceilings`/`ceilingsOmitted`/`weakLink` keys | `src/readiness/run.ts:54-65,160-167`; `src/cli/index.ts:181-185` |
| db-connections ceiling | `evidenceClasses: ['declared']`, evidence `` `max_connections = ${max} (declared)` `` | `src/readiness/ceilings.ts:36-44` |
| db-throughput omission (no pg_stat_statements) | `{ id: 'db-throughput', reason: 'mean query time unavailable (pg_stat_statements absent or empty)' }` | `src/readiness/ceilings.ts:61-62` |
| db-throughput ceiling (when measurable) | Little's law `λ_max = C / W`: `Math.round(max * (1000 / meanMs))` queries/s, classes `['declared','measured']` | `src/readiness/ceilings.ts:46-60` |
| Redis maxmemory=0 | omitted: `'maxmemory = 0 (unlimited) — bounded by host memory, not a declared limit'` | `src/readiness/ceilings.ts:87` |
| network-egress | `value = mbps * 125_000` bytes/s, declared-only, from `config.network.egressMbps` (finite > 0, `src/config/loader.ts:140-150`) | `src/readiness/ceilings.ts:19` |
| node-typical ceiling | typical-class, range 1_000–5_000 rps | `src/readiness/ceilings.ts:22-25,142-155` |
| Weak-link fan-out | `FANOUT_ASSUMPTIONS = [1, 3, 10]`; convertible = `unit === 'queries/s' && value !== null && !classes.includes('typical')`; `binding` null unless identical across all three | `src/readiness/weak-link.ts:14,33-36,61` |
| Env-hint target resolution | `DATABASE_URL`, `POSTGRES_URL`, `PG_CONNECTION_STRING`, `PGHOST` → postgresql; `REDIS_URL`, `REDIS_TLS_URL` → redis; URL credentials parsed into target credentials | `src/cli/autodiscovery.ts:117-130,215-250` |
| MCP tool | `crisismode_readiness`, `readOnlyHint: true` | `src/mcp/server.ts:376-386` |
| Baseline expectation (stock stack, non-serverless) | 5 findings: connection-headroom/connection-limit-tier/long-transactions/missing-index `ready`, slow-queries `unknown`; verdict `ready`, evaluated 4, unknown 1 | derived from the above |

---

### Task 1: Compose stack + `readiness-at-risk` scenario

**Files:**
- Create: `infra/compose/readiness-pg.yml` (crisismode-torture)
- Create: `scenarios/readiness-at-risk/scenario.ts` (crisismode-torture)
- Modify: `scenarios/index.ts` (crisismode-torture)

**Interfaces:**
- Consumes: `Scenario`/`VerifyResult`/`VerifyOptions` from `harness/src/types.js`; `composeUp`/`composeDown`/`waitForHealthy` from `harness/src/infra.js`; `dockerPsql`/`dockerExecDetached`/`crisismodeCli`/`parseJsonLines` from `harness/src/exec.js`; `pollUntil` from `harness/src/plan-helpers.js`.
- Produces: scenario id `readiness-at-risk`; compose file `infra/compose/readiness-pg.yml` reused verbatim by Task 2.

- [ ] **Step 1: Branch + sibling build**

```bash
cd /Users/aaronjohnson/repos/github/trs-80/crisismode-ai/crisismode-torture
git checkout main && git pull
git checkout -b feat/readiness-scenarios
cd ../crisismode && pnpm build   # torture resolveCli() runs ../crisismode/dist/cli/index.js
cd ../crisismode-torture
```

Expected: branch created; crisismode `pnpm build` exits 0.

- [ ] **Step 2: Write the compose file**

`infra/compose/readiness-pg.yml` — stock postgres:16 (default `max_connections=100`; deliberately NO `-c max_connections` override and NO pg_stat_statements — the missing-extension path is load-bearing for both scenarios):

```yaml
services:
  pg-primary:
    image: postgres:16
    environment:
      POSTGRES_USER: crisismode
      POSTGRES_PASSWORD: torture
      POSTGRES_DB: crisismode
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crisismode"]
      interval: 5s
      timeout: 3s
      retries: 10
```

- [ ] **Step 3: Write `scenarios/readiness-at-risk/scenario.ts`**

Full file:

```ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario, VerifyResult, VerifyOptions } from '../../harness/src/types.js';
import { composeUp, composeDown, waitForHealthy } from '../../harness/src/infra.js';
import { dockerPsql, dockerExecDetached, crisismodeCli, parseJsonLines } from '../../harness/src/exec.js';
import { pollUntil } from '../../harness/src/plan-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, '../../infra/compose/readiness-pg.yml');
const PROJECT = 'torture-readiness-atrisk';
const PRIMARY = `${PROJECT}-pg-primary-1`;
// Stock postgres:16 default — the readiness ceilings assertion depends on this exact value.
const MAX_CONNECTIONS = 100;
const DATABASE_URL = 'postgresql://crisismode:torture@localhost:5432/crisismode';

// Injection targets the at_risk band of connection-headroom (>=60%, <80% of max_connections)
// and the missing-index rule (>=10k rows, seq_scans > 10 with zero index scans), and the
// long-transactions rule (idle-in-transaction age >= 60s). Thresholds mirror
// crisismode src/readiness/rules/*.ts — see the plan's reference table.
const IDLE_TXN_APP_NAME = 'torture-readiness-idletxn';
const FLOOD_APP_NAME = 'torture-readiness-flood';
const FLOOD_SESSION_COUNT = 70;
const LONG_IDLE_SECONDS = 60;
const SCAN_TABLE = 'readiness_seqscan_target';
const SCAN_ROWS = 20_000;
const SCAN_COUNT = 12;

interface ReadinessRecord {
  verdict: string;
  evaluated: number;
  unknown: number;
  findings: Array<{
    ruleId: string;
    status: string;
    evidence: string[];
    reason?: string;
  }>;
  ceilings?: Array<{
    id: string;
    evidenceClasses: string[];
    evidence: string[];
  }>;
  ceilingsOmitted?: Array<{ id: string; reason: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Extract the single { type: 'readiness', ... } JSONL record, or null. */
function findReadinessRecord(lines: unknown[]): ReadinessRecord | null {
  const rec = lines.find((l) => isRecord(l) && l.type === 'readiness');
  return rec ? (rec as unknown as ReadinessRecord) : null;
}

async function runReadinessCli(): Promise<{ record: ReadinessRecord | null; raw: string; exitCode: number }> {
  const result = await crisismodeCli(['readiness'], 60_000);
  const raw = result.stdout + '\n' + result.stderr;
  return { record: findReadinessRecord(parseJsonLines(raw)), raw, exitCode: result.exitCode };
}

function parseCount(str: string, fallback: number): number {
  const n = parseInt(str, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function create(): Scenario {
  // Baseline (false-alarm guard) runs in setup, before inject; folded into verify's PASS.
  let baselineOk = false;
  let baselineNotes: string[] = [];

  return {
    id: 'readiness-at-risk',
    name: 'Readiness detects at-risk conditions (with false-alarm guard)',
    targets: ['postgresql'],
    composeProject: PROJECT,

    async setup() {
      await composeUp(COMPOSE_FILE, PROJECT);
      await waitForHealthy(PROJECT, ['pg-primary'], 90_000);
      // Readiness resolves its PG target from env hints only (autodiscovery derivedTargets);
      // crisismodeCli spreads process.env into the child, so this wires the compose primary.
      process.env.DATABASE_URL = DATABASE_URL;

      // Baseline false-alarm guard: a fresh stock stack must read `ready`.
      // Unknown findings are PERMITTED (slow-queries without pg_stat_statements) —
      // unknowns never affect the verdict; demanding zero unknowns would contradict
      // the honesty contract.
      const { record, raw } = await runReadinessCli();
      if (!record) {
        baselineNotes.push(`baseline: no readiness record in output: ${raw.slice(0, 500)}`);
        return;
      }
      const alarms = record.findings.filter((f) => f.status === 'at_risk' || f.status === 'blocking');
      baselineOk = record.verdict === 'ready' && alarms.length === 0;
      baselineNotes.push(
        `baseline verdict=${record.verdict} (want ready), alarming findings=${alarms.map((f) => f.ruleId).join(',') || 'none'} (want none)`,
      );
    },

    async inject() {
      // 1. Idle-in-transaction session FIRST, so it ages past the 60s threshold while
      //    the rest of the injection proceeds — no dead sleep.
      const idleTxnStart = Date.now();
      await dockerExecDetached(
        PRIMARY,
        ['sh', '-c', "(echo 'BEGIN;'; sleep 3600) | psql -U crisismode -d crisismode -q -o /dev/null"],
        { PGAPPNAME: IDLE_TXN_APP_NAME },
      );

      // 2. ~70 plain-idle connections: 70% of stock max_connections=100 — inside the
      //    at_risk band (>=60%), below blocking (>=80%).
      for (let i = 0; i < FLOOD_SESSION_COUNT; i++) {
        await dockerExecDetached(
          PRIMARY,
          ['sh', '-c', 'sleep 3600 | psql -U crisismode -d crisismode -q -o /dev/null'],
          { PGAPPNAME: FLOOD_APP_NAME },
        );
      }

      // 3. Unindexed table with fresh stats, then full scans past the seq-scan threshold
      //    (offender: rows >= 10k AND seq_scans > max(1, idx_scans) * 10; idx_scans = 0
      //    here, so >= 11 scans trip it — we run 12).
      await dockerPsql(
        PRIMARY,
        `CREATE TABLE ${SCAN_TABLE} (id int, payload text);
         INSERT INTO ${SCAN_TABLE} SELECT g, 'row-' || g FROM generate_series(1, ${SCAN_ROWS}) g;
         ANALYZE ${SCAN_TABLE};`,
      );
      for (let i = 0; i < SCAN_COUNT; i++) {
        await dockerPsql(PRIMARY, `SELECT count(*) FROM ${SCAN_TABLE} WHERE payload = 'needle-${i}';`);
      }

      // Confirm each condition landed before verify (each poll is a bounded wait).
      const floodOk = await pollUntil(async () => {
        const n = parseCount(
          await dockerPsql(PRIMARY, `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${FLOOD_APP_NAME}';`),
          0,
        );
        return n >= FLOOD_SESSION_COUNT - 5;
      }, 30_000);
      if (!floodOk) throw new Error('Injection failed: idle-connection flood did not register in pg_stat_activity');

      const utilization =
        parseCount(await dockerPsql(PRIMARY, 'SELECT count(*) FROM pg_stat_activity WHERE backend_type = \'client backend\';'), 0) /
        parseCount(await dockerPsql(PRIMARY, 'SHOW max_connections;'), MAX_CONNECTIONS);
      if (utilization < 0.6 || utilization >= 0.8) {
        throw new Error(`Injection failed: utilization ${(utilization * 100).toFixed(0)}% outside the at-risk band [60%, 80%)`);
      }

      const statsOk = await pollUntil(async () => {
        const row = await dockerPsql(
          PRIMARY,
          `SELECT seq_scan >= ${SCAN_COUNT} AND n_live_tup >= 10000 FROM pg_stat_user_tables WHERE relname = '${SCAN_TABLE}';`,
        );
        return row === 't';
      }, 30_000);
      if (!statsOk) throw new Error('Injection failed: seq-scan stats did not accumulate on the target table');

      // Bounded wait for the idle transaction to age past the threshold; the flood and
      // table work above consumed part of the window already.
      const remainingMs = Math.max(0, (LONG_IDLE_SECONDS + 5) * 1000 - (Date.now() - idleTxnStart));
      if (remainingMs > 0) {
        console.log(`  waiting ${Math.ceil(remainingMs / 1000)}s for the idle transaction to age past ${LONG_IDLE_SECONDS}s...`);
      }
      const agedOk = await pollUntil(async () => {
        const n = parseCount(
          await dockerPsql(
            PRIMARY,
            `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${IDLE_TXN_APP_NAME}' AND state = 'idle in transaction' AND now() - xact_start > interval '${LONG_IDLE_SECONDS} seconds';`,
          ),
          0,
        );
        return n >= 1;
      }, remainingMs + 30_000);
      if (!agedOk) throw new Error('Injection failed: idle-in-transaction session never aged past the threshold');
    },

    async verify(_opts: VerifyOptions): Promise<VerifyResult> {
      const notes: string[] = [...baselineNotes];
      const start = Date.now();
      const { record, raw } = await runReadinessCli();
      const detectionLatencyMs = Date.now() - start;

      if (!record) {
        notes.push(`FAIL: no readiness record in CLI output: ${raw.slice(0, 1000)}`);
        return {
          passed: false, detected: false, detectionLatencyMs: null,
          plannedRecovery: false, recoverySucceeded: null, executeOutcome: null,
          recoveryLatencyMs: null, notes,
        };
      }

      const checks: Array<[string, boolean]> = [];
      checks.push(['baseline false-alarm guard (verdict ready, no alarms)', baselineOk]);
      checks.push([`verdict is at-risk (got ${record.verdict})`, record.verdict === 'at-risk']);

      for (const ruleId of ['connection-headroom', 'missing-index', 'long-transactions']) {
        const f = record.findings.find((x) => x.ruleId === ruleId);
        checks.push([
          `${ruleId} at_risk with evidence (got ${f ? `${f.status}, ${f.evidence.length} evidence` : 'missing'})`,
          f !== undefined && f.status === 'at_risk' && f.evidence.length > 0,
        ]);
      }

      const dbConn = record.ceilings?.find((c) => c.id === 'db-connections');
      checks.push([
        'db-connections ceiling declares max_connections = 100',
        dbConn !== undefined &&
          dbConn.evidenceClasses.includes('declared') &&
          dbConn.evidence.some((e) => e.includes(`max_connections = ${MAX_CONNECTIONS}`)),
      ]);

      checks.push([
        `evaluated + unknown === findings.length (${record.evaluated} + ${record.unknown} vs ${record.findings.length})`,
        record.evaluated + record.unknown === record.findings.length,
      ]);

      for (const [label, ok] of checks) notes.push(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
      const passed = checks.every(([, ok]) => ok);

      return {
        passed,
        detected: record.verdict === 'at-risk',
        detectionLatencyMs,
        plannedRecovery: false,
        recoverySucceeded: null,
        executeOutcome: null,
        recoveryLatencyMs: null,
        notes,
      };
    },

    async teardown() {
      try {
        await dockerPsql(
          PRIMARY,
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('${IDLE_TXN_APP_NAME}', '${FLOOD_APP_NAME}');`,
        );
        await dockerPsql(PRIMARY, `DROP TABLE IF EXISTS ${SCAN_TABLE};`);
      } catch {
        // primary may already be unreachable — compose down finishes the job
      }
      await composeDown(COMPOSE_FILE, PROJECT);
      delete process.env.DATABASE_URL;
    },
  };
}
```

- [ ] **Step 4: Register the scenario**

In `scenarios/index.ts`, add after the `dbMigrationStuck` import:

```ts
import { create as readinessAtRisk } from './readiness-at-risk/scenario.js';
```

and in the `scenarios` record after `'db-migration-stuck': dbMigrationStuck,`:

```ts
  'readiness-at-risk': readinessAtRisk,
```

(No gate-Set membership — this is a non-gated core scenario.)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Run the scenario end-to-end**

Run: `pnpm scenario readiness-at-risk`
Expected: PASS; report saved under `reports/readiness-at-risk_*.json`; notes show the baseline guard PASS and every assertion PASS. If it fails, read the notes (each assertion is labeled) and the saved report before touching code — a `no readiness record` note means the sibling CLI build is stale (`cd ../crisismode && pnpm build`).

- [ ] **Step 7: Commit**

```bash
git add infra/compose/readiness-pg.yml scenarios/readiness-at-risk/scenario.ts scenarios/index.ts
git commit -m "feat: readiness-at-risk torture scenario with false-alarm baseline guard"
```

---

### Task 2: `readiness-honest-limits` scenario

**Files:**
- Create: `scenarios/readiness-honest-limits/scenario.ts` (crisismode-torture)
- Modify: `scenarios/index.ts` (crisismode-torture)

**Interfaces:**
- Consumes: `infra/compose/readiness-pg.yml` from Task 1 (verbatim reuse, different project name); same harness helpers plus `containerStop`/`containerStart` from `harness/src/exec.js`.
- Produces: scenario id `readiness-honest-limits`.

- [ ] **Step 1: Write `scenarios/readiness-honest-limits/scenario.ts`**

Full file (the `ReadinessRecord`/`isRecord`/`findReadinessRecord`/`runReadinessCli` helpers are duplicated from Task 1 by design — scenarios are self-contained, no harness changes allowed):

```ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario, VerifyResult, VerifyOptions } from '../../harness/src/types.js';
import { composeUp, composeDown, waitForHealthy } from '../../harness/src/infra.js';
import { containerStop, containerStart, crisismodeCli, parseJsonLines } from '../../harness/src/exec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, '../../infra/compose/readiness-pg.yml');
const PROJECT = 'torture-readiness-limits';
const PRIMARY = `${PROJECT}-pg-primary-1`;
// Stock postgres:16 default — Phase B asserts this exact declared value.
const MAX_CONNECTIONS = 100;
const DATABASE_URL = 'postgresql://crisismode:torture@localhost:5432/crisismode';

interface ReadinessRecord {
  verdict: string;
  evaluated: number;
  unknown: number;
  findings: Array<{
    ruleId: string;
    status: string;
    evidence: string[];
    reason?: string;
  }>;
  ceilings?: Array<{
    id: string;
    evidenceClasses: string[];
    evidence: string[];
  }>;
  ceilingsOmitted?: Array<{ id: string; reason: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Extract the single { type: 'readiness', ... } JSONL record, or null. */
function findReadinessRecord(lines: unknown[]): ReadinessRecord | null {
  const rec = lines.find((l) => isRecord(l) && l.type === 'readiness');
  return rec ? (rec as unknown as ReadinessRecord) : null;
}

async function runReadinessCli(): Promise<{ record: ReadinessRecord | null; raw: string; exitCode: number }> {
  const result = await crisismodeCli(['readiness'], 60_000);
  const raw = result.stdout + '\n' + result.stderr;
  return { record: findReadinessRecord(parseJsonLines(raw)), raw, exitCode: result.exitCode };
}

export function create(): Scenario {
  return {
    id: 'readiness-honest-limits',
    name: 'Readiness never fabricates under degradation (down DB, missing extension)',
    targets: ['postgresql'],
    composeProject: PROJECT,

    async setup() {
      await composeUp(COMPOSE_FILE, PROJECT);
      await waitForHealthy(PROJECT, ['pg-primary'], 90_000);
      // Readiness resolves its PG target from env hints only; crisismodeCli spreads
      // process.env into the child.
      process.env.DATABASE_URL = DATABASE_URL;
    },

    async inject() {
      // Phase A degradation: the database becomes unreachable. Phase B's degradation
      // (no pg_stat_statements) is inherent to the stock image — nothing to inject.
      await containerStop(PRIMARY);
    },

    async verify(_opts: VerifyOptions): Promise<VerifyResult> {
      const notes: string[] = [];
      const checks: Array<[string, boolean]> = [];
      const start = Date.now();

      // ── Phase A: unreachable database — an honest report is not a crash ──
      const phaseA = await runReadinessCli();
      if (!phaseA.record) {
        notes.push(`FAIL: phase A produced no readiness record: ${phaseA.raw.slice(0, 1000)}`);
      } else {
        const rec = phaseA.record;
        const cantAssess = rec.findings.find((f) => f.status === 'unknown' && typeof f.reason === 'string' && f.reason.length > 0);
        checks.push(['phase A: exit code 0 (honest report, not a crash)', phaseA.exitCode === 0]);
        checks.push([`phase A: verdict unknown (got ${rec.verdict})`, rec.verdict === 'unknown']);
        checks.push(['phase A: can\'t-assess finding with a non-empty reason', cantAssess !== undefined]);
        checks.push(['phase A: no fabricated ceilings (ceilings key absent)', rec.ceilings === undefined]);
      }

      // ── Recover the database for Phase B ──
      await containerStart(PRIMARY);
      await waitForHealthy(PROJECT, ['pg-primary'], 90_000);

      // ── Phase B: live DB, stock image, no pg_stat_statements ──
      const phaseB = await runReadinessCli();
      if (!phaseB.record) {
        notes.push(`FAIL: phase B produced no readiness record: ${phaseB.raw.slice(0, 1000)}`);
      } else {
        const rec = phaseB.record;
        const slowQueries = rec.findings.find((f) => f.ruleId === 'slow-queries');
        checks.push([
          `phase B: slow-queries unknown, reason names pg_stat_statements (got ${slowQueries ? `${slowQueries.status}, reason: ${slowQueries.reason ?? 'none'}` : 'missing'})`,
          slowQueries !== undefined &&
            slowQueries.status === 'unknown' &&
            typeof slowQueries.reason === 'string' &&
            slowQueries.reason.includes('pg_stat_statements'),
        ]);
        const omittedThroughput = rec.ceilingsOmitted?.find((o) => o.id === 'db-throughput');
        checks.push([
          'phase B: db-throughput in ceilingsOmitted with a reason, never a numeric ceiling',
          omittedThroughput !== undefined &&
            omittedThroughput.reason.length > 0 &&
            !(rec.ceilings ?? []).some((c) => c.id === 'db-throughput'),
        ]);
        const dbConn = rec.ceilings?.find((c) => c.id === 'db-connections');
        checks.push([
          'phase B: db-connections ceiling still delivered for what IS measurable',
          dbConn !== undefined && dbConn.evidence.some((e) => e.includes(`max_connections = ${MAX_CONNECTIONS}`)),
        ]);
      }

      for (const [label, ok] of checks) notes.push(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
      const passed = phaseA.record !== null && phaseB.record !== null && checks.every(([, ok]) => ok);

      return {
        passed,
        detected: passed,
        detectionLatencyMs: Date.now() - start,
        plannedRecovery: false,
        recoverySucceeded: null,
        executeOutcome: null,
        recoveryLatencyMs: null,
        notes,
      };
    },

    async teardown() {
      try {
        // Ensure the container is running before compose cleanup (harmless if verify
        // already restarted it; keeps cleanup deterministic if verify aborted mid-Phase-A).
        await containerStart(PRIMARY);
      } catch {
        // already running or already gone — compose down handles both
      }
      await composeDown(COMPOSE_FILE, PROJECT);
      delete process.env.DATABASE_URL;
    },
  };
}
```

- [ ] **Step 2: Register the scenario**

In `scenarios/index.ts`, add after the `readinessAtRisk` import:

```ts
import { create as readinessHonestLimits } from './readiness-honest-limits/scenario.js';
```

and in the `scenarios` record after `'readiness-at-risk': readinessAtRisk,`:

```ts
  'readiness-honest-limits': readinessHonestLimits,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Run the scenario end-to-end**

Run: `pnpm scenario readiness-honest-limits`
Expected: PASS; report under `reports/readiness-honest-limits_*.json`; notes show all Phase A and Phase B assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add scenarios/readiness-honest-limits/scenario.ts scenarios/index.ts
git commit -m "feat: readiness-honest-limits torture scenario (never-fabricate contract)"
```

---

### Task 3: Torture README roster update

**Files:**
- Modify: `README.md` (crisismode-torture, lines ~16-24)

**Interfaces:**
- Consumes: scenario ids `readiness-at-risk`, `readiness-honest-limits` from Tasks 1-2.
- Produces: nothing downstream.

- [ ] **Step 1: Update the roster paragraph**

Current text (README.md lines 16-24, post-PR-#12):

```
18 scenarios are registered in `scenarios/index.ts`: seven core
infrastructure scenarios (pg-replication-lag, pg-connection-exhaustion,
redis-memory-pressure, etcd-leader-loss, kafka-broker-failure,
network-partition, cascading-failure), three AWS scenarios
(aws-s3-backup-misconfigured, aws-dynamodb-pitr-disabled,
aws-rds-stale-backup), one Vercel scenario (vercel-bad-deploy), and seven
diagnosis/discrimination scenarios (false-alarm-healthy-service,
dns-red-herring, dns-outage, config-drift, queue-backlog, tls-cert-expiry,
db-migration-stuck). Run `pnpm scenario --list` for the current roster.
```

Replace with:

```
20 scenarios are registered in `scenarios/index.ts`: seven core
infrastructure scenarios (pg-replication-lag, pg-connection-exhaustion,
redis-memory-pressure, etcd-leader-loss, kafka-broker-failure,
network-partition, cascading-failure), two readiness scenarios
(readiness-at-risk, readiness-honest-limits — read-only validation of
`crisismode readiness` detection and its never-fabricate contract),
three AWS scenarios (aws-s3-backup-misconfigured,
aws-dynamodb-pitr-disabled, aws-rds-stale-backup), one Vercel scenario
(vercel-bad-deploy), and seven diagnosis/discrimination scenarios
(false-alarm-healthy-service, dns-red-herring, dns-outage, config-drift,
queue-backlog, tls-cert-expiry, db-migration-stuck). Run
`pnpm scenario --list` for the current roster.
```

- [ ] **Step 2: Sanity-check the count against the registry**

Run: `pnpm scenario --list | wc -l`
Expected: 20.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add readiness scenarios to the roster (18 -> 20)"
```

---

### Task 4: `docs/readiness.md` + link updates (crisismode repo)

**Files:**
- Create: `docs/readiness.md` (crisismode, branch `docs/readiness-doc`)
- Modify: `README.md:278` (readiness CLI-reference comment) and `README.md:366` (MCP tool row)
- Modify: `CLAUDE.md` (Key Files table, alongside the `docs/architecture.md` row)

**Interfaces:**
- Consumes: scenario ids from Tasks 1-2 (referenced in the Validation section).
- Produces: nothing downstream.

**Binding freshness rule (from the spec):** every claim written against current source; thresholds/ids quoted from the constants in the plan's reference table (each row carries its file:line) — re-open the cited file if anything looks off; no from-memory numbers. Code snippets copied from real source, not invented.

- [ ] **Step 1: Write `docs/readiness.md`**

Structure and tone match `docs/architecture.md` (title-case `##` sections, short intro prose per section, fenced examples, ends with `## Further Reading`). Required sections and their load-bearing content — all values are in this plan's "Verified reference facts" table with sources:

1. `# Scale Readiness` + intro — will-it-break-under-load vs scan's is-it-broken; read-only; suggests escalation at most.
2. `## Quick Start` — `crisismode readiness`, `--json` (one JSONL record, `type: "readiness"`, report fields at top level), and the `crisismode_readiness` MCP tool (`readOnlyHint: true`). Include a trimmed real JSON example (run the CLI or copy from a torture report — do not invent field values).
3. `## The Six Rules` — table: rule id | threshold (exact, with inclusivity: usage ≥ 60% at-risk / ≥ 80% blocking; max_connections ≤ 25; idle-in-txn ≥ 60s; rows ≥ 10,000 AND seq_scans > max(1, idx_scans) × 10; mean ≥ 250ms; serverless-pooling port/limit heuristic) | statuses it can produce | plain-English meaning | fix guidance (quote the rule's `fix` string). Serverless-pooling explicitly labeled a heuristic (its own explanation says so). Note statuses are underscored (`at_risk`) while the report verdict is hyphenated (`at-risk`). Verdict + scoring: 100 − 30 per blocking − 10 per at_risk, floor 0; any blocking → `not-ready`.
4. `## Capacity Ceilings` — the three evidence classes (`declared` = a configured limit, `measured` = observed data, `typical` = ballpark for the class of system) and what each promises; per-ceiling table (id, source, unit): db-connections, db-throughput, redis-memory, redis-clients, fd-limit (serverless-suppressed), network-egress (Mbps × 125,000 bytes/s), node-typical (1,000–5,000 rps). maxmemory=0-is-unlimited omission. Little's law derivation for db-throughput (`λ_max = C / W` → `max_connections × 1000 / mean_ms`) with the ~80%-practical-wall caveat (quote `AT_MOST_CAVEAT`, `ceilings.ts:15-16`).
5. `## The Weak-Link Verdict` — why every req/s figure is conditional on queries-per-request; the {1, 3, 10} fan-out set; typical-class exclusion; constraint migration (quote `MIGRATION_NOTE`, `weak-link.ts:29-30`).
6. `## Configuration` — target resolution is env-hint based: `DATABASE_URL` / `POSTGRES_URL` / `PG_CONNECTION_STRING` / `PGHOST` (postgresql), `REDIS_URL` / `REDIS_TLS_URL` (redis); URL credentials are parsed into the connection. `network.egressMbps` (declared-only, never measured; must be finite > 0). Describe ACTUAL behavior only — verify at `src/readiness/run.ts:260-283` whether crisismode.yaml targets are consulted (as of this plan they are NOT; do not document aspiration).
7. `## The Honesty Contract` — unknown never scored; omit-never-fabricate (ceilingsOmitted with reasons); ceilings never move the score or verdict; failures degrade coverage, never delivery (per-rule error isolation → unknown finding with the error as `reason`; DB unreachable → verdict `unknown`, exit 0).
8. `## Extending` — adding a rule: the `ReadinessRule` interface (copy from `src/readiness/types.ts` — real source), register in `src/readiness/rules/index.ts` (copy the `allRules` array), the exact-boundary-test convention (point at `src/__tests__/readiness-connection-rules.test.ts` style: one test at the threshold value, one just below), the unknown+reason requirement. Adding a ceiling: `computeCeilings` in `src/readiness/ceilings.ts`, evidence-class labeling, omit-with-reason.
9. `## Validation` — the two torture scenarios (`readiness-at-risk`, `readiness-honest-limits` in crisismode-torture), what a pass proves (real detection on real PostgreSQL with a false-alarm guard; honest degradation with a down DB and a missing extension) and what it does NOT prove (no blocking-verdict case, no pg_stat_statements positive path, no serverless heuristic coverage — deferred per spec).
10. `## Further Reading` — links: `docs/architecture.md`, the spec, torture repo scenarios.

- [ ] **Step 2: Update README links**

`README.md:278` — append the doc pointer to the CLI-reference comment:

```
crisismode readiness                  # Scale-readiness report (read-only): will this stack break under load, and where are the capacity ceilings? See docs/readiness.md
```

`README.md:366` — MCP row, append the pointer inside the description cell:

```
| `crisismode_readiness` | Forward-looking scale-readiness report: connection headroom, pooling, indexes, slow queries; includes capacity ceilings and a conditional weak-link verdict — see [docs/readiness.md](docs/readiness.md) |
```

- [ ] **Step 3: Update CLAUDE.md Key Files**

Add alongside the other docs rows (near `| docs/architecture.md | System architecture overview |`):

```
| `docs/readiness.md` | Scale-readiness usage and extension guide (rules, ceilings, honesty contract) |
```

- [ ] **Step 4: Spot-check every number in the doc against source**

Run: `grep -n "0.6\|0.8" src/readiness/rules/connection-headroom.ts && grep -n "= 25" src/readiness/rules/connection-limit-tier.ts && grep -n "= 60" src/readiness/rules/long-transactions.ts && grep -n "10_000\|RATIO = 10" src/readiness/rules/missing-index.ts && grep -n "= 250" src/readiness/rules/slow-queries.ts && grep -n "1, 3, 10" src/readiness/weak-link.ts && grep -n "125_000" src/readiness/ceilings.ts`
Expected: every doc threshold has a matching constant hit. Fix any mismatch in the DOC (source is truth).

- [ ] **Step 5: Commit**

```bash
git add docs/readiness.md README.md CLAUDE.md
git commit -m "docs: comprehensive scale-readiness guide (rules, ceilings, honesty contract)"
```

---

## Acceptance (from the spec)

- `pnpm typecheck` clean in crisismode-torture; both scenarios PASS via `pnpm scenario readiness-at-risk` and `pnpm scenario readiness-honest-limits` against the sibling-built CLI; reports under `reports/`.
- Baseline false-alarm guard PASS is part of the at-risk scenario's PASS.
- crisismode side is docs-only: no runtime change, no eval-gate re-run; doc claims spot-checked against source (Task 4 Step 4).

## Follow-ups to report to the user (not in scope)

- Candidate bug: readiness's can't-assess message advertises crisismode.yaml but target resolution never reads config-file targets (`src/readiness/run.ts:276` vs `src/cli/autodiscovery.ts:372`).
- Deferred per spec: blocking-verdict case, pg_stat_statements-enabled compose variant, serverless-pooling/vercel scenario, redis-ceiling torture assertions.
