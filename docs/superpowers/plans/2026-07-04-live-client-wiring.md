# Live-Client Wiring & Gated Autodiscovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the four orphaned live clients (ai-provider, db-migration, config-drift, queue-backlog) into their registrations with honest-failure semantics, and make autodiscovery derive gated targets for them so `npx crisismode` scans them zero-config.

**Architecture:** A new `createLiveRegistration` factory owns the live-vs-simulator policy in one place (simulator only for explicit `host === 'simulator'` targets; live connection errors propagate — never silently simulate). Each agent supplies a `buildLiveBackend(target)` config builder. Autodiscovery gains a gated derivation step (connection signal + app dependency/file required) feeding `StackProfile.derivedTargets`. The existing redis registration migrates to the factory, removing its silent fallback.

**Tech Stack:** TypeScript strict ESM (NodeNext — all relative imports use `.js` extensions), vitest, pg, ioredis (optional dep, dynamic import).

**Spec:** `docs/superpowers/specs/2026-07-04-live-client-wiring-design.md`

## Global Constraints

- Repo: `/Users/aaronjohnson/repos/github/trs-80/crisismode-ai/crisismode`, branch `feat/live-client-wiring`.
- No silent simulator fallback anywhere. Live connection errors must propagate.
- Connection strings, API keys, and env **values** are never logged, stored in findings, or printed. Only env var *names* and hosts/ports may appear.
- Config-drift zero-config mode is presence-only: env values are never compared or stored.
- All live probing is read-only. No new mutation paths.
- Named exports only. `import type` for type-only imports. Conventional commits.
- Do not touch the pre-existing uncommitted edits in `CLAUDE.md` / `QUICKSTART.md`.
- Run single test files with `pnpm exec vitest run <path>`; full suite `pnpm test`; types `pnpm run typecheck`.

---

### Task 1: Target option schema + resolution passthrough

**Files:**
- Modify: `src/config/schema.ts` (TargetConfig at ~line 56, ResolvedTarget at ~line 106)
- Modify: `src/config/resolve.ts` (`resolveTarget`)
- Test: `src/__tests__/resolve-target-options.test.ts` (create)

**Interfaces:**
- Consumes: existing `TargetConfig`, `ResolvedTarget`, `resolveTarget` in `src/config/`.
- Produces: `QueueTargetOptions`, `ConfigDriftTargetOptions`, `ConfigDriftExpectation` exported from `src/config/schema.ts`; `TargetConfig.queue?`, `TargetConfig.configDrift?` and the same fields on `ResolvedTarget`, passed through by `resolveTarget`. Tasks 5, 6, 8 rely on these exact names.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/resolve-target-options.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../config/resolve.js';

