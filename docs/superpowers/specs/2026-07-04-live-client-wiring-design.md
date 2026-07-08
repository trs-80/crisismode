# Live-Client Wiring & Gated Autodiscovery — Design

**Date:** 2026-07-04
**Status:** Approved for planning
**Scope:** Roadmap item 4 — zero-config `npx crisismode` AI-app wedge

## Problem

Four agents ship complete `live-client.ts` implementations that are never
instantiated:

| Agent dir | Target kind | Live client | Registration today |
|---|---|---|---|
| `src/agent/ai-provider/` | `ai-provider` | probes provider health endpoints | simulator-only |
| `src/agent/db-migration/` | `managed-database` | PG migration/lock/pool queries | simulator-only |
| `src/agent/config-drift/` | `application-config` | env/file drift comparison | simulator-only |
| `src/agent/queue-backlog/` | `message-queue` | BullMQ state via raw Redis | simulator-only |

All four registrations use `createSimulatorRegistration`
(`src/config/simulator-registration.ts`), so even an explicitly configured
target gets simulated data. Autodiscovery (`src/cli/autodiscovery.ts`) never
derives targets for these kinds, so they never appear in `crisismode scan`
at all.

Additionally, the existing redis registration
(`src/agent/redis/registration.ts`) silently falls back to the simulator when
the live connection fails — scan can report simulated "healthy" results as if
they were real. This violates the project's credibility standards.

## Decisions (made during brainstorming)

1. **Honest failure, everywhere.** No silent simulator fallback. If a live
   client cannot connect, the error propagates and scan reports
   `unknown — could not connect` (scan.ts already renders thrown errors this
   way). The simulator is used only when the target is explicitly simulated
   (`primary.host === 'simulator'`, demo mode). The existing redis
   registration is migrated to this behavior as part of this work.
2. **Config-drift is presence-only in zero-config mode.** Expectations are
   derived by parsing `.env.example` / `.env.template` from the app repo and
   checking each declared key for **presence** in `process.env`. Values are
   never compared, logged, or stored in zero-config mode. Full
   value-expectations remain available via `crisismode.yaml`.
3. **Gated target derivation.** Autodiscovery creates a target only when both
   the connection signal and the matching app dependency/file are present
   (table below). Keeps scan output quiet and credible on unrelated repos.

## Design

### 1. Schema — kind-specific target options

`src/config/schema.ts`, following the existing `aws?: AwsTargetConfig`
precedent:

```ts
export interface QueueTargetOptions {
  /** BullMQ queue names. Empty/absent = discover at connect time. */
  queueNames?: string[];
  /** BullMQ key prefix (default 'bull'). */
  keyPrefix?: string;
  /** Connect with TLS (set by derivation when the source URL scheme is rediss:). */
  tls?: boolean;
}

export interface ConfigDriftTargetOptions {
  /** Path to the env template file (default: auto-detect .env.example / .env.template). */
  envExamplePath?: string;
}

export interface TargetConfig {
  // ...existing fields...
  queue?: QueueTargetOptions;          // message-queue targets
  configDrift?: ConfigDriftTargetOptions; // application-config targets
}
```

`managed-database` needs no options (fits `primary` + `credentials`).
`ai-provider` builds its provider table from the environment at creation
time and needs no options.

### 2. Factory — `createLiveRegistration`

New module `src/config/live-registration.ts`, sibling of
`createSimulatorRegistration`:

```ts
export function createLiveRegistration(opts: {
  kind: string;
  name: string;
  manifest: AgentManifest;
  loadAgent: () => Promise<new (backend: ExecutionBackend) => RecoveryAgent>;
  loadSimulator: () => Promise<new () => ExecutionBackend>;
  /** Build and connect the live backend. Throw on failure — never swallow. */
  buildLiveBackend: (target: ResolvedTarget) => Promise<ExecutionBackend>;
}): AgentRegistration
```

Policy, owned in exactly one place:

- `target.primary.host === 'simulator'` (or missing primary) → simulator
  backend. This is the demo/test path.
- Otherwise → `buildLiveBackend(target)`. Errors propagate to the caller.
  `scan` catches per-target errors and reports the finding as
  `unknown` with the error message (`src/cli/commands/scan.ts`); `recover`
  and `diagnose` surface the error directly.

`createSimulatorRegistration` remains for agents that genuinely have no live
client yet.

### 3. Per-agent wiring

Each `registration.ts` migrates from `createSimulatorRegistration` to
`createLiveRegistration`, supplying only `buildLiveBackend`:

**db-migration** — construct `DbMigrationLiveClient` from
`target.primary.{host,port,database}` + resolved credentials. Shares the
same `DATABASE_URL`-derived connection info as pg-replication; runs
different checks (migration tables, locks, pool stats), so both targets
coexisting is intended.

