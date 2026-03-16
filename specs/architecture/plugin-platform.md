# Plugin Platform Architecture Guide

**Version:** 0.1-draft  
**Status:** Design Guide  
**Date:** 2026-03-15  
**Companion to:** [Recovery Agent Contract](../foundational/recovery-agent-contract.md), [Deployment & Operations](../deployment/operations.md)

---

## 1. Problem Statement

CrisisMode's current implementation is intentionally small: a framework kernel, a PostgreSQL recovery agent, and a Redis recovery agent. That shape is productive for an MVP, but it does not scale cleanly to the product surface the project is aiming toward.

The long-term target is much larger:

- Many target systems: Kubernetes, MySQL, PostgreSQL, Redis, ElastiCache, HAProxy, Nginx, Apache, AWS services, Google Cloud services, and more.
- Many recovery modes per target system: lag, exhaustion, drift, failover, saturation, misconfiguration, control plane impairment, and service-specific failure patterns.
- Many signal sources: Prometheus, DataDog, Grafana, CloudWatch, PagerDuty, and other observability or alerting systems.
- Many execution environments: Kubernetes clusters, cloud-managed services, on-premise estates, and mixed topologies.

If this growth is modeled as "one top-level agent per exact product/problem pair," the project becomes difficult to contribute to, difficult to reason about during an incident, and difficult to secure. Contributors would repeatedly reimplement similar abstractions, and operators would have to navigate a flat, ever-growing catalog of highly specific agents.

This guide defines a scalable architecture for moving from a small set of bespoke agents to a plugin platform built around a strict kernel and a large ecosystem of reusable packs and providers.

---

## 2. Design Goals

This architecture is intended to preserve the safety and clarity of the current framework while making the system practical to extend across hundreds or thousands of products.

### 2.1 Primary goals

- **Keep the kernel small and strict.** Validation, policy, approvals, capture execution, provider resolution, forensics, and simulation remain framework responsibilities.
- **Specialize by domain and scenario, not by every individual repair action.** Experts should contribute focused recovery logic without reimplementing framework behavior.
- **Make execution compositional.** Recovery plans should depend on typed capabilities, not direct agent-to-agent calls or opaque shell logic.
- **Scale contributor onboarding.** A scenario author should not need deep knowledge of the execution engine or every supported product.
- **Preserve safety under abstraction.** Higher-level authoring helpers must not hide what system is touched, what provider executes the action, or how success is verified.
- **Support incremental adoption.** The current `src/agent/` layout and `RecoveryAgent` contract remain usable during migration.

### 2.2 Non-goals

- This document does not replace the foundational recovery contract.
- This document does not define a new conformance standard.
- This document does not require an immediate codebase reorganization.
- This document does not prescribe final wire formats for every future plugin manifest or hub API.

---

## 3. Platform Layers

The platform should be understood as five cooperating layers.

### 3.1 Safety kernel

The kernel is the durable center of the system. It owns:

- plan validation
- policy enforcement
- approval routing
- state capture orchestration
- provider resolution
- execution orchestration
- forensic record assembly
- simulation and contract-test harnesses

The kernel does **not** own product-specific diagnosis logic or vendor-specific API semantics.

### 3.2 Signal layer

Signal plugins convert external incidents into CrisisMode triggers and evidence references.

Examples:

- Prometheus AlertManager webhook normalization
- DataDog monitor payload normalization
- CloudWatch alarm adaptation
- PagerDuty incident enrichment

Signal plugins are primarily ingress and normalization components, not repair logic.

### 3.3 Domain intelligence layer

Domain packs group operational knowledge for a broad system area such as databases, orchestration, traffic, cloud, or observability. They host scenario modules and shared heuristics.

Examples:

- `databases/postgres`
- `orchestration/kubernetes`
- `traffic/haproxy`
- `cloud/aws`

### 3.4 Capability provider layer

Capability providers implement typed actions and checks against real systems. They are the operational bridge between plan intent and concrete execution.