describe('resolveTarget kind-specific options', () => {
  it('passes queue options through to the resolved target', () => {
    const resolved = resolveTarget({
      name: 'q',
      kind: 'message-queue',
      primary: { host: 'localhost', port: 6379 },
      queue: { queueNames: ['emails'], keyPrefix: 'bull', tls: true },
    });
    expect(resolved.queue).toEqual({ queueNames: ['emails'], keyPrefix: 'bull', tls: true });
  });

  it('passes configDrift options through to the resolved target', () => {
    const resolved = resolveTarget({
      name: 'cfg',
      kind: 'application-config',
      primary: { host: 'auto', port: 0 },
      configDrift: {
        envExamplePath: '.env.example',
        expectations: [{ path: 'NODE_ENV', expected: 'production', source: 'env' }],
      },
    });
    expect(resolved.configDrift?.envExamplePath).toBe('.env.example');
    expect(resolved.configDrift?.expectations).toHaveLength(1);
  });

  it('leaves options undefined when absent', () => {
    const resolved = resolveTarget({
      name: 'pg',
      kind: 'postgresql',
      primary: { host: 'localhost', port: 5432 },
    });
    expect(resolved.queue).toBeUndefined();
    expect(resolved.configDrift).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/resolve-target-options.test.ts`
Expected: FAIL — TypeScript/type errors or `resolved.queue` undefined mismatch (object literal may not specify unknown property `queue`).

- [ ] **Step 3: Add the schema types and fields**

In `src/config/schema.ts`, after the `AwsTargetConfig` block (~line 52), add:

```ts
// ── Kind-specific target options ──

export interface QueueTargetOptions {
  /** BullMQ queue names. Empty/absent = discover at connect time. */
  queueNames?: string[];
  /** BullMQ key prefix (default 'bull'). */
  keyPrefix?: string;
  /** Connect with TLS (set by derivation when the source URL scheme is rediss:). */
  tls?: boolean;
}

export interface ConfigDriftExpectation {
  /** Environment variable name or config file path */
  path: string;
  /** Expected value (null = should not be set) */
  expected: string | null;
  source: 'env' | 'file';
  masked?: boolean;
}

export interface ConfigDriftTargetOptions {
  /** Path to the env template file (default: auto-detect .env.example / .env.template). */
  envExamplePath?: string;
  /** Full value expectations declared in crisismode.yaml. */
  expectations?: ConfigDriftExpectation[];
}
```

In `TargetConfig`, after `aws?: AwsTargetConfig;`, add:

```ts
  /** BullMQ options for message-queue targets. */
  queue?: QueueTargetOptions;
  /** Drift-check options for application-config targets. */
  configDrift?: ConfigDriftTargetOptions;
```

In `ResolvedTarget`, after `aws?: AwsTargetConfig;`, add the same two fields (same doc comments).

In `src/config/resolve.ts` `resolveTarget`, after `aws: target.aws,` add:

```ts
    queue: target.queue,
    configDrift: target.configDrift,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/resolve-target-options.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm run typecheck
git add src/config/schema.ts src/config/resolve.ts src/__tests__/resolve-target-options.test.ts
git commit -m "feat(config): kind-specific target options for queue and config-drift"
```

---

### Task 2: `createLiveRegistration` factory

**Files:**
- Create: `src/config/live-registration.ts`
- Test: `src/__tests__/live-registration.test.ts` (create)

**Interfaces:**
- Consumes: `AgentRegistration`, `AgentInstance` from `src/config/agent-registration.js`; `ResolvedTarget` from `src/config/schema.js`.
- Produces: `createLiveRegistration(opts)` — Tasks 3–7 call it with `{kind, name, manifest, loadAgent, loadSimulator, buildLiveBackend}`. Policy: missing `primary` or `primary.host === 'simulator'` → simulator; otherwise `buildLiveBackend(target)` with errors propagating.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/live-registration.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi } from 'vitest';
import { createLiveRegistration } from '../config/live-registration.js';
import type { ResolvedTarget } from '../config/schema.js';
import type { ExecutionBackend } from '../framework/backend.js';
import { queueBacklogManifest } from '../agent/queue-backlog/manifest.js';

class FakeBackend implements ExecutionBackend {
  label: string;
  constructor(label: string) { this.label = label; }
  async executeCommand(): Promise<unknown> { return null; }
  async evaluateCheck(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}

class FakeAgent {
  backend: ExecutionBackend;
  manifest = queueBacklogManifest;
  constructor(backend: ExecutionBackend) { this.backend = backend; }
}

function target(host: string): ResolvedTarget {
  return {
    name: 't', kind: 'message-queue',
    primary: { host, port: 6379 },
    replicas: [], credentials: {},
  };
}

function makeRegistration(buildLiveBackend: (t: ResolvedTarget) => Promise<ExecutionBackend>) {
  return createLiveRegistration({
    kind: 'message-queue',
    name: 'queue-backlog-recovery',
    manifest: queueBacklogManifest,
    loadAgent: async () => FakeAgent as never,
    loadSimulator: async () => (class extends FakeBackend {
      constructor() { super('simulator'); }
    }) as never,
    buildLiveBackend,
  });
}

describe('createLiveRegistration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const buildLive = vi.fn();
    const reg = makeRegistration(buildLive as never);
    const instance = await reg.createAgent(target('simulator'));
    expect((instance.backend as FakeBackend).label).toBe('simulator');
    expect(buildLive).not.toHaveBeenCalled();
  });

  it('builds the live backend for real hosts', async () => {
    const live = new FakeBackend('live');
    const reg = makeRegistration(async () => live);
    const instance = await reg.createAgent(target('db.example.com'));
    expect(instance.backend).toBe(live);
  });

  it('treats the "auto" sentinel host as live, not simulator', async () => {
    const live = new FakeBackend('live');
    const reg = makeRegistration(async () => live);
    const instance = await reg.createAgent(target('auto'));
    expect(instance.backend).toBe(live);
  });

  it('propagates live connection failures — never silently simulates', async () => {
    const reg = makeRegistration(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(reg.createAgent(target('db.example.com'))).rejects.toThrow('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/live-registration.test.ts`
Expected: FAIL — cannot resolve `../config/live-registration.js`.

- [ ] **Step 3: Write the factory**

```ts
// src/config/live-registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Factory for agent registrations that have a real live client.
 *
 * Policy (credibility standard — owned here, in exactly one place):
 * - Explicit simulator targets (host === 'simulator', or no primary) get the
 *   simulator backend. This is the demo/test path.
 * - Every other target gets the live backend. Connection failures PROPAGATE
 *   to the caller so scan reports an honest "could not connect" finding.
 *   We never silently substitute simulated data for real systems.
 */

import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { ResolvedTarget } from './schema.js';

export function createLiveRegistration(opts: {
  kind: string;
  name: string;
  manifest: AgentManifest;
  loadAgent: () => Promise<{ new (backend: ExecutionBackend): RecoveryAgent }>;
  loadSimulator: () => Promise<{ new (): ExecutionBackend }>;
  /** Build and connect the live backend. Throw on failure — never swallow. */
  buildLiveBackend: (target: ResolvedTarget) => Promise<ExecutionBackend>;
}): AgentRegistration {
  return {
    kind: opts.kind,
    name: opts.name,
    manifest: opts.manifest,

    async createAgent(target): Promise<AgentInstance> {
      const AgentClass = await opts.loadAgent();

      const isSimulatorTarget = !target.primary || target.primary.host === 'simulator';
      let backend: ExecutionBackend;
      if (isSimulatorTarget) {
        const SimulatorClass = await opts.loadSimulator();
        backend = new SimulatorClass();
      } else {
        backend = await opts.buildLiveBackend(target);
      }

      const agent = new AgentClass(backend);
      return { agent, backend, target };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/live-registration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config/live-registration.ts src/__tests__/live-registration.test.ts
git commit -m "feat(config): createLiveRegistration factory with honest-failure policy"
```

---

### Task 3: ai-provider — provider probe table + live wiring

**Files:**
- Create: `src/agent/ai-provider/provider-table.ts`
- Modify: `src/agent/ai-provider/live-client.ts` (`ProviderEndpointConfig` ~line 22, `probeProvider` ~line 74)
- Modify: `src/agent/ai-provider/registration.ts` (full rewrite)
- Test: `src/__tests__/ai-provider-table.test.ts` (create)

**Interfaces:**
- Consumes: `createLiveRegistration` (Task 2); existing `AiProviderLiveClient`, `ProviderEndpointConfig`.
- Produces: `PROVIDER_PROBE_TABLE`, `AI_ENV_VARS` (shape `Array<{ envVar: string; provider: string }>`), and `buildProviderConfigs(env)` exported from `src/agent/ai-provider/provider-table.js`. Task 8 imports `AI_ENV_VARS` from here.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ai-provider-table.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildProviderConfigs, AI_ENV_VARS, PROVIDER_PROBE_TABLE } from '../agent/ai-provider/provider-table.js';

describe('AI provider probe table', () => {
  it('builds configs only for providers whose env key is present, in table order', () => {
    const configs = buildProviderConfigs({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MISTRAL_API_KEY: 'test-mistral',
    } as NodeJS.ProcessEnv);
    expect(configs.map((c) => c.name)).toEqual(['anthropic', 'mistral']);
    expect(configs[0].priority).toBeLessThan(configs[1].priority);
    expect(configs.every((c) => c.enabled)).toBe(true);
  });

  it('returns empty when no keys are set', () => {
    expect(buildProviderConfigs({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('configures anthropic with x-api-key, no prefix, and a version header', () => {
    const [anthropic] = buildProviderConfigs({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(anthropic.authHeader).toBe('x-api-key');
    expect(anthropic.authPrefix).toBe('');
    expect(anthropic.extraHeaders?.['anthropic-version']).toBeTruthy();
  });

  it('AI_ENV_VARS mirrors the probe table', () => {
    expect(AI_ENV_VARS).toHaveLength(PROVIDER_PROBE_TABLE.length);
    expect(AI_ENV_VARS.map((v) => v.provider)).toContain('openai');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/ai-provider-table.test.ts`
Expected: FAIL — cannot resolve `provider-table.js`.

- [ ] **Step 3: Extend `ProviderEndpointConfig` and the probe headers**

In `src/agent/ai-provider/live-client.ts`, add to `ProviderEndpointConfig` (after `authPrefix?: string;`):

```ts
  /** Additional headers required by this provider (e.g. anthropic-version). */
  extraHeaders?: Record<string, string>;
```

In `probeProvider`, replace the header construction:

```ts
    const headers: Record<string, string> = { ...provider.extraHeaders };
    headers[headerName] = prefix ? `${prefix} ${provider.apiKey}` : provider.apiKey;
```

and pass `headers` to `fetch` (replacing the inline `{ [headerName]: \`${prefix} ${provider.apiKey}\` }`). Note `prefix` is already `provider.authPrefix ?? 'Bearer'` — an explicit `''` means "raw key, no prefix" and must not produce a leading space.

- [ ] **Step 4: Write the provider table**

```ts
// src/agent/ai-provider/provider-table.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static probe table for known AI providers: health endpoint, auth shape,
 * and the env var carrying the API key. Source of truth for both live
 * probing (registration) and autodiscovery detection (AI_ENV_VARS).
 *
 * SECURITY: API keys are read from env at backend-creation time and passed
 * directly to the live client. Never logged.
 */

import type { ProviderEndpointConfig } from './live-client.js';

export interface ProviderProbeSpec {
  provider: string;
  envVar: string;
  endpoint: string;
  healthPath: string;
  authHeader?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

export const PROVIDER_PROBE_TABLE: ProviderProbeSpec[] = [
  { provider: 'openai', envVar: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', healthPath: '/models' },
  {
    provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com/v1', healthPath: '/models',
    authHeader: 'x-api-key', authPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  { provider: 'cohere', envVar: 'COHERE_API_KEY', endpoint: 'https://api.cohere.com/v1', healthPath: '/models' },
  {
    provider: 'google', envVar: 'GOOGLE_AI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta', healthPath: '/models',
    authHeader: 'x-goog-api-key', authPrefix: '',
  },
  { provider: 'mistral', envVar: 'MISTRAL_API_KEY', endpoint: 'https://api.mistral.ai/v1', healthPath: '/models' },
  { provider: 'replicate', envVar: 'REPLICATE_API_TOKEN', endpoint: 'https://api.replicate.com/v1', healthPath: '/models' },
  { provider: 'huggingface', envVar: 'HUGGINGFACE_API_KEY', endpoint: 'https://huggingface.co', healthPath: '/api/whoami-v2' },
];

/** Env-var detection list, derived from the probe table (single source of truth). */
export const AI_ENV_VARS: Array<{ envVar: string; provider: string }> =
  PROVIDER_PROBE_TABLE.map(({ envVar, provider }) => ({ envVar, provider }));

/**
 * Build live-client provider configs for every provider whose API key is
 * present in the given environment. Priority = table order.
 */
export function buildProviderConfigs(env: NodeJS.ProcessEnv): ProviderEndpointConfig[] {
  const configs: ProviderEndpointConfig[] = [];
  for (const spec of PROVIDER_PROBE_TABLE) {
    const apiKey = env[spec.envVar];
    if (!apiKey) continue;
    configs.push({
      name: spec.provider,
      endpoint: spec.endpoint,
      healthPath: spec.healthPath,
      apiKey,
      authHeader: spec.authHeader,
      authPrefix: spec.authPrefix,
      extraHeaders: spec.extraHeaders,
      priority: configs.length + 1,
      enabled: true,
    });
  }
  return configs;
}
```

Note: huggingface uses `/api/whoami-v2` (validates the token). If typecheck complains about `whoami-v2` vs docs, keep the path — it is a plain GET probe and 200 = healthy.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/ai-provider-table.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Rewrite the registration**

```ts
// src/agent/ai-provider/registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { aiProviderManifest } from './manifest.js';
import { buildProviderConfigs } from './provider-table.js';

export const aiProviderRegistration = createLiveRegistration({
  kind: 'ai-provider',
  name: 'ai-provider-failover-recovery',
  manifest: aiProviderManifest,
  loadAgent: async () => {
    const { AiProviderFailoverAgent } = await import('./agent.js');
    return AiProviderFailoverAgent as never;
  },
  loadSimulator: async () => {
    const { AiProviderSimulator } = await import('./simulator.js');
    return AiProviderSimulator as never;
  },
  buildLiveBackend: async () => {
    const providers = buildProviderConfigs(process.env);
    if (providers.length === 0) {
      throw new Error(
        'No AI provider API keys found in environment (checked OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY, GOOGLE_AI_API_KEY, MISTRAL_API_KEY, REPLICATE_API_TOKEN, HUGGINGFACE_API_KEY)',
      );
    }
    const { AiProviderLiveClient } = await import('./live-client.js');
    return new AiProviderLiveClient({ providers });
  },
});
```

- [ ] **Step 7: Run existing ai-provider tests + typecheck**

Run: `pnpm exec vitest run src/__tests__/ai-provider-agent.test.ts src/__tests__/ai-provider-simulator.test.ts && pnpm run typecheck`
Expected: PASS. (Agent tests construct simulators directly, so the registration change must not break them. If a test constructs the registration with a simulator-host target, the factory preserves that path.)

- [ ] **Step 8: Commit**

```bash
git add src/agent/ai-provider/ src/__tests__/ai-provider-table.test.ts
git commit -m "feat(ai-provider): wire live client via provider probe table"
```

---

### Task 4: db-migration — live wiring

**Files:**
- Modify: `src/agent/db-migration/live-client.ts` (add `ping()`)
- Modify: `src/agent/db-migration/registration.ts` (full rewrite)
- Test: `src/__tests__/db-migration-registration.test.ts` (create)

**Interfaces:**
- Consumes: `createLiveRegistration` (Task 2); existing `DbMigrationLiveClient` (`DbMigrationConfig {host, port, user, password, database}`).
- Produces: `dbMigrationRegistration` (kind `managed-database`) with live wiring; `DbMigrationLiveClient.ping(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/db-migration-registration.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { dbMigrationRegistration } from '../agent/db-migration/registration.js';

describe('dbMigrationRegistration', () => {
  it('uses the simulator for explicit simulator targets', async () => {
    const instance = await dbMigrationRegistration.createAgent({
      name: 'sim', kind: 'managed-database',
      primary: { host: 'simulator', port: 0 },
      replicas: [], credentials: {},
    });
    expect(instance.backend.constructor.name).toBe('DbMigrationSimulator');
    await instance.backend.close();
  });

  it('rejects (never simulates) when the live database is unreachable', async () => {
    await expect(
      dbMigrationRegistration.createAgent({
        name: 'db', kind: 'managed-database',
        primary: { host: '127.0.0.1', port: 1, database: 'appdb' },
        replicas: [], credentials: { username: 'u', password: 'p' },
      }),
    ).rejects.toThrow();
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/db-migration-registration.test.ts`
Expected: FAIL — first test fails because the current simulator-only registration passes it, but the second test fails: the simulator-only registration resolves successfully (returns a simulator) instead of rejecting.

- [ ] **Step 3: Add `ping()` to the live client**

In `src/agent/db-migration/live-client.ts`, add as the first method of `DbMigrationLiveClient` (right after the constructor):

```ts
  /** Verify connectivity up front so scan reports an honest connect failure. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
```

- [ ] **Step 4: Rewrite the registration**

Check the exact simulator class name first: `grep -n "export class" src/agent/db-migration/simulator.ts` (expected `DbMigrationSimulator` — if it differs, use the actual name here and in Step 1's test).

```ts
// src/agent/db-migration/registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { dbMigrationManifest } from './manifest.js';

export const dbMigrationRegistration = createLiveRegistration({
  kind: 'managed-database',
  name: 'db-migration-recovery',
  manifest: dbMigrationManifest,
  loadAgent: async () => {
    const { DbMigrationAgent } = await import('./agent.js');
    return DbMigrationAgent as never;
  },
  loadSimulator: async () => {
    const { DbMigrationSimulator } = await import('./simulator.js');
    return DbMigrationSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { DbMigrationLiveClient } = await import('./live-client.js');
    const client = new DbMigrationLiveClient({
      host: target.primary.host,
      port: target.primary.port,
      user: target.credentials.username ?? 'postgres',
      password: target.credentials.password ?? '',
      database: target.primary.database ?? 'postgres',
    });
    await client.ping();
    return client;
  },
});
```

Preserve the existing exported names: check `grep -n "dbMigration" src/config/builtin-agents.ts` and keep the registration export name and `name:` field exactly as currently registered (adjust the code above if the current file uses different identifiers — read the current `registration.ts` before overwriting).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/db-migration-registration.test.ts`
Expected: PASS (2 tests; the unreachable test relies on pg's `connectionTimeoutMillis: 5000`).

- [ ] **Step 6: Run existing db-migration tests + typecheck, commit**

```bash
pnpm exec vitest run $(ls src/__tests__/db-migration*.test.ts | tr '\n' ' ')
pnpm run typecheck
git add src/agent/db-migration/ src/__tests__/db-migration-registration.test.ts
git commit -m "feat(db-migration): wire live PostgreSQL client with connect-time ping"
```

---

### Task 5: queue-backlog — queue discovery + honest empty state + live wiring

**Files:**
- Modify: `src/agent/queue-backlog/live-client.ts` (optional queueNames, SCAN discovery, `connect()`)
- Modify: `src/agent/queue-backlog/agent.ts` (`assessHealth` empty-queue branch, ~line 27)
- Modify: `src/agent/queue-backlog/registration.ts` (full rewrite)
- Test: `src/__tests__/queue-live-discovery.test.ts` (create)

**Interfaces:**
- Consumes: `createLiveRegistration` (Task 2); `ResolvedTarget.queue` (Task 1); existing `QueueLiveClient`, `QueueBacklogAgent`, `buildHealthAssessment`.
- Produces: `QueueLiveClient` accepts `queueNames?: string[]` (empty → discovered via `SCAN ${prefix}:*:meta`), exposes `connect(): Promise<void>` and `discoverQueueNames(): Promise<string[]>`; `QueueBacklogAgent.assessHealth` returns `status: 'unknown'` with a `queue_discovery` signal when zero queues exist.

- [ ] **Step 1: Write the failing test**

The test injects a fake redis by assigning the private `redis` field — this avoids needing ioredis in unit tests, matching the client's own lazy-connect design.

```ts
// src/__tests__/queue-live-discovery.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { QueueLiveClient } from '../agent/queue-backlog/live-client.js';
import { QueueBacklogAgent } from '../agent/queue-backlog/agent.js';
import type { QueueBackend } from '../agent/queue-backlog/backend.js';

/** Minimal fake of the RedisClient surface QueueLiveClient uses. */
function fakeRedis(keys: string[]): Record<string, unknown> {
  return {
    scan: async (_cursor: string, ..._args: unknown[]) => ['0', keys],
    llen: async () => 0,
    zcard: async () => 0,
    smembers: async () => [],
    hgetall: async () => ({}),
    get: async () => null,
    zrangebyscore: async () => [],
    zrange: async () => [],
    ping: async () => 'PONG',
    quit: async () => 'OK',
  };
}

function clientWith(keys: string[], queueNames: string[] = []): QueueLiveClient {
  const client = new QueueLiveClient({ redisUrl: 'redis://unused:6379', queueNames });
  (client as unknown as { redis: unknown }).redis = fakeRedis(keys);
  return client;
}

describe('QueueLiveClient queue discovery', () => {
  it('discovers queue names from bull:*:meta keys', async () => {
    const client = clientWith(['bull:emails:meta', 'bull:webhooks:meta', 'bull:emails:wait']);
    expect(await client.discoverQueueNames()).toEqual(['emails', 'webhooks']);
  });

  it('prefers explicitly configured queue names over discovery', async () => {
    const client = clientWith(['bull:other:meta'], ['emails']);
    expect(await client.discoverQueueNames()).toEqual(['emails']);
  });

  it('handles queue names containing colons', async () => {
    const client = clientWith(['bull:app:jobs:meta']);
    expect(await client.discoverQueueNames()).toEqual(['app:jobs']);
  });

  it('returns empty stats (not an error) when no queues exist', async () => {
    const client = clientWith([]);
    expect(await client.getQueueStats()).toEqual([]);
  });
});

describe('QueueBacklogAgent with zero queues', () => {
  it('reports honest unknown status instead of simulated health', async () => {
    const emptyBackend: QueueBackend = {
      getQueueStats: async () => [],
      getWorkerStatus: async () => [],
      getDeadLetterStats: async () => ({ depth: 0, oldestAge: 0, recentErrors: [] }),
      getProcessingRate: async () => ({ incomingRate: 0, processingRate: 0, backlogGrowthRate: 0, estimatedClearTime: 0 }),
      executeCommand: async () => null,
      evaluateCheck: async () => true,
      close: async () => {},
    };
    const agent = new QueueBacklogAgent(emptyBackend);
    const health = await agent.assessHealth({} as never);
    expect(health.status).toBe('unknown');
    expect(health.summary).toContain('No BullMQ queues found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/queue-live-discovery.test.ts`
Expected: FAIL — `discoverQueueNames` is not a function; zero-queue health resolves to `'healthy'` (all thresholds pass vacuously).

- [ ] **Step 3: Extend `QueueLiveClient`**

In `src/agent/queue-backlog/live-client.ts`:

1. `QueueLiveConfig`: change `queueNames: string[];` to `queueNames?: string[];` and update its doc comment to `/** BullMQ queue names to monitor. Empty/absent = discover from ${prefix}:*:meta keys. */`
2. Add `scan` to the `RedisClient` type:

```ts
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
```

3. Add a cached-names field and the discovery methods (after `getRedis`):

```ts
  private resolvedQueueNames: string[] | null = null;

  /** Establish the connection eagerly so registration can fail honestly. */
  async connect(): Promise<void> {
    await this.getRedis();
  }

  /**
   * Resolve the queue names to monitor: explicit config wins; otherwise
   * discover BullMQ queues by scanning `${prefix}:*:meta` keys.
   */
  async discoverQueueNames(): Promise<string[]> {
    if (this.resolvedQueueNames) return this.resolvedQueueNames;

    if (this.config.queueNames && this.config.queueNames.length > 0) {
      this.resolvedQueueNames = this.config.queueNames;
      return this.resolvedQueueNames;
    }

    const redis = await this.getRedis();
    const names = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${this.prefix}:*:meta`, 'COUNT', 100);
      for (const key of keys) {
        const parts = key.split(':');
        // `${prefix}:<queue name (may contain colons)>:meta`
        if (parts.length >= 3 && parts[parts.length - 1] === 'meta') {
          names.add(parts.slice(1, -1).join(':'));
        }
      }
      cursor = next;
    } while (cursor !== '0');

    this.resolvedQueueNames = Array.from(names).sort();
    return this.resolvedQueueNames;
  }
```

4. Replace every read of `this.config.queueNames` in `getQueueStats`, `getWorkerStatus`, `getDeadLetterStats`, and `getProcessingRate` with the discovered list. Pattern for each method: add `const queueNames = await this.discoverQueueNames();` as the first line after `const redis = await this.getRedis();` (or as the first line for `getProcessingRate`, which has no redis call) and iterate `for (const name of queueNames)`. In `getProcessingRate`, replace `this.config.queueNames.length` with `Math.max(1, queueNames.length)` to avoid divide-by-zero on empty discovery.

- [ ] **Step 4: Add the empty-queue branch to `assessHealth`**

In `src/agent/queue-backlog/agent.ts`, immediately after `const queues = await this.backend.getQueueStats();` (line 27), insert:

```ts
    if (queues.length === 0) {
      return {
        status: 'unknown',
        confidence: 0.9,
        summary: 'No BullMQ queues found at this target — nothing to monitor.',
        observedAt,
        signals: [{
          source: 'queue_discovery',
          status: 'unknown',
          detail: 'No BullMQ queue metadata keys (bull:*:meta) were found on this Redis instance.',
          observedAt,
        }],
        recommendedActions: [
          'Verify this Redis instance hosts BullMQ queues, or set queue.queueNames in crisismode.yaml.',
        ],
      };
    }
```

(Then the remaining `workers`/`dlq`/`rates` fetches run only when queues exist — move the three `await this.backend.get...` lines for workers/dlq/rates below this branch.)

- [ ] **Step 5: Rewrite the registration**

Check exported simulator/agent names first (`grep -n "export class" src/agent/queue-backlog/simulator.ts`).

```ts
// src/agent/queue-backlog/registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { queueBacklogManifest } from './manifest.js';

export const queueBacklogRegistration = createLiveRegistration({
  kind: 'message-queue',
  name: 'queue-backlog-recovery',
  manifest: queueBacklogManifest,
  loadAgent: async () => {
    const { QueueBacklogAgent } = await import('./agent.js');
    return QueueBacklogAgent as never;
  },
  loadSimulator: async () => {
    const { QueueSimulator } = await import('./simulator.js');
    return QueueSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { QueueLiveClient } = await import('./live-client.js');

    const scheme = target.queue?.tls ? 'rediss' : 'redis';
    const auth = target.credentials.password
      ? `${encodeURIComponent(target.credentials.username ?? 'default')}:${encodeURIComponent(target.credentials.password)}@`
      : '';
    const redisUrl = `${scheme}://${auth}${target.primary.host}:${target.primary.port}`;

    const client = new QueueLiveClient({
      redisUrl,
      queueNames: target.queue?.queueNames ?? [],
      keyPrefix: target.queue?.keyPrefix,
    });
    await client.connect();
    return client;
  },
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/queue-live-discovery.test.ts $(ls src/__tests__/queue*.test.ts | tr '\n' ' ') && pnpm run typecheck`
Expected: PASS — new tests plus all existing queue-backlog tests (simulator has queues, so the new branch doesn't fire there).

- [ ] **Step 7: Commit**

```bash
git add src/agent/queue-backlog/ src/__tests__/queue-live-discovery.test.ts
git commit -m "feat(queue-backlog): live BullMQ wiring with queue discovery and honest empty state"
```

---

### Task 6: config-drift — presence expectations from .env.example + live wiring

**Files:**
- Create: `src/agent/config-drift/env-example.ts`
- Modify: `src/agent/config-drift/live-client.ts` (`ConfigExpectation` + `getEnvironmentVars`)
- Modify: `src/agent/config-drift/registration.ts` (full rewrite)
- Test: `src/__tests__/config-drift-env-example.test.ts` (create)

**Interfaces:**
- Consumes: `createLiveRegistration` (Task 2); `ResolvedTarget.configDrift` (Task 1); existing `ConfigDriftLiveClient` / `ConfigExpectation`.
- Produces: `ConfigExpectation.presence?: boolean` (presence-only check; values never read into results); `parseEnvExampleKeys(content): string[]`, `findEnvExample(cwd, explicitPath?): Promise<string | null>`, `buildPresenceExpectations(cwd, explicitPath?): Promise<ConfigExpectation[]>` from `env-example.js`. Task 8 uses `findEnvExample` for gating.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/config-drift-env-example.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvExampleKeys, findEnvExample, buildPresenceExpectations } from '../agent/config-drift/env-example.js';
import { ConfigDriftLiveClient } from '../agent/config-drift/live-client.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crisismode-envex-'));
  cleanups.push(dir);
  return dir;
}

describe('parseEnvExampleKeys', () => {
  it('extracts keys, skipping comments, blanks, export prefixes, and quoted values', () => {
    const content = [
      '# Database',
      'DATABASE_URL=postgres://localhost/app',
      '',
      'export REDIS_URL="redis://localhost:6379"',
      '  API_KEY = secret',
      '# COMMENTED_OUT=1',
      'not a key line',
      '1BAD=nope',
    ].join('\n');
    expect(parseEnvExampleKeys(content)).toEqual(['DATABASE_URL', 'REDIS_URL', 'API_KEY']);
  });
});

describe('findEnvExample', () => {
  it('finds .env.example, preferring it over .env.template', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env.example'), 'A=1\n');
    await writeFile(join(dir, '.env.template'), 'B=2\n');
    expect(await findEnvExample(dir)).toBe(join(dir, '.env.example'));
  });

  it('returns null when neither file exists', async () => {
    expect(await findEnvExample(await tempDir())).toBeNull();
  });

  it('honors an explicit path', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'custom.env'), 'A=1\n');
    expect(await findEnvExample(dir, join(dir, 'custom.env'))).toBe(join(dir, 'custom.env'));
  });
});

describe('presence-only expectations', () => {
  it('builds presence expectations that never carry values', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env.example'), 'PRESENT_VAR=x\nMISSING_VAR=y\n');
    const expectations = await buildPresenceExpectations(dir);
    expect(expectations).toEqual([
      { path: 'PRESENT_VAR', expected: null, source: 'env', masked: true, presence: true },
      { path: 'MISSING_VAR', expected: null, source: 'env', masked: true, presence: true },
    ]);
  });

  it('reports presence drift without exposing values', async () => {
    process.env.CRISISMODE_TEST_PRESENT = 'super-secret-value';
    delete process.env.CRISISMODE_TEST_MISSING;
    try {
      const client = new ConfigDriftLiveClient({
        expectations: [
          { path: 'CRISISMODE_TEST_PRESENT', expected: null, source: 'env', masked: true, presence: true },
          { path: 'CRISISMODE_TEST_MISSING', expected: null, source: 'env', masked: true, presence: true },
        ],
      });
      const vars = await client.getEnvironmentVars();
      const present = vars.find((v) => v.name === 'CRISISMODE_TEST_PRESENT')!;
      const missing = vars.find((v) => v.name === 'CRISISMODE_TEST_MISSING')!;
      expect(present.expected).toBe(present.actual);        // no drift
      expect(missing.actual).toBeNull();                    // drift: expected set, actually missing
      expect(missing.expected).not.toBeNull();
      expect(JSON.stringify(vars)).not.toContain('super-secret-value');
    } finally {
      delete process.env.CRISISMODE_TEST_PRESENT;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/config-drift-env-example.test.ts`
Expected: FAIL — cannot resolve `env-example.js`.

- [ ] **Step 3: Add `presence` mode to the live client**

In `src/agent/config-drift/live-client.ts`, add to `ConfigExpectation`:

```ts
  /** Presence-only check: verify the key is set; never read or compare its value. */
  presence?: boolean;
```

In `getEnvironmentVars`, at the top of the `for (const exp of this.config.expectations)` loop body (after the `if (exp.source !== 'env') continue;` guard), add:

```ts
      if (exp.presence) {
        const isSet = process.env[exp.path] !== undefined && process.env[exp.path] !== '';
        results.push({
          name: exp.path,
          expected: '(set)',
          actual: isSet ? '(set)' : null,
          source: 'env',
          masked: true,
        });
        continue;
      }
```

(The agent computes drift as `expected !== actual`, so present → `'(set)' === '(set)'` no drift; missing → `'(set)' !== null` drift. Values are never read into results.)

- [ ] **Step 4: Write the env-example module**

```ts
// src/agent/config-drift/env-example.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Zero-config drift expectations from .env.example / .env.template.
 *
 * Presence-only by construction: we extract KEY NAMES from the template and
 * check each is set in the environment. Values are never read, compared,
 * logged, or stored.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigExpectation } from './live-client.js';

export const ENV_EXAMPLE_FILENAMES = ['.env.example', '.env.template'];

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Extract declared keys from env-template file content. */
export function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = KEY_LINE.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Locate the env template: explicit path wins, else .env.example, else .env.template. */
export async function findEnvExample(cwd: string, explicitPath?: string): Promise<string | null> {
  const candidates = explicitPath
    ? [explicitPath]
    : ENV_EXAMPLE_FILENAMES.map((f) => join(cwd, f));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Build presence-only expectations from the discovered env template. */
export async function buildPresenceExpectations(
  cwd: string,
  explicitPath?: string,
): Promise<ConfigExpectation[]> {
  const path = await findEnvExample(cwd, explicitPath);
  if (!path) return [];

  const content = await readFile(path, 'utf-8');
  return parseEnvExampleKeys(content).map((key) => ({
    path: key,
    expected: null,
    source: 'env' as const,
    masked: true,
    presence: true,
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/__tests__/config-drift-env-example.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Rewrite the registration**

Check exported names first (`grep -n "export" src/agent/config-drift/registration.ts src/agent/config-drift/simulator.ts`), then:

```ts
// src/agent/config-drift/registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { configDriftManifest } from './manifest.js';

export const configDriftRegistration = createLiveRegistration({
  kind: 'application-config',
  name: 'config-drift-recovery',
  manifest: configDriftManifest,
  loadAgent: async () => {
    const { ConfigDriftAgent } = await import('./agent.js');
    return ConfigDriftAgent as never;
  },
  loadSimulator: async () => {
    const { ConfigDriftSimulator } = await import('./simulator.js');
    return ConfigDriftSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { ConfigDriftLiveClient } = await import('./live-client.js');
    const { buildPresenceExpectations } = await import('./env-example.js');
    const opts = target.configDrift;

    // YAML-declared value expectations pass through unchanged.
    const yamlExpectations = (opts?.expectations ?? []).map((e) => ({
      path: e.path,
      expected: e.expected,
      source: e.source,
      masked: e.masked,
    }));

    // Zero-config: presence-only expectations from .env.example.
    const presenceExpectations = await buildPresenceExpectations(process.cwd(), opts?.envExamplePath);

    const expectations = [...yamlExpectations, ...presenceExpectations];
    if (expectations.length === 0) {
      throw new Error(
        'No config expectations available: no .env.example/.env.template found and none declared in crisismode.yaml',
      );
    }

    return new ConfigDriftLiveClient({ expectations });
  },
});
```

(Use the actual manifest/agent/simulator export names found by the grep — the current file has the authoritative names.)

- [ ] **Step 7: Run config-drift tests + typecheck, commit**

```bash
pnpm exec vitest run $(ls src/__tests__/config-drift*.test.ts | tr '\n' ' ') && pnpm run typecheck
git add src/agent/config-drift/ src/__tests__/config-drift-env-example.test.ts
git commit -m "feat(config-drift): presence-only zero-config expectations from .env.example"
```

---

### Task 7: redis — migrate to the factory, remove silent fallback

**Files:**
- Modify: `src/agent/redis/registration.ts` (full rewrite)
- Test: `src/__tests__/redis-registration-honest-failure.test.ts` (create)

**Interfaces:**
- Consumes: `createLiveRegistration` (Task 2); existing `RedisLiveClient` (config `{host, port, password, connectTimeoutMs}` + `connect()`), `RedisMemoryAgent`, `RedisSimulator`.
- Produces: `redisMemoryRegistration` with honest-failure semantics. **Behavior change:** a configured-but-down redis now rejects instead of silently returning simulated data.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/redis-registration-honest-failure.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { redisMemoryRegistration } from '../agent/redis/registration.js';

describe('redisMemoryRegistration honest failure', () => {
  it('still uses the simulator for explicit simulator targets', async () => {
    const instance = await redisMemoryRegistration.createAgent({
      name: 'sim', kind: 'redis',
      primary: { host: 'simulator', port: 0 },
      replicas: [], credentials: {},
    });
    expect(instance.backend.constructor.name).toBe('RedisSimulator');
    await instance.backend.close();
  });

  it('rejects (never simulates) when redis is unreachable', async () => {
    await expect(
      redisMemoryRegistration.createAgent({
        name: 'down', kind: 'redis',
        primary: { host: '127.0.0.1', port: 1 },
        replicas: [], credentials: {},
      }),
    ).rejects.toThrow();
  }, 10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/redis-registration-honest-failure.test.ts`
Expected: FAIL — second test: current registration resolves with `RedisSimulator` (silent fallback) instead of rejecting.

- [ ] **Step 3: Rewrite the registration**

```ts
// src/agent/redis/registration.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { redisMemoryManifest } from './manifest.js';

export const redisMemoryRegistration = createLiveRegistration({
  kind: 'redis',
  name: 'redis-memory-recovery',
  manifest: redisMemoryManifest,
  loadAgent: async () => {
    const { RedisMemoryAgent } = await import('./agent.js');
    return RedisMemoryAgent as never;
  },
  loadSimulator: async () => {
    const { RedisSimulator } = await import('./simulator.js');
    return RedisSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { RedisLiveClient } = await import('./live-client.js');
    const backend = new RedisLiveClient({
      host: target.primary.host,
      port: target.primary.port,
      password: target.credentials.password,
      connectTimeoutMs: 2000,
    });
    await backend.connect();
    return backend;
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/redis-registration-honest-failure.test.ts $(ls src/__tests__/redis*.test.ts 2>/dev/null | tr '\n' ' ') && pnpm run typecheck`
Expected: PASS. If any existing test relied on the silent fallback (e.g. created a live-host target expecting a simulator), update that test to use `host: 'simulator'` — the fallback removal is the point of this task.

- [ ] **Step 5: Commit**

```bash
git add src/agent/redis/registration.ts src/__tests__/redis-registration-honest-failure.test.ts
git commit -m "fix(redis): remove silent simulator fallback — honest connect failures"
```

---

### Task 8: Autodiscovery — gated target derivation + onboarding notes

**Files:**
- Modify: `src/cli/autodiscovery.ts` (remove local `AI_ENV_VARS` ~line 134, add `deriveGatedTargets`, extend `discoverStack` + `StackProfile` + `printOnboardingMessage`)
- Modify: `src/config/service-registry.ts` (add `prisma` package)
- Test: `src/__tests__/autodiscovery-gated-targets.test.ts` (create)

**Interfaces:**
- Consumes: `AI_ENV_VARS` from `src/agent/ai-provider/provider-table.js` (Task 3); `findEnvExample` from `src/agent/config-drift/env-example.js` (Task 6); existing `parseConnectionString`, `AppStackInfo`, `TargetConfig`.
- Produces: `deriveGatedTargets(appStack, cwd, env): Promise<{ targets: TargetConfig[]; notes: Record<string, string> }>` exported from `autodiscovery.ts`; `StackProfile.derivedNotes: Record<string, string>`. Derived targets flow through the existing `derivedTargets` merge in `scan.ts` untouched.

- [ ] **Step 1: Add `prisma` to the service registry**

In `src/config/service-registry.ts`, next to the existing `{ pkg: '@prisma/client', service: 'postgresql' }` entry (~line 27), add:

```ts
  { pkg: 'prisma', service: 'postgresql' },
```

(`prisma` is the migration CLI and commonly a devDependency; `inspectAppStack` merges devDependencies, so this makes it visible in `appStack.dependencies` for gating.)

- [ ] **Step 2: Write the failing test**

```ts
// src/__tests__/autodiscovery-gated-targets.test.ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveGatedTargets } from '../cli/autodiscovery.js';
import type { AppStackInfo } from '../cli/autodiscovery.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crisismode-gated-'));
  cleanups.push(dir);
  return dir;
}

function stack(deps: string[]): AppStackInfo {
  return { framework: null, language: 'typescript', hasDockerfile: false, hasCIConfig: false, dependencies: deps };
}

describe('deriveGatedTargets', () => {
  it('derives managed-database only with both DATABASE_URL and a migration tool', async () => {
    const dir = await emptyDir();
    const env = { DATABASE_URL: 'postgres://app:pw@db.internal:5433/appdb' } as NodeJS.ProcessEnv;

    const gated = await deriveGatedTargets(stack(['@prisma/client']), dir, env);
    const dbTarget = gated.targets.find((t) => t.kind === 'managed-database');
    expect(dbTarget?.primary).toEqual({ host: 'db.internal', port: 5433, database: 'appdb' });
    expect(gated.notes[dbTarget!.name]).toContain('DATABASE_URL');

    const ungated = await deriveGatedTargets(stack([]), dir, env);
    expect(ungated.targets.find((t) => t.kind === 'managed-database')).toBeUndefined();
  });

  it('derives message-queue only with both REDIS_URL and bullmq, carrying tls for rediss', async () => {
    const dir = await emptyDir();
    const env = { REDIS_TLS_URL: 'rediss://:pw@cache.internal:6380' } as NodeJS.ProcessEnv;

    const gated = await deriveGatedTargets(stack(['bullmq']), dir, env);
    const q = gated.targets.find((t) => t.kind === 'message-queue');
    expect(q?.primary?.host).toBe('cache.internal');
    expect(q?.queue?.tls).toBe(true);

    const ungated = await deriveGatedTargets(stack([]), dir, env);
    expect(ungated.targets.find((t) => t.kind === 'message-queue')).toBeUndefined();
  });

  it('derives ai-provider from an API key even without SDK deps', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack([]), dir, { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    const ai = gated.targets.find((t) => t.kind === 'ai-provider');
    expect(ai?.primary?.host).toBe('auto');
  });

  it('derives ai-provider from an SDK dep even without keys', async () => {
    const dir = await emptyDir();
    const gated = await deriveGatedTargets(stack(['@anthropic-ai/sdk']), dir, {} as NodeJS.ProcessEnv);
    expect(gated.targets.find((t) => t.kind === 'ai-provider')).toBeDefined();
  });

  it('derives application-config only when an env template exists', async () => {
    const dir = await emptyDir();
    const without = await deriveGatedTargets(stack([]), dir, {} as NodeJS.ProcessEnv);
    expect(without.targets.find((t) => t.kind === 'application-config')).toBeUndefined();

    await writeFile(join(dir, '.env.example'), 'DATABASE_URL=\n');
    const withFile = await deriveGatedTargets(stack([]), dir, {} as NodeJS.ProcessEnv);
    expect(withFile.targets.find((t) => t.kind === 'application-config')).toBeDefined();
  });

  it('never leaks connection-string values into names or notes', async () => {
    const dir = await emptyDir();
    const env = { DATABASE_URL: 'postgres://app:supersecret@db:5432/appdb' } as NodeJS.ProcessEnv;
    const gated = await deriveGatedTargets(stack(['drizzle-orm']), dir, env);
    const serialized = JSON.stringify({ names: gated.targets.map((t) => t.name), notes: gated.notes });
    expect(serialized).not.toContain('supersecret');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/autodiscovery-gated-targets.test.ts`
Expected: FAIL — `deriveGatedTargets` is not exported.

- [ ] **Step 4: Implement derivation in `autodiscovery.ts`**

1. Delete the local `AI_ENV_VARS` constant (~lines 133–142) and add imports:

```ts
import { AI_ENV_VARS } from '../agent/ai-provider/provider-table.js';
import { findEnvExample } from '../agent/config-drift/env-example.js';
```

(`detectAiProviders` keeps working — it already iterates `AI_ENV_VARS` entries with the same `{envVar, provider}` shape.)

2. Add `derivedNotes` to `StackProfile`:

```ts
  /** Human-readable source note per derived target name (for onboarding output). */
  derivedNotes: Record<string, string>;
```

3. Add the derivation function (after `buildTargetsFromEnvHints`):

```ts
/**
 * Derive targets for agents that need both a connection signal AND a matching
 * app dependency/file (gated derivation — keeps scans quiet on unrelated repos).
 *
 * SECURITY: notes contain env var NAMES and package names only, never values.
 */
export async function deriveGatedTargets(
  appStack: AppStackInfo,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ targets: TargetConfig[]; notes: Record<string, string> }> {
  const targets: TargetConfig[] = [];
  const notes: Record<string, string> = {};
  const deps = new Set(appStack.dependencies);

  // managed-database: parseable PG URL + a migration tool
  const pgEnvName = ['DATABASE_URL', 'POSTGRES_URL', 'PG_CONNECTION_STRING'].find((n) => env[n]);
  const migrationDep = ['prisma', '@prisma/client', 'drizzle-orm'].find((d) => deps.has(d));
  if (pgEnvName && migrationDep) {
    const parsed = parseConnectionString(env[pgEnvName]!);
    if (parsed && parsed.kind === 'postgresql') {
      const target: TargetConfig = {
        name: 'derived-managed-database',
        kind: 'managed-database',
        primary: { host: parsed.host, port: parsed.port, database: parsed.database },
      };
      if (parsed.username || parsed.password) {
        target.credentials = { type: 'value' as const, username: parsed.username, password: parsed.password };
      }
      targets.push(target);
      notes[target.name] = `from ${pgEnvName} + ${migrationDep}`;
    }
  }

  // message-queue: parseable redis URL + bullmq/bull
  const redisEnvName = ['REDIS_URL', 'REDIS_TLS_URL'].find((n) => env[n]);
  const queueDep = ['bullmq', 'bull'].find((d) => deps.has(d));
  if (redisEnvName && queueDep) {
    const raw = env[redisEnvName]!;
    const parsed = parseConnectionString(raw);
    if (parsed && parsed.kind === 'redis') {
      const target: TargetConfig = {
        name: 'derived-message-queue',
        kind: 'message-queue',
        primary: { host: parsed.host, port: parsed.port },
        queue: { tls: raw.startsWith('rediss:') },
      };
      if (parsed.username || parsed.password) {
        target.credentials = { type: 'value' as const, username: parsed.username, password: parsed.password };
      }
      targets.push(target);
      notes[target.name] = `from ${redisEnvName} + ${queueDep}`;
    }
  }

  // ai-provider: an API key present OR an AI SDK dependency
  const aiKeyName = AI_ENV_VARS.find((v) => env[v.envVar] !== undefined)?.envVar;
  const aiDep = appStack.dependencies.find((d) => d in AI_PROVIDER_DEPS);
  if (aiKeyName || aiDep) {
    const target: TargetConfig = {
      name: 'derived-ai-provider',
      kind: 'ai-provider',
      primary: { host: 'auto', port: 0 },
    };
    targets.push(target);
    notes[target.name] = aiKeyName ? `from ${aiKeyName}` : `from ${aiDep} dependency`;
  }

  // application-config: an env template file exists
  const envExample = await findEnvExample(cwd);
  if (envExample) {
    const target: TargetConfig = {
      name: 'derived-application-config',
      kind: 'application-config',
      primary: { host: 'auto', port: 0 },
    };
    targets.push(target);
    notes[target.name] = `from ${envExample.split('/').pop()}`;
  }

  return { targets, notes };
}
```

4. Wire into `discoverStack()` — replace the `derivedTargets` line and the return:

```ts
  const envHints = scanEnvHints();
  const aiProviders = detectAiProviders(appStack);
  const gated = await deriveGatedTargets(appStack, cwd);
  const derivedTargets = [...buildTargetsFromEnvHints(envHints), ...gated.targets];
  const vercelProject = readVercelProjectConfig(cwd);
```

and include `derivedNotes: gated.notes,` in the returned object.

5. Update `printOnboardingMessage`'s derived-target loop to use notes for `derived-*` targets:

```ts
  for (const target of profile.derivedTargets) {
    const note = profile.derivedNotes[target.name];
    if (note) {
      console.log(chalk.green(`    + ${target.kind}`) + chalk.dim(` (${note})`));
      continue;
    }
    const envName = target.name.replace(/^env-/, '').replace(/-/g, '_').toUpperCase();
    const host = target.primary ? `${target.primary.host}:${target.primary.port}` : 'unknown';
    console.log(chalk.green(`    + ${target.kind}`) + chalk.dim(` at ${host} (from ${envName})`));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/__tests__/autodiscovery-gated-targets.test.ts src/__tests__/autodiscovery.test.ts && pnpm run typecheck`
Expected: PASS — new tests plus existing autodiscovery tests. If existing tests construct a `StackProfile` literal, add `derivedNotes: {}` to those fixtures.

- [ ] **Step 6: Commit**

```bash
git add src/cli/autodiscovery.ts src/config/service-registry.ts src/__tests__/autodiscovery-gated-targets.test.ts src/__tests__/autodiscovery.test.ts
git commit -m "feat(autodiscovery): gated target derivation for the four wired agents"
```

---

### Task 9: Full verification — suite, fixture scan, honest-failure scan

**Files:**
- No source changes expected (fixes only if verification finds regressions).
- Create (scratch, not committed): a fixture app dir under the session scratchpad.

- [ ] **Step 1: Full unit suite + typecheck**

Run: `pnpm run typecheck && pnpm test`
Expected: typecheck clean; all tests pass (baseline was 1604 before this work; expect that plus the new test files from Tasks 1–8; zero failures).

- [ ] **Step 2: Build the fixture app dir**

```bash
FIXTURE=$(mktemp -d)
cat > "$FIXTURE/package.json" <<'EOF'
{
  "name": "fixture-app",
  "dependencies": { "@prisma/client": "^5.0.0", "bullmq": "^5.0.0", "@anthropic-ai/sdk": "^0.30.0" }
}
EOF
printf 'DATABASE_URL=\nREDIS_URL=\nANTHROPIC_API_KEY=\n' > "$FIXTURE/.env.example"
echo "$FIXTURE"
```

- [ ] **Step 3: Live scan against the podman test stack**

Start the stack if not running: `./test/podman/scripts/start.sh` (from the crisismode repo root). Then, using the podman PG connection values from `test/podman/` config (read the compose/env files there for the real user/password/port — do not guess):

```bash
cd "$FIXTURE" && \
DATABASE_URL="postgres://<user>:<pass>@localhost:<pgport>/<db>" \
REDIS_URL="redis://localhost:6379" \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
node /Users/aaronjohnson/repos/github/trs-80/crisismode-ai/crisismode/dist/cli/index.js scan --json 2>/dev/null | tail -1
```

(Build first with `pnpm run build` if `dist/` is stale; if the repo runs the CLI via tsx, use the equivalent dev entry — check `package.json` scripts for how `crisismode` runs locally.)

Expected in the JSON findings:
- A `managed-database (derived-managed-database)` finding with real signals (migration status / pool stats) — not simulated.
- A `message-queue (derived-message-queue)` finding — status `unknown` with "No BullMQ queues found" (the podman redis has no BullMQ data) **if redis is in the stack**; otherwise `unknown — could not connect`. Both are honest outcomes; simulated "healthy" is a failure.
- An `ai-provider (derived-ai-provider)` finding: with a real `ANTHROPIC_API_KEY` exported, a healthy/latency probe result; without one, an honest error finding.
- An `application-config (derived-application-config)` finding: unhealthy/recovering drift report naming the missing env keys (names only — verify no values appear anywhere in the output).

- [ ] **Step 4: Honest-failure scan with services stopped**

```bash
cd "$FIXTURE" && \
DATABASE_URL="postgres://app:pw@localhost:59999/appdb" \
REDIS_URL="redis://localhost:59998" \
node /Users/aaronjohnson/repos/github/trs-80/crisismode-ai/crisismode/dist/cli/index.js scan --json 2>/dev/null | tail -1
```

Expected: `managed-database` and `message-queue` findings with status `unknown` and an error summary (connect failure or health-check timeout). **Grep the output to confirm nothing reports simulated healthy data and no password appears:**

```bash
<scan output> | grep -ci "simulat" # expect 0 in findings
<scan output> | grep -c "pw"       # expect 0 occurrences of the password value
```

- [ ] **Step 5: Commit any verification fixes and record results**

If Steps 3–4 required source fixes, commit them individually (`fix(scope): ...`). Then record the verification evidence (commands + observed findings) in the PR description when the branch goes up for review. Do not claim pass without the actual output.

---

## Self-Review Notes

- Spec coverage: schema options (Task 1), factory (Task 2), four wirings (Tasks 3–6), redis migration (Task 7), gated derivation + onboarding + AI_ENV_VARS dedup + prisma registry entry (Task 8), security greps + live validation (Task 9). Out-of-scope items from the spec remain untouched.
- Exact export names for manifests/agents/simulators in Tasks 4 and 6 must be confirmed against the current files before overwriting (each task says so) — the registry (`src/config/builtin-agents.ts`) imports these registrations by name, and those import sites must not change.
- `HealthSignal` uses `source`/`status`/`detail`/`observedAt` and both `HealthStatus` and `HealthSignalStatus` include `'unknown'` (verified in `src/types/health.ts`).