**queue-backlog** — reconstruct a redis URL from `target.primary` +
credentials, using `rediss://` when `target.queue.tls` is set (derivation
sets it when the source env URL scheme was `rediss:`). Queue names: use
`target.queue.queueNames` when set; otherwise discover at connect time by
SCANning `${prefix}:*:meta` keys. Zero queues discovered → return an honest
health assessment with a "no BullMQ queues found at <host>" signal (status
`unknown`), never simulated data.

**ai-provider** — static provider table in the agent dir (name, base
endpoint, health path, auth header/prefix), covering at minimum: openai
(`https://api.openai.com/v1` + `/models`, `Authorization: Bearer`),
anthropic (`https://api.anthropic.com/v1` + `/models`, `x-api-key`, no
prefix), cohere, google, mistral. Filter the table to providers whose API
key env var is present (reuse `AI_ENV_VARS` from autodiscovery — export it
from a shared location rather than duplicating). Priority = table order.
Keys are read from env at creation time and passed to
`AiProviderLiveClient`; never logged.

**config-drift** — locate `.env.example` or `.env.template` in cwd (or
`target.configDrift.envExamplePath`). Parse keys (lines matching
`^\s*([A-Za-z_][A-Za-z0-9_]*)=`, comments skipped). Build presence-only
`ConfigExpectation[]`: `{ path: key, expected: null-check only, source:
'env', masked: true }` — implemented as a presence check so values are never
compared or logged. YAML-declared expectations pass through unchanged.

**redis (existing)** — migrate onto the factory; delete the silent
try/catch fallback. Behavior change: a down redis now reports
`unknown — could not connect` instead of simulated healthy data.

### 4. Autodiscovery — gated target derivation

Extend `src/cli/autodiscovery.ts` with a new derivation step that receives
both `envHints` and `appStack` (today `buildTargetsFromEnvHints` is
env-only):

| Derived kind | Connection signal | Gate (must also hold) |
|---|---|---|
| `managed-database` | `DATABASE_URL` / `POSTGRES_URL` / `PG_CONNECTION_STRING` parseable | `prisma`, `@prisma/client`, or `drizzle-orm` in app deps |
| `message-queue` | `REDIS_URL` / `REDIS_TLS_URL` parseable | `bullmq` (or `bull`) in app deps |
| `ai-provider` | any `AI_ENV_VARS` key present **or** AI SDK dep present | (signal is the gate) |
| `application-config` | `.env.example` or `.env.template` exists in cwd | (file is the gate) |

Derived targets join `StackProfile.derivedTargets` and flow through the
existing merge in `scan.ts` (which dedupes by kind against configured
targets). `ai-provider` and `application-config` targets use a sentinel
`primary` (`host: 'auto', port: 0`) like the local DNS/disk targets — they
are env/file-driven, not host-driven; the factory treats `'auto'` as live,
not simulator.

Onboarding output (`printOnboardingMessage`) lists the new derived targets
with their source signal (e.g. `+ managed-database (from DATABASE_URL +
prisma)`), never printing connection-string values.

### 5. Security constraints

- Connection strings, API keys, and env values are never logged, stored in
  findings, or echoed in onboarding output. Only env var *names* and
  hosts/ports appear.
- Config-drift zero-config mode is presence-only by construction.
- All live probing here is read-only (Escalation levels 1–2); no new
  mutation paths.

### 6. Testing

Unit (vitest, `src/__tests__/`):

- Factory policy: simulator host → simulator backend; live host + failing
  `buildLiveBackend` → error propagates (never simulator); `'auto'` host →
  live path.
- ai-provider table filtering: env fixtures → expected provider lists;
  missing keys excluded.
- `.env.example` parsing: comments, blank lines, quoted values, `export `
  prefixes; presence check against a stubbed env.
- Queue-name discovery against a fake redis (`bull:*:meta` fixtures);
  zero-queues → honest unknown assessment.
- Gated derivation: each row of the table above, positive and negative
  (signal without gate → no target).
- Redis registration: connection failure now throws (regression test for
  the removed fallback).

Live validation:

- `pnpm run typecheck` and full `pnpm test` (1604 baseline).
- `crisismode scan` in a fixture app dir (package.json with prisma+bullmq,
  `.env.example`, `DATABASE_URL`/`REDIS_URL` pointing at the podman test
  stack) — verify the four kinds appear with real findings.
- `crisismode scan` with services stopped — verify honest
  `unknown — could not connect` findings, no simulated results.

### Out of scope

- Live providers for execute-mode capabilities (`traffic.backend.detach`
  etc.) — roadmap item 5.
- deploy-rollback wiring (already has bespoke registration).
- Value-comparison drift detection beyond YAML-declared expectations.
- New CLI commands or output-format changes.