Examples:

- run a read query against PostgreSQL
- detach a backend from HAProxy
- cordon a Kubernetes node
- fail over an RDS cluster
- create a silence in DataDog

### 3.5 Evidence layer

Evidence providers gather reusable diagnostic inputs and snapshots.

Examples:

- query metrics
- collect logs
- fetch traces
- snapshot a dashboard
- dump configuration
- resolve topology relationships

Signal, capability, and evidence layers may target the same vendor, but they remain separate concepts because they serve different responsibilities.

---

## 4. Plugin Taxonomy

The platform should standardize on five plugin classes.

### 4.1 Signal adapter

Converts vendor-specific events into a normalized incident context.

Examples:

- `prometheus-alertmanager`
- `datadog-monitors`
- `cloudwatch-alarms`

### 4.2 Domain pack

Owns a coherent operational surface and groups related scenario modules, shared diagnosis helpers, fixtures, and metadata.

Examples:

- `postgres`
- `mysql`
- `redis`
- `kubernetes`
- `haproxy`
- `aws-rds`

### 4.3 Scenario module

Encodes diagnosis and planning logic for one concrete failure mode within a domain pack.

Examples:

- `postgres.replication_lag_cascade`
- `postgres.replication_slot_overflow`
- `redis.memory_pressure`
- `kubernetes.crashloop_cascade`

### 4.4 Capability provider

Implements one or more typed execution capabilities. A capability provider is selected by the kernel at validation or execution time.

Examples:

- `postgres-sql`
- `haproxy-runtime-api`
- `k8s-api`
- `aws-rds-sdk`

### 4.5 Evidence provider

Collects reusable evidence or state snapshots for diagnosis, safety, and forensics.

Examples:

- `prometheus-query`
- `grafana-dashboard-snapshot`
- `cloudwatch-metrics`
- `topology-cache`

### 4.6 Why this taxonomy

This split prevents several common failure modes:

- signal adapters do not become accidental recovery engines
- scenario modules do not need to know vendor SDK details
- providers do not need to embed diagnosis policy
- evidence collection can evolve separately from action execution

---

## 5. Core Contracts

The contracts below are intentionally illustrative. They define the minimum concepts the implementation should grow toward without freezing every field up front.

> **Implementation status:** Phase 1 of the migration (Section 10) is complete. The current codebase implements a subset of these contracts using pragmatic types optimized for the current `RecoveryAgent`-based architecture. The subsections below note implementation status and any divergences between the illustrative contracts and the implemented types. Contracts marked **[Implemented]** have corresponding types in `src/types/plugin.ts`. Contracts marked **[Future]** are design targets for Phase 2+.

### 5.1 `IncidentContext`

Purpose: the normalized bundle of trigger, topology, policy, reachability, evidence references, and provider availability used during diagnosis and planning.

```ts
interface IncidentContext {
  incidentId: string;
  trigger: {
    source: string;
    kind: 'alert' | 'health_check' | 'manual';
    severity: string;
    rawRef?: string;
  };
  affectedResources: ResourceRef[];
  evidence: EvidenceRef[];
  environment: {
    name: string;
    connectivity: 'connected' | 'degraded' | 'disconnected';
  };
  policy: {
    trustLevel: string;
    requireApprovalForAllElevated: boolean;
  };
  availableProviders: string[];
}
```

**Status: [Future]** — The current architecture uses `AgentContext` (defined in the foundational spec) for this role. `IncidentContext` is a Phase 2+ migration target that consolidates trigger, topology, policy, and evidence into a single normalized bundle.

### 5.2 `ResourceRef`

Purpose: canonical identity for a target touched by diagnosis, validation, or execution.

```ts
interface ResourceRef {
  kind: string;
  platform: string;
  identifier: string;
  region?: string;
  namespace?: string;
  labels?: Record<string, string>;
}
```

**Status: [Future]** — The current architecture uses bare `string` identifiers for targets and components. `ResourceRef` is a Phase 2+ migration target.

### 5.3 `CapabilityRef`

Purpose: normalized description of an action or check required by a plan step.

```ts
interface CapabilityRef {
  name: string;
  actionKind: 'read' | 'mutate' | 'check' | 'capture';
  target: ResourceRef;
  parameters?: Record<string, unknown>;
}
```

**Status: [Future]** — This is a runtime invocation reference. The current implementation uses `CapabilityDefinition` (a registry entry) instead:

```ts
// Implemented in src/types/plugin.ts
interface CapabilityDefinition {
  id: string;
  actionKind: 'read' | 'mutate' | 'check' | 'capture';
  description: string;
  targetKinds: string[];
  manualFallback?: string;
}
```

`CapabilityDefinition` is a registry entry that describes what a capability is, while `CapabilityRef` is a runtime reference used to invoke it. Both are needed: `CapabilityDefinition` exists today for registry and validation; `CapabilityRef` will be introduced when capability providers implement the `execute()` interface.

Examples:

- `db.query.read`
- `db.replica.disconnect`
- `traffic.backend.detach`
- `k8s.node.cordon`
- `obs.alert.silence.create`

### 5.4 `EvidenceRef`

Purpose: reference to collected or collectable evidence used during diagnosis, capture, or forensic review.

```ts
interface EvidenceRef {
  kind: 'metric' | 'log' | 'trace' | 'dashboard' | 'config' | 'topology';
  provider: string;
  subject: string;
  locator?: string;
  capturedAt?: string;
}
```

**Status: [Future]** — Evidence is currently embedded directly in `DiagnosisFinding.data`. The `EvidenceRef` type will be introduced alongside `EvidenceProvider` in Phase 4.

### 5.5 `SafetyEnvelope`

Purpose: the safety metadata that accompanies an executable action regardless of product.

```ts
interface SafetyEnvelope {
  riskLevel: 'routine' | 'elevated' | 'high' | 'critical';
  blastRadius: {
    directComponents: string[];
    indirectComponents: string[];
    maxImpact: string;
  };
  preconditions: string[];
  successChecks: string[];
  requiredCaptures: string[];
  rollbackSummary?: string;
}
```

**Status: [Future]** — These fields currently exist as individual properties on `SystemActionStep` (`riskLevel`, `blastRadius`, `preConditions`, `successCriteria`, `statePreservation`, `rollback`). The consolidated `SafetyEnvelope` type is a Phase 3+ refactoring target.

### 5.6 `PluginManifest`

Purpose: minimal metadata shared by all plugin classes.

```ts
// Illustrative target contract
interface PluginManifest {
  id: string;
  kind: 'signal_adapter' | 'domain_pack' | 'scenario_module' | 'capability_provider' | 'evidence_provider';
  version: string;
  owner: string;
  maturity: 'experimental' | 'simulator_only' | 'dry_run_only' | 'live_validated' | 'production_certified';
  supportsDryRun: boolean;
  supportsSimulation: boolean;
}
```

**Status: [Implemented — reduced]** — The current implementation uses `PluginMetadata`, a lightweight subset embedded in `AgentManifest.metadata.plugin`:

```ts
// Implemented in src/types/plugin.ts
interface PluginMetadata {
  id: string;
  kind: PluginKind;
  maturity: PluginMaturity;
  compatibilityMode?: 'recovery_agent';
}
```

Fields `version`, `owner`, `supportsDryRun`, and `supportsSimulation` are deferred to Phase 2 when plugins become independently versioned and distributable packages. `compatibilityMode` was added to bridge the current `RecoveryAgent` architecture with the future plugin model.

### 5.7 `ScenarioModule`

Purpose: targeted diagnosis and planning logic for one failure mode.

```ts
interface ScenarioModule {
  manifest: PluginManifest;
  scenarioId: string;
  products: string[];
  requiredCapabilities: string[];
  diagnose(ctx: IncidentContext): Promise<DiagnosisResult>;
  plan(ctx: IncidentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan>;
}
```

**Status: [Future]** — Phase 3. Current scenario logic is embedded in `RecoveryAgent` implementations (e.g., `src/agent/pg-replication/agent.ts`).

### 5.8 `CapabilityProvider`

Purpose: safe execution and dry-run support for one or more capabilities.

```ts
interface CapabilityProvider {
  manifest: PluginManifest;
  capabilities: string[];
  supports(target: ResourceRef, capability: CapabilityRef): Promise<boolean>;
  dryRun(capability: CapabilityRef, ctx: IncidentContext): Promise<unknown>;
  execute(capability: CapabilityRef, ctx: IncidentContext): Promise<unknown>;
}
```

**Status: [Future]** — Phase 2. The current implementation uses a descriptor-based approach instead of a method-based interface:

```ts
// Implemented in src/types/plugin.ts
interface CapabilityProviderDescriptor {
  id: string;
  kind: 'capability_provider';
  name: string;
  maturity: PluginMaturity;
  capabilities: string[];
  executionContexts: string[];
  targetKinds: string[];
  commandTypes: Command['type'][];
  supportsDryRun: boolean;
  supportsExecute: boolean;
}
```

`CapabilityProviderDescriptor` is a static metadata declaration used by the provider registry (`src/framework/provider-registry.ts`) for resolution. The runtime `CapabilityProvider` interface with `supports()`, `dryRun()`, and `execute()` methods will be introduced in Phase 2 when providers become independently loadable plugins.

### 5.9 `SignalAdapter`

Purpose: normalize external payloads into a CrisisMode incident context seed.

```ts
interface SignalAdapter {
  manifest: PluginManifest;
  source: string;
  normalize(payload: unknown): Promise<{
    trigger: IncidentContext['trigger'];
    affectedResources: ResourceRef[];
    evidence: EvidenceRef[];
  }>;
}
```

**Status: [Future]** — Phase 4. Alert normalization currently exists in the webhook receiver (`src/webhook.ts`) as direct code.

### 5.10 `EvidenceProvider`

Purpose: retrieve evidence snapshots or enrich context without becoming an execution provider.

```ts
interface EvidenceProvider {
  manifest: PluginManifest;
  kinds: EvidenceRef['kind'][];
  collect(ref: EvidenceRef, ctx: IncidentContext): Promise<unknown>;
}
```

**Status: [Future]** — Phase 4. Evidence collection is currently embedded in agent diagnosis methods.

### 5.11 `ProviderResolutionResult`

Purpose: explicit answer from the kernel about whether a capability is executable in the current environment.

```ts
interface ProviderResolutionResult {
  capability: string;
  resolved: boolean;
  providerId?: string;
  reason?: string;
  blockingPolicy?: string;
}
```

**Status: [Implemented — reduced]** — The current implementation uses `CapabilityProviderResolution`:

```ts
// Implemented in src/types/plugin.ts
interface CapabilityProviderResolution {
  capability: string;
  resolved: boolean;
  providerId?: string;
  reason?: string;
}
```

The `blockingPolicy` field from the illustrative contract is deferred to Phase 2 when policy-based provider blocking is implemented.

### 5.12 `ScenarioContractTest`

Purpose: fixture-driven expectation that a scenario module behaves safely and predictably.

```ts
interface ScenarioContractTest {
  fixtureId: string;
  input: IncidentContext;
  expectedScenario: string;
  expectedPlanValidity: boolean;
  requiredCapabilities: string[];
}
```

**Status: [Future]** — Phase 3. Current testing uses standard unit tests against simulator backends.

---

## 6. Runtime Flow

The proposed runtime flow extends the current framework rather than replacing it.

1. A signal adapter normalizes an external event into an incident context seed.
2. The kernel enriches that seed with policy, topology, and provider availability.
3. A domain pack is selected based on affected resources and trigger characteristics.
4. Candidate scenario modules are ranked within that domain pack.
5. A scenario module diagnoses the issue and proposes a recovery plan.
6. The kernel validates the plan, including capability resolution and safety checks.
7. Each executable step is bound to a concrete capability provider.
8. The kernel handles approvals, captures, dry-run or execute behavior, and forensics.
9. Evidence providers and signal adapters may contribute additional snapshots or updates throughout execution.

### 6.1 Capability graph instead of agent dependency tree

The kernel should reject direct agent-to-agent execution dependencies as the primary composition model.

Preferred model:

- scenario declares `traffic.backend.detach`
- provider registry resolves it to an HAProxy, Nginx, Envoy, or cloud load balancer provider
- policy and environment determine whether that provider may execute now

Avoided model:

- PostgreSQL agent directly depends on HAProxy agent
- Redis agent directly invokes Grafana agent

This keeps operational dependencies explicit and testable.

---

## 7. Safety Model

The architecture preserves the core principle from the foundational spec: agents propose, the framework disposes.

### 7.1 Responsibilities

The framework remains responsible for:

- validating plans against manifests and policy
- resolving capabilities to concrete providers
- blocking unresolved or unsupported live actions
- orchestrating captures
- enforcing approvals
- executing dry-run and live behavior consistently
- producing forensic records
- supporting simulation and contract testing

Scenario authors remain responsible for:

- diagnosis logic
- declaring intent
- selecting safe plan shape
- declaring risk
- declaring success criteria
- declaring blast radius and rollback intent

Provider authors remain responsible for:

- safe execution semantics
- dry-run fidelity
- target-specific error handling
- explicit unsupported-operation failures
- integration credentials and environment assumptions

### 7.2 Provider resolution rules

Provider resolution should consider at least:

- capability name match
- target kind or platform match
- environment match
- credential availability
- policy allowlist or denylist
- live versus dry-run support
- simulation support
- plugin maturity

If a required capability is unresolved, the plan should fail validation before live execution begins.

### 7.3 Maturity model

Plugins and providers should advertise maturity explicitly:

- `experimental`
- `simulator_only`
- `dry_run_only`
- `live_validated`
- `production_certified`

This provides a clearer operator experience than implying equal trust across all integrations.

---

## 8. Contributor Model

The architecture is intended to reduce contributor burden by creating narrower authoring lanes.

### 8.1 Scenario authors

Scenario authors should mostly work with:

- incident context
- diagnosis helpers
- step builders
- capability builders
- fixtures
- scenario contract tests

They should not need deep knowledge of:

- the execution engine internals
- every provider implementation
- approval transport details
- forensic storage internals

### 8.2 Provider authors

Provider authors should mostly work with:

- capability contracts
- live API or protocol integrations
- dry-run semantics
- permission modeling
- provider-specific tests

They should not need to encode recovery diagnosis policy.

### 8.3 Signal and evidence authors

These contributors should focus on:

- payload normalization
- evidence collection
- metadata mapping
- incident enrichment

They should not need to author recovery plans.

### 8.4 Authoring ergonomics

The long-term authoring experience should prefer helpers over raw object construction.

Examples:

- `steps.systemAction(...)`
- `caps.dbReplicaDisconnect(...)`
- `checks.replicaLagAbove(...)`
- `captures.dashboardSnapshot(...)`
- `scenarioFixture(...)`

These helpers should reduce boilerplate without hiding safety-critical intent.

---

## 9. Package Layout

The future layout should separate kernel concerns from plugin concerns.

```text
src/
  kernel/
    execution/
    policy/
    registry/
    forensics/
    simulation/

  contracts/
    incident/
    capability/
    evidence/
    plugin/
    resource/

  plugins/
    signals/
    domains/
      databases/
      orchestration/
      traffic/
      cloud/
      observability/
    providers/
    evidence/

  authoring/
    steps/
    capabilities/
    captures/
    checks/
    fixtures/
```

### 9.1 Mapping from today's repo

This guide does not invalidate the current code layout. It maps current structures into the future model.

| Current repo concept | Proposed model |
|---|---|
| `RecoveryAgent` | Compatibility wrapper around domain pack + scenario selection |
| `src/agent/pg-replication/agent.ts` | PostgreSQL domain-pack-compatible module with embedded scenario logic |
| `src/agent/redis/agent.ts` | Redis domain-pack-compatible module with embedded scenario logic |
| `manifest.ts` | Early form of plugin metadata |
| `backend.ts` / simulator / live client | Early capability-provider-compatible execution implementations |
| `ExecutionEngine` | Kernel execution and orchestration layer |
| `src/framework/provider-registry.ts` | Kernel provider resolution layer (Phase 2 partially complete) |
| `src/framework/capability-registry.ts` | Kernel capability vocabulary registry (Phase 1 complete) |
| `src/types/plugin.ts` | Early plugin type definitions (`PluginMetadata`, `CapabilityDefinition`, `CapabilityProviderDescriptor`, `CapabilityProviderResolution`) |
| `src/config/agent-registry.ts` | Agent selection with version-aware matching (precursor to domain pack routing) |
| `src/framework/operator-summary.ts` | Kernel operator-facing health and readiness system |
| `src/framework/ai-diagnosis.ts` | Framework AI diagnosis toolkit (reusable across agents) |
| `src/framework/ai-explainer.ts` | Framework AI plan explanation service |

### 9.2 Example mapping for existing implementations

**PostgreSQL today**

- current: one `pg-replication` agent containing diagnosis, planning, and execution assumptions
- future: `databases/postgres` domain pack with scenario modules such as:
  - `replication_lag_cascade`
  - `replication_slot_overflow`
  - `replica_divergence`

Likely providers:

- `postgres-sql`
- `load-balancer-runtime`
- `replica-reseed`

**Redis today**

- current: one `redis` agent centered on memory recovery
- future: `databases/redis` domain pack with scenario modules such as:
  - `memory_pressure`
  - `client_exhaustion`
  - `slow_query_storm`

Likely providers:

- `redis-admin`
- `traffic-backend-control`
- `metrics-evidence`

---

## 10. Migration Plan

The migration path is intentionally incremental. The goal is to improve architecture without forcing a destabilizing rewrite.

### Phase 0: Vocabulary and compatibility

**Objective**

Introduce the plugin-platform vocabulary in documentation and design discussions.

**Code boundary introduced**

- No runtime boundary changes.
- Documentation and diagrams may refer to domain packs, scenario modules, and capability providers.

**Backward compatibility**

- All current code and runtime behavior remain unchanged.
- `RecoveryAgent` remains the primary authoring and runtime abstraction.

**Exit criteria**

- Shared terminology exists in docs.
- Current agents are understood as domain-pack-compatible modules rather than one-off exceptions.

**Risks / do not do yet**

- Do not reorganize code just to match new names.
- Do not add parallel abstractions without a clear bridge to current code.

### Phase 1: Registry foundations

**Objective**

Add metadata and vocabulary needed to describe plugins and capabilities consistently.

**Code boundary introduced**

- plugin metadata schema
- capability vocabulary registry
- optional provider metadata declarations

**Backward compatibility**

- current agents still generate plans directly
- existing manifests remain valid, with additive metadata where needed

**Exit criteria**

- system actions can declare required capabilities in a normalized way
- validation can report unresolved required capabilities before execute mode

**Risks / do not do yet**

- do not force every provider into a final registry shape immediately
- do not block existing dry-run flows until capability metadata is available everywhere

### Phase 2: Provider resolution layer

**Objective**

Introduce provider-backed resolution behind the existing execution engine.

**Code boundary introduced**

- provider registry
- provider selection flow
- kernel-level provider resolution result reporting

**Backward compatibility**

- `ExecutionBackend` remains a usable bridge during migration
- current PostgreSQL simulator and live client paths remain supported

**Exit criteria**

- executable capabilities resolve to concrete providers
- unsupported live actions fail validation or dispatch explicitly
- dry-run support is declared per provider

**Risks / do not do yet**

- do not remove direct backend support before providers cover current flows
- do not introduce agent-to-agent orchestration as a shortcut

### Phase 3: Scenario extraction

**Objective**

Separate scenario logic from broad agent wrappers.

**Code boundary introduced**

- scenario module interfaces
- step builders, capability builders, capture helpers, check helpers
- fixture-driven scenario contract tests

**Backward compatibility**

- `RecoveryAgent` remains as a wrapper that selects a scenario module and adapts to current framework contracts
- existing manifests and plan types remain in use

**Exit criteria**

- PostgreSQL and Redis logic are split into clearly named scenario modules
- scenario contract tests exist for core failure modes

**Risks / do not do yet**

- do not move all files at once
- do not duplicate scenario logic in both old and new locations without a thin wrapper strategy

### Phase 4: Signal and evidence plugins

**Objective**

Extract alert normalization and reusable evidence collection into dedicated plugin classes.

**Code boundary introduced**

- signal adapter interfaces
- evidence provider interfaces
- normalized incident context assembly pipeline

**Backward compatibility**

- existing webhook entrypoints can wrap the new adapters
- current forensic and validation flows remain kernel-owned

**Exit criteria**

- Prometheus path is modeled as a signal adapter
- DataDog, Grafana, CloudWatch, and PagerDuty examples are documented
- evidence collection becomes reusable across multiple scenario modules

**Risks / do not do yet**

- do not let observability plugins absorb recovery logic by accident
- do not tie evidence collection to one transport or vendor

### Phase 5: Repository reorganization

**Objective**

Move implementation files into the long-term kernel/contracts/plugins layout only after the abstractions have proven stable.

**Code boundary introduced**

- `src/kernel/`
- `src/contracts/`
- `src/plugins/`
- `src/authoring/`

**Backward compatibility**

- compatibility shims remain for existing import paths during migration windows
- older agent-centric entrypoints remain functional until deprecation is complete

**Exit criteria**

- dominant code paths use plugin-platform abstractions directly
- old compatibility shims are small and well-understood

**Risks / do not do yet**

- do not lead with a directory move before runtime and test abstractions exist
- do not break contributor onboarding by renaming everything at once

---

## 11. Open Questions Deferred

The following topics are intentionally deferred until the abstractions above exist in code:

- final wire format for plugin distribution and loading
- version negotiation across hub and spoke plugin catalogs
- whether some cloud providers are modeled as product-specific domain packs or shared cloud packs with product overlays
- whether provider resolution should support multi-provider fallback chains in Phase 1 or wait until later
- how much of plugin metadata belongs in repo files versus hub-managed registration

These questions are important, but they should be answered after the capability and provider model exists in code rather than before.

---

## 12. Test and Acceptance Guidance

The migration should be considered successful only if the platform gains structure without losing safety or operability.

### 12.1 Required test categories

- **Scenario contract tests:** given a fixture, the expected scenario is chosen and a valid plan is produced.
- **Provider contract tests:** dry-run, execute, unsupported capability handling, and permission failures behave explicitly.
- **Resolution tests:** capability resolution produces actionable success and failure outputs.
- **Simulation tests:** scenario + provider + policy + forensics work without real infrastructure.
- **Compatibility tests:** existing PostgreSQL and Redis flows keep working during early migration phases.

### 12.2 Documentation acceptance criteria

This guide is useful when:

- terminology is consistent
- the migration phases are decision-complete
- responsibilities are clearly split between scenario authors, provider authors, and the kernel
- the current repo can be mapped to the future architecture without guesswork

---

## 13. Closing Principle

The core design rule for the plugin platform is:

**Scenarios decide what should happen. Providers decide how it happens. The kernel decides whether it is safe to happen.**

That separation keeps the system extensible for a very large product surface while preserving the project’s most important property: safe, explainable recovery under crisis conditions.
