# Recovery Agent Contract Specification

**Version:** 0.3.0-draft
**Status:** Draft — Post-Implementation Reconciliation
**Date:** 2026-03-15
**Authors:** [Your Name]
**Supersedes:** 0.2.1-draft

---

## Abstract

This specification defines the contract between **Recovery Agents** and the **Recovery Framework** — an open platform for building, testing, and executing autonomous and semi-autonomous agents that restore IT systems to health during severe incidents. The framework provides safety guarantees, forensic state preservation, human-in-the-loop coordination, and stakeholder communication as first-class primitives. Agents built against this contract inherit these capabilities without implementing them independently.

The framework is designed for **crisis conditions** — it is the tool an organization reaches for when normal operational tooling has failed or is insufficient. This context shapes every design decision: the system must function when infrastructure is degraded, when people are under pressure, and when the cost of a wrong action is highest.

This document is the authoritative definition of the agent contract. For implementation guides, tutorials, and SDK documentation, see the companion documentation site.

### Specification Phasing

This specification marks requirements by implementation phase:

- **[Phase 1]** — Normative for this version. MUST be implemented for conformance.
- **[Phase 2]** — Reserved for future specification. Design space is protected; Phase 1 implementations MUST NOT preclude these capabilities.
- **[Phase 3]** — Long-term roadmap. Described for architectural context only.

Requirements without a phase marker are **[Phase 1]** by default.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Architecture Overview](#2-architecture-overview)
3. [Framework Degradation Layers](#3-framework-degradation-layers)
4. [Agent Manifest](#4-agent-manifest)
5. [Agent Lifecycle](#5-agent-lifecycle)
6. [Recovery Plan](#6-recovery-plan)
7. [Step Types](#7-step-types)
8. [Risk Classification](#8-risk-classification)
9. [State Preservation](#9-state-preservation)
10. [Human Interaction Model](#10-human-interaction-model)
11. [Stakeholder Communication](#11-stakeholder-communication)
12. [Context and Observability](#12-context-and-observability)
13. [Trust and Permission Model](#13-trust-and-permission-model)
14. [Blast Radius](#14-blast-radius)
15. [Execution Contexts](#15-execution-contexts)
16. [Replanning](#16-replanning)
17. [Pre-Authorized Action Catalogs](#17-pre-authorized-action-catalogs)
18. [Audit and Forensic Record](#18-audit-and-forensic-record)
19. [Error Handling and Rollback](#19-error-handling-and-rollback)
20. [Agent Packaging and Distribution](#20-agent-packaging-and-distribution)
21. [Conformance](#21-conformance)
22. [Security Considerations](#22-security-considerations)
23. [Future Capabilities](#23-future-capabilities)
24. [Appendix A: Schema References](#appendix-a-schema-references)
25. [Appendix B: Example Agent — PostgreSQL Replication Recovery](#appendix-b-example-agent--postgresql-replication-recovery)
26. [Appendix C: Revision History](#appendix-c-revision-history)

---

## 1. Introduction

### 1.1 Problem Statement

Modern IT infrastructure relies on a broad ecosystem of tools for building, deploying, and monitoring systems. However, when systems enter a degraded or failed state — particularly during severe incidents beyond routine operational failures — the tooling for automated recovery is fragmented, ad hoc, and largely manual. Recovery knowledge lives in runbooks that go stale, in the heads of senior engineers who may not be available, and in post-incident review documents that are difficult to operationalize.

### 1.2 Design Context: Built for Crisis

This system is not a general-purpose automation platform. It is designed for the specific moment when an organization's normal operational tools and processes have failed or are insufficient. This context drives several non-obvious design decisions:

- The framework itself must function when infrastructure is degraded. A recovery tool that requires a fully healthy infrastructure to operate is useless.
- Plans must be simple enough for a stressed human to read and approve in minutes, not hours. Sophisticated control flow creates cognitive load that is dangerous during a crisis.
- Safety mechanisms must be robust against social pressure to bypass them. During an outage, there is enormous pressure to "just fix it." The system must channel that urgency into fast, safe action rather than unsafe shortcuts.
- The cost of inaction is also a risk. Every minute of prolonged outage causes harm — financial, reputational, and sometimes to human safety. The system must balance safety against speed, not optimize for safety alone.
- Forensic preservation matters because the organization will need to understand what happened after the crisis passes. Regulatory, legal, and learning requirements do not disappear because the incident was stressful.

### 1.3 Design Goals

- **Safety by default.** Agents inherit safety guarantees from the framework. An agent that follows this contract cannot bypass state preservation, skip approval gates, or exceed its declared blast radius without the framework detecting and preventing it.
- **Forensic-first recovery.** The framework captures system state before mutating actions, preserving evidence for post-incident analysis, compliance, and learning — within the constraints of system health and capture cost.
- **Human-in-the-loop as a first-class citizen.** Human notification, approval, escalation, and communication are structured primitives with the same rigor as system actions.
- **Approval speed, not approval bypass.** The system makes approval fast for known scenarios through pre-authorization, rather than providing mechanisms to skip approval under pressure.
- **Graduated trust.** Agents earn autonomy over time through demonstrated reliability in specific scenarios and environments.
- **Graceful degradation.** The framework sheds capabilities progressively as the environment degrades, rather than failing entirely. Recovery capability is always available at some level.
- **Technology agnosticism.** The contract is independent of any specific infrastructure technology.
- **Plans are readable, not programmable.** Recovery plans are linear sequences with limited, bounded decision points that a human can comprehend under pressure.
- **Adaptability through replanning, not branching.** When conditions change during recovery beyond what simple decision points can handle, the agent produces a new plan rather than navigating a complex graph.

### 1.4 Relationship to the Framework

This specification defines the **contract** — the interface between agents and the framework. It does not define the framework's internal implementation. A conforming framework MUST enforce the requirements placed on it by this specification. A conforming agent MUST adhere to the requirements placed on agents.

The key architectural principle is: **Agents propose, the framework disposes.** Agents produce Recovery Plans describing what they intend to do. The framework validates, orchestrates, and enforces those plans. Agents MUST NOT interact directly with target systems except through framework-mediated execution.

---

## 2. Architecture Overview

### 2.1 Components

The system consists of four primary components:

- **Agent**: A self-contained unit of recovery logic targeting a specific technology or failure domain. Agents observe system state, diagnose issues, and produce Recovery Plans.
- **Framework**: The layered runtime that manages agent registration, plan validation, execution orchestration, state preservation, human interaction, and audit logging. The framework consists of degradation layers described in Section 3.
- **Target System**: The infrastructure component being recovered. Agents declare which target systems they operate on.
- **Human Participants**: Engineers, incident commanders, executives, and other stakeholders who receive notifications, provide approvals, and make decisions during recovery. Identified by **role**, not by individual identity.

### 2.2 Execution Flow

A typical recovery execution follows this sequence:

```
 1. Trigger              → Framework receives trigger (alert, health check, manual)
 2. Catalog Check        → Framework checks pre-authorized action catalogs for matching scenario
 3. Agent Selection      → Framework identifies applicable agent(s) based on trigger context
 4. Context Assembly     → Framework assembles context bundle (system state, reachability)
 5. Diagnosis            → Agent performs read-only investigation
 6. Diagnostic Plan      → Agent MAY submit a lightweight diagnostic plan for investigative mutations
 7. Plan Creation        → Agent produces a Recovery Plan
 8. Plan Validation      → Framework validates plan against manifest, policies, and blast radius
 9. Catalog Match        → If plan matches a pre-authorized catalog entry, approval is pre-satisfied
10. Human Gates          → Framework executes approval gates per risk classification and trust level
11. Execution            → Framework orchestrates plan steps: snapshot → action → verify → notify
12. Replanning           → At declared checkpoints, agent may revise remaining plan
13. Completion           → Framework produces forensic record and triggers post-recovery notifications
```

### 2.3 Separation of Concerns

| Responsibility | Owner |
|---|---|
| Diagnosing the failure and proposing recovery steps | Agent |
| Declaring blast radius, risk levels, and rollback paths | Agent |
| Declaring required human interactions | Agent |
| Live system introspection during diagnosis | Agent (via read-only execution contexts) |
| Validating plans against organizational policies | Framework |
| Executing state preservation captures | Framework |
| Enforcing approval gates and escalation policies | Framework |
| Routing notifications to the correct channels (with fallback) | Framework |
| Producing the audit log and forensic record | Framework |
| Tracking agent trust metrics | Framework |
| Mediating all execution context access | Framework |

---

## 3. Framework Degradation Layers

The framework is designed as concentric layers of capability. As the environment degrades, the framework sheds outer layers while maintaining core recovery functionality. This is the architectural response to the product's central constraint: the system must work when other systems are failing.

### 3.1 Layer Model

```
┌─────────────────────────────────────────────────────┐
│  Layer 4: Enrichment                     [Phase 2+] │
│  Advanced trust analytics, stakeholder              │
│  communication rendering, observed impact           │
│  monitoring (Tier 3 blast radius), topology         │
│  feedback loop, historical analytics                │
├─────────────────────────────────────────────────────┤
│  Layer 3: Coordination                              │
│  Human approval routing via configured channels,    │
│  escalation management, notification delivery,      │
│  pre-authorized catalog matching,                   │
│  out-of-band fallback approval                      │
├─────────────────────────────────────────────────────┤
│  Layer 2: Safety                                    │
│  State preservation capture, plan validation        │
│  against manifest, execution context enforcement,   │
│  blast radius hard enforcement (Tier 1),            │
│  blast radius declaration validation (Tier 2),      │
│  forensic record assembly                           │
├─────────────────────────────────────────────────────┤
│  Layer 1: Execution Kernel                          │
│  Sequential plan execution, command dispatch to     │
│  target systems, precondition evaluation,           │
│  success criteria checks, local audit log,          │
│  step-level rollback                                │
└─────────────────────────────────────────────────────┘
```

### 3.2 Layer Requirements

**Layer 1 — Execution Kernel** (MUST always be available):

The execution kernel is the irreducible core. It can execute a validated plan's `system_action` steps sequentially, evaluate preconditions and success criteria, write a local append-only audit log, and execute stepwise rollback on failure. Layer 1 has zero external dependencies beyond access to the target system and local storage for audit logs.

**Layer 2 — Safety** (MUST be available under normal operation; SHOULD degrade gracefully):

Layer 2 adds state preservation captures, plan validation against the agent's manifest declarations, execution context scoping and enforcement, blast radius Tier 1 hard enforcement (verifying commands target only declared components), blast radius Tier 2 declaration validation (checking declared impact against available topology data for obvious omissions), and forensic record assembly.

If Layer 2's capture storage is unavailable, the framework MUST behave according to the capture's `capturePolicy` (see Section 9): `required` captures halt execution, `best_effort` captures are skipped with a log entry.

If Layer 2's topology data is unavailable for Tier 2 validation, the framework MUST log that Tier 2 validation was skipped and proceed with Tier 1 enforcement only. Tier 2 validation is best-effort by nature — it depends on topology data that may be stale or incomplete (Section 12.3).

**Layer 3 — Coordination** (SHOULD be available; fallback mechanisms defined):

Layer 3 adds human approval routing through configured channels (Slack, PagerDuty, email, etc.), escalation chain management, notification delivery, pre-authorized action catalog matching, and out-of-band fallback approval (Section 10.5).

If Layer 3's primary notification channels are unavailable, the framework MUST attempt the configured fallback approval mechanism (Section 10.5). If both primary and fallback channels are unavailable, the framework MUST pause execution at any `human_approval` step and retry both channels periodically. The framework MUST NOT proceed past a `human_approval` step without receiving approval through some channel.

**Layer 4 — Enrichment** [Phase 2]:

Layer 4 adds advanced trust analytics and progression recommendations, stakeholder communication with audience-aware template rendering, blast radius Tier 3 observed impact monitoring (post-execution anomaly detection), topology feedback loop (agent discoveries update the framework model), and historical analytics. Layer 4 is entirely optional for system operation. Its absence reduces the richness of validation and reporting but does not prevent recovery.

### 3.3 Layer Availability Detection

The framework MUST continuously assess the availability of each layer's dependencies and expose current layer status in the `AgentContext` (Section 12). Agents SHOULD adapt their plans based on available layers — for example, producing simpler plans with fewer captures when Layer 2 storage is constrained.

### 3.4 Design Constraint for Future Capabilities

All future capabilities defined in this specification (Phases 2 and 3) MUST be assigned to Layer 3 or Layer 4. Layers 1 and 2 MUST remain minimal and stable. No future feature may introduce a new external dependency into Layer 1.

---

## 4. Agent Manifest

Every agent MUST provide a manifest that declares its identity, capabilities, and requirements.

### 4.1 Manifest Schema

```json
{
  "$schema": "https://recoveryagents.dev/schema/manifest/v0.2.1",
  "apiVersion": "v0.2.1",
  "kind": "AgentManifest",
  "metadata": {
    "name": "postgresql-replication-recovery",
    "version": "1.2.0",
    "description": "Recovers PostgreSQL streaming replication failures including lag cascades, slot overflow, and replica divergence.",
    "authors": ["SRE Team <sre@example.com>"],
    "license": "Apache-2.0",
    "tags": ["postgresql", "replication", "database", "stateful"],
    "plugin": {
      "id": "postgresql.domain-pack",
      "kind": "domain_pack",
      "maturity": "live_validated",
      "compatibilityMode": "recovery_agent"
    }
  },
  "spec": {
    "targetSystems": [
      {
        "technology": "postgresql",
        "versionConstraint": ">=14.0 <18.0",
        "components": ["primary", "replica", "replication-slot"]
      }
    ],
    "triggerConditions": [
      {
        "type": "alert",
        "source": "prometheus",
        "matchLabels": { "alertname": "PostgresReplicationLagCritical" }
      },
      {
        "type": "health_check",
        "name": "pg_replication_status",
        "status": "degraded"
      },
      {
        "type": "manual",
        "description": "Operator-initiated replication recovery"
      }
    ],
    "failureScenarios": [
      "replication_lag_cascade",
      "replication_slot_overflow",
      "replica_divergence",
      "wal_sender_timeout"
    ],
    "executionContexts": [
      {
        "name": "postgresql_read",
        "type": "sql",
        "privilege": "read",
        "target": "postgresql",
        "capabilities": ["db.query.read", "db.replication.status"]
      },
      {
        "name": "postgresql_write",
        "type": "sql",
        "privilege": "write",
        "target": "postgresql",
        "capabilities": ["db.query.read", "db.query.write", "db.replica.disconnect", "db.replication.slot.manage"]
      },
      {
        "name": "linux_process",
        "type": "structured_command",
        "privilege": "process_management",
        "target": "linux",
        "allowedOperations": ["service_restart", "process_signal", "config_reload"]
      }
    ],
    "observabilityDependencies": {
      "required": ["pg_stat_replication", "pg_replication_slots"],
      "optional": ["prometheus_metrics", "pg_stat_wal_receiver"]
    },
    "riskProfile": {
      "maxRiskLevel": "high",
      "dataLossPossible": true,
      "serviceDisruptionPossible": true
    },
    "humanInteraction": {
      "requiresApproval": true,
      "minimumApprovalRole": "database_owner",
      "escalationPath": ["on_call_dba", "database_owner", "engineering_lead"]
    }
  }
}
```

### 4.2 Manifest Requirements

- `metadata.name` MUST be unique within a framework installation and MUST consist of lowercase alphanumeric characters, hyphens, and dots only.
- `metadata.version` MUST follow Semantic Versioning 2.0.0.
- `spec.targetSystems` MUST contain at least one entry.
- `spec.triggerConditions` MUST contain at least one entry.
- `spec.executionContexts` MUST enumerate every execution context the agent requires, with type, privilege, and target declared. See Section 15 for the execution context model. The framework MUST NOT grant contexts not listed in the manifest.
- `spec.failureScenarios` MUST enumerate the failure scenarios the agent handles. Trust is tracked per scenario (Section 13).
- `spec.riskProfile.maxRiskLevel` MUST be one of: `routine`, `elevated`, `high`, or `critical`. The framework MUST reject plans containing steps that exceed this declared maximum.
- `metadata.plugin` MUST provide plugin identity metadata including `id`, `kind`, `maturity`, and optionally `compatibilityMode`. See the Plugin Platform Architecture Guide for the full taxonomy.
- `spec.executionContexts[].capabilities` is OPTIONAL. When present, it declares the standard capability identifiers (from the capability registry) that this context can provide. The framework uses these for provider resolution during plan validation.

---

## 5. Agent Lifecycle

### 5.1 States

| State | Description |
|---|---|
| `registered` | Manifest accepted and validated. Agent is available for selection. |
| `invoked` | Framework has selected the agent and is assembling context. |
| `diagnosing` | Agent is performing read-only investigation. |
| `diagnostic_planning` | Agent has submitted a diagnostic plan for investigative mutations. |
| `planning` | Agent is constructing a Recovery Plan. |
| `awaiting_validation` | Plan submitted; framework is validating. |
| `awaiting_approval` | Plan validated; waiting for human approval. |
| `executing` | Framework is orchestrating the approved plan. |
| `replanning` | Agent is revising the plan at a replanning checkpoint. |
| `completed` | Execution finished successfully or with controlled rollback. |
| `failed` | Agent encountered an unrecoverable error. |
| `suspended` | Framework paused the agent due to a policy or trust violation. |

> **Implementation note [Phase 1]:** The agent lifecycle state machine is defined here as the authoritative behavioral model. Phase 1 implementations are NOT REQUIRED to track or expose agent state as a runtime value. The framework MUST enforce the behavioral constraints implied by the state machine (e.g., agents cannot mutate during `diagnosing`), but it MAY do so through interface design rather than explicit state tracking. Full state machine tracking with runtime-inspectable state is a [Phase 2] requirement.

### 5.2 State Transitions

Agents MUST NOT transition their own state. All transitions are managed by the framework.

```
registered → invoked                    Framework selects agent for trigger
invoked → diagnosing                    Framework delivers context bundle
diagnosing → diagnostic_planning        Agent submits diagnostic plan (optional)
diagnosing → planning                   Agent signals diagnosis complete
diagnosing → failed                     Agent cannot diagnose
diagnostic_planning → diagnosing        Diagnostic plan executed; agent resumes diagnosis
planning → awaiting_validation          Agent submits Recovery Plan
planning → failed                       Agent cannot produce viable plan
awaiting_validation → awaiting_approval Plan passes validation
awaiting_validation → planning          Plan rejected; agent may revise
awaiting_approval → executing           Approval received (human, pre-authorized, or fallback)
awaiting_approval → completed           Human rejects plan
executing → replanning                  Replanning checkpoint reached
replanning → awaiting_validation        Agent submits revised plan
replanning → executing                  Agent confirms current plan valid
executing → completed                   All steps executed
executing → failed                      Unrecoverable execution failure
any → suspended                         Trust/policy violation detected
suspended → registered                  Administrator reinstates agent
```

### 5.3 Agent Interface

A conforming agent MUST implement the following interface:

#### 5.3.0 `assessHealth(context: AgentContext) → HealthAssessment`

Called by the framework to obtain a lightweight, non-mutating health assessment of the agent's target system. This method enables the operator summary system (see companion specification) and proactive health monitoring without triggering full diagnosis or planning.

The `HealthAssessment` MUST include:

- `status`: One of `healthy`, `recovering`, `unhealthy`, or `unknown`.
- `confidence`: A float between 0.0 and 1.0.
- `summary`: Human-readable one-line summary.
- `observedAt`: ISO 8601 timestamp.
- `signals`: Array of `HealthSignal` observations (source, status, detail, timestamp).
- `recommendedActions`: Array of human-readable recommended next steps.

The framework MAY call `assessHealth()` independently of the full recovery lifecycle — for example, to populate dashboards or evaluate readiness before triggering a full recovery run. Agents MUST implement this method. The method MUST NOT perform mutating actions.

#### 5.3.1 `diagnose(context: AgentContext) → DiagnosisResult`

Called when the agent is invoked. The agent MUST perform read-only investigation using the provided context. The agent MUST NOT perform any mutating actions during `diagnose()`.

The `DiagnosisResult` MUST include:

- `status`: One of `identified`, `partial`, `inconclusive`, or `unable`.
- `scenario`: The identified failure scenario from the agent's manifest, if determined.
- `confidence`: A float between 0.0 and 1.0.
- `findings`: Structured description of observations.
- `diagnosticPlanNeeded`: Boolean indicating whether the agent needs to execute investigative mutations before planning. If `true`, the framework transitions to `diagnostic_planning`.

#### 5.3.2 `createDiagnosticPlan(context: AgentContext, diagnosis: DiagnosisResult) → RecoveryPlan` [Phase 2]

OPTIONAL. Reserved for Phase 2. Called when the agent needs to perform investigative mutations during diagnosis. Returns a Recovery Plan that MUST contain only `routine`-risk steps. The framework executes this plan with the same safety guarantees as a full recovery plan (state capture, audit logging), but with an expedited approval path: at `copilot` trust level and above, `routine`-risk diagnostic actions execute without approval. At `observe` trust level, approval is still required.

After the diagnostic plan executes, the framework re-invokes `diagnose()` with an updated context that includes the diagnostic plan's results.

#### 5.3.3 `plan(context: AgentContext, diagnosis: DiagnosisResult) → RecoveryPlan`

Called after successful diagnosis. Returns a Recovery Plan (Section 6). If the agent cannot produce a viable plan, it MUST return an error with a human-readable explanation.

#### 5.3.4 `replan(context: AgentContext, diagnosis: DiagnosisResult, executionState: ExecutionState) → ReplanResult`

Called at `replanning_checkpoint` steps during execution. The agent receives the original diagnosis plus the current execution state (which steps completed, their results, updated system observations). Returns one of:

- `continue`: The remaining plan is still valid. Execution proceeds.
- `revised_plan`: A new Recovery Plan for the remaining recovery. The framework validates and gates this plan with the same rigor as the original — unless `fastReplan` is enabled and conditions are met (Section 16.4).
- `abort`: The agent recommends halting recovery. The framework initiates rollback.

#### 5.3.5 `revisePlan(context: AgentContext, diagnosis: DiagnosisResult, feedback: PlanFeedback) → RecoveryPlan`

Called if a previously submitted plan was rejected during validation. `PlanFeedback` contains rejection reasons. The agent SHOULD attempt to produce a revised plan. The agent MAY return an error if revision is not possible.

`PlanFeedback` is defined as:

- `reasons`: Array of strings describing why the plan was rejected.

---

## 6. Recovery Plan

The Recovery Plan is the central artifact of the agent contract.

### 6.1 Design Philosophy: Readable Under Pressure

Recovery plans are linear sequences of steps with bounded decision points. They are designed to be read and understood by a human under pressure in minutes.

Plans do not contain general control flow (unbounded branching, loops, switches). They support a single level of binary decision via the `conditional` step type (Section 7.6), which allows the agent to declare two pre-validated alternative steps for a runtime check. This covers the most common operational decision ("if X, do A; otherwise do B") without introducing graph complexity.

When conditions change beyond what a binary decision point can handle, the agent produces a new plan through the replanning mechanism (Section 16).

This is a deliberate design choice for the crisis context. A plan with 10 sequential steps and one or two binary decision points is comprehensible at 3 AM during a P1 outage. A plan with 30 nodes, conditional branches, and loops is not. Simplicity under pressure is a safety feature.

### 6.2 Plan Schema

```json
{
  "$schema": "https://recoveryagents.dev/schema/recovery-plan/v0.2.1",
  "apiVersion": "v0.2.1",
  "kind": "RecoveryPlan",
  "metadata": {
    "planId": "rp-20260312-143022-pg-repl-001",
    "agentName": "postgresql-replication-recovery",
    "agentVersion": "1.2.0",
    "scenario": "replication_lag_cascade",
    "createdAt": "2026-03-12T14:30:22Z",
    "estimatedDuration": "PT15M",
    "summary": "Recover PostgreSQL replication by disconnecting lagging replicas, stabilizing the primary, and re-syncing replicas sequentially.",
    "supersedes": null
  },
  "impact": {
    "affectedSystems": [
      {
        "identifier": "pg-primary-us-east-1",
        "technology": "postgresql",
        "role": "primary",
        "impactType": "reduced_read_capacity"
      },
      {
        "identifier": "pg-replica-us-east-1b",
        "technology": "postgresql",
        "role": "replica",
        "impactType": "temporary_unavailability"
      }
    ],
    "affectedServices": ["user-api", "reporting-service"],
    "estimatedUserImpact": "Read queries may experience elevated latency for approximately 10 minutes. No write impact expected.",
    "dataLossRisk": "none"
  },
  "steps": [ ],
  "rollbackStrategy": {
    "type": "stepwise",
    "description": "Each step includes an inverse operation. On failure, execute rollback steps in reverse order from the point of failure."
  }
}
```

### 6.3 Plan Requirements

- `metadata.planId` MUST be unique and SHOULD include a timestamp and agent identifier.
- `metadata.estimatedDuration` MUST be an ISO 8601 duration.
- `metadata.scenario` MUST reference a scenario from the agent's manifest `failureScenarios`.
- `metadata.supersedes` MUST reference the original plan's `planId` when this plan is a revision produced through replanning. MUST be `null` for initial plans.
- `impact.affectedSystems` MUST declare all systems the plan will interact with. Undeclared interactions are a trust violation.
- `impact` represents the agent's best understanding. The framework treats impact declarations as advisory and validates them where possible (Section 14).
- `steps` MUST be an ordered array. The framework executes steps sequentially. **[Phase 2]**: Parallel groups within the sequence.
- `rollbackStrategy` MUST be present. Accepted types: `stepwise`, `checkpoint`, `full`, or `none` (requires `critical` risk level and explicit justification).
- Every plan containing `elevated`-risk or above steps MUST include at least one `human_notification` step. The framework MUST reject plans at these risk levels that contain no human interaction steps.

---

## 7. Step Types

Each step in a Recovery Plan has a `type` that determines how the framework processes it.

### 7.1 `system_action`

A mutating action against a target system.

```json
{
  "stepId": "step-003",
  "type": "system_action",
  "name": "Disconnect lagging replica from replication",
  "description": "Terminates the WAL sender process for pg-replica-us-east-1b to prevent the primary from being blocked by a slow consumer.",
  "executionContext": "postgresql_write",
  "target": "pg-primary-us-east-1",
  "riskLevel": "elevated",
  "requiredCapabilities": ["db.replica.disconnect"],
  "command": {
    "type": "sql",
    "subtype": "dml",
    "statement": "SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming';"
  },
  "preConditions": [
    {
      "description": "Replica is currently connected and streaming",
      "check": {
        "type": "sql",
        "statement": "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming';",
        "expect": { "operator": "gte", "value": 1 }
      }
    }
  ],
  "statePreservation": {
    "before": [
      {
        "name": "replication_state_snapshot",
        "captureType": "sql_query",
        "statement": "SELECT * FROM pg_stat_replication;",
        "captureCost": "negligible",
        "capturePolicy": "required",
        "retention": "P30D"
      }
    ],
    "after": [
      {
        "name": "replication_state_post_disconnect",
        "captureType": "sql_query",
        "statement": "SELECT * FROM pg_stat_replication;",
        "captureCost": "negligible",
        "capturePolicy": "best_effort",
        "retention": "P30D"
      }
    ]
  },
  "successCriteria": {
    "description": "WAL sender process for the target replica is no longer present",
    "check": {
      "type": "sql",
      "statement": "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52';",
      "expect": { "operator": "eq", "value": 0 }
    }
  },
  "rollback": {
    "description": "Replica will automatically attempt to reconnect. No explicit rollback needed.",
    "type": "automatic",
    "estimatedDuration": "PT30S"
  },
  "blastRadius": {
    "directComponents": ["pg-replica-us-east-1b"],
    "indirectComponents": ["user-api-read-pool"],
    "maxImpact": "single_replica_disconnected",
    "cascadeRisk": "low"
  },
  "timeout": "PT60S",
  "retryPolicy": {
    "maxRetries": 0,
    "retryable": false
  }
}
```

#### 7.1.1 `system_action` Requirements

- `executionContext` MUST reference a context declared in the agent's manifest. The framework MUST refuse to execute actions using undeclared contexts.
- `target` MUST identify a specific system component.
- `riskLevel` MUST be one of: `routine`, `elevated`, `high`, or `critical`. See Section 8.
- `command` MUST contain a structured, auditable command definition. The `type` field indicates the command class. See Section 15 for permitted types and constraints. Agents MUST NOT embed opaque shell scripts. The `shell` command type requires organizational opt-in and elevated risk classification (Section 15.4).
- `preConditions` SHOULD be provided. The framework evaluates all preconditions before execution. If any fail, the step is not executed.
- `statePreservation` is REQUIRED for steps with `riskLevel` of `elevated` or above. See Section 9 for cost and policy.
- `successCriteria` MUST be provided.
- `blastRadius` MUST be declared. See Section 14 for the three-tier model.
- `timeout` MUST be provided.
- `requiredCapabilities` MUST list the standard capability identifiers required for this step. The framework uses these for provider resolution and validation. Each capability MUST be registered in the capability registry.

> **Simulator support:** Steps MAY include an optional `stateTransition` field (string) used by simulator backends to advance simulated system state during dry-run execution. This field has no effect in live execution mode and is not validated by the framework. It exists to support realistic dry-run demonstrations without requiring live infrastructure.

### 7.2 `diagnosis_action`

A read-only action that gathers information. MUST NOT mutate state.

```json
{
  "stepId": "step-001",
  "type": "diagnosis_action",
  "name": "Assess current replication lag across all replicas",
  "executionContext": "postgresql_read",
  "target": "pg-primary-us-east-1",
  "command": {
    "type": "sql",
    "subtype": "query",
    "statement": "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, (extract(epoch FROM now() - pg_last_xact_replay_timestamp()))::int AS lag_seconds FROM pg_stat_replication;"
  },
  "outputCapture": {
    "name": "current_replication_status",
    "format": "table",
    "availableTo": "subsequent_steps"
  },
  "timeout": "PT30S"
}
```

- The framework MUST enforce that `diagnosis_action` steps use only read-scoped execution contexts.
- Output captured in `outputCapture` is available to subsequent steps and to human interaction steps for context display.

### 7.3 `human_notification`

A one-way notification. The framework delivers the notification and proceeds without waiting.

```json
{
  "stepId": "step-002",
  "type": "human_notification",
  "name": "Notify on-call DBA of replication recovery initiation",
  "recipients": [
    {
      "role": "on_call_dba",
      "urgency": "high"
    }
  ],
  "message": {
    "summary": "Automated recovery initiated for PostgreSQL replication lag cascade",
    "detail": "Agent 'postgresql-replication-recovery' has diagnosed a replication lag cascade on pg-primary-us-east-1. A recovery plan has been approved and execution is beginning.",
    "contextReferences": ["current_replication_status"],
    "actionRequired": false
  },
  "channel": "auto"
}
```

- `recipients` MUST reference roles, not individuals. The framework resolves roles via organizational configuration.
- `urgency` MUST be one of: `low`, `medium`, `high`, or `critical`. The framework uses urgency to select delivery channel.
- `channel` MAY be `auto` (RECOMMENDED) or a specific channel identifier.
- `message.contextReferences` MAY reference outputs from previous steps. The framework includes these in the notification.
- If Layer 3 is unavailable, the framework attempts the fallback channel (Section 10.5). If all channels are unavailable, the notification is logged to the local audit log and queued for delivery when channels become available.

### 7.4 `human_approval`

A blocking step that pauses execution until a human provides explicit approval.

```json
{
  "stepId": "step-004",
  "type": "human_approval",
  "name": "Approve replica resynchronization",
  "description": "Resynchronization will temporarily reduce read capacity.",
  "approvers": [
    {
      "role": "database_owner",
      "required": true
    }
  ],
  "requiredApprovals": 1,
  "presentation": {
    "summary": "Ready to begin replica resynchronization",
    "detail": "The primary has been stabilized and replication slots are healthy. The next phase will resynchronize pg-replica-us-east-1b.",
    "contextReferences": ["replication_state_post_disconnect"],
    "proposedActions": [
      "Initiate pg_basebackup from primary to pg-replica-us-east-1b",
      "Re-establish streaming replication",
      "Verify replication lag returns to < 10 seconds"
    ],
    "riskSummary": "Read capacity reduced by ~33% for estimated 8-12 minutes. No data loss risk.",
    "alternatives": [
      {
        "action": "skip",
        "description": "Skip this step. Replication will remain broken until manually repaired."
      },
      {
        "action": "abort",
        "description": "Abort the recovery plan. All changes will be rolled back."
      }
    ]
  },
  "timeout": "PT15M",
  "timeoutAction": "escalate",
  "escalateTo": {
    "role": "engineering_lead",
    "message": "Approval timeout reached for replica resynchronization. Escalating for decision."
  }
}
```

#### 7.4.1 Requirements

- `approvers` MUST list at least one approver with `required: true`.
- `requiredApprovals` specifies how many approvals are needed. The framework MUST NOT proceed until met.
- `presentation` MUST include `summary` and `proposedActions`. Agents SHOULD provide `riskSummary` and `alternatives`.
- `alternatives` MUST include at least `skip` and `abort` options.
- `timeout` MUST be provided. `timeoutAction` MUST be one of: `escalate`, `abort`, `skip`, or `pause`.
- For `critical` risk steps, `timeoutAction` MUST be `escalate` or `abort`. `skip` is NOT PERMITTED.
- If this step matches a pre-authorized action catalog entry (Section 17), the framework satisfies the approval automatically and logs the catalog match.
- When Layer 3 is unavailable, the framework MUST use the fallback approval mechanism described in Section 10.5. The framework MUST NOT proceed without approval.

### 7.5 `checkpoint`

Creates an explicit recovery checkpoint.

```json
{
  "stepId": "step-005",
  "type": "checkpoint",
  "name": "Pre-resync checkpoint",
  "description": "Capture full state before replica resynchronization.",
  "stateCaptures": [
    {
      "name": "full_replication_config",
      "captureType": "file_snapshot",
      "targets": [
        "/var/lib/postgresql/data/postgresql.conf",
        "/var/lib/postgresql/data/pg_hba.conf"
      ],
      "captureCost": "negligible",
      "capturePolicy": "required"
    },
    {
      "name": "replication_slot_state",
      "captureType": "sql_query",
      "statement": "SELECT * FROM pg_replication_slots;",
      "captureCost": "negligible",
      "capturePolicy": "required"
    }
  ]
}
```

- Checkpoint captures are stored by the framework and linked to the forensic record.
- The `rollbackStrategy` MAY reference checkpoint step IDs as rollback targets.

### 7.6 `conditional`

Evaluates a runtime check and executes one of two pre-declared steps. Both the `thenStep` and `elseStep` are validated at plan validation time, giving the approver full visibility into both possible paths.

```json
{
  "stepId": "step-009",
  "type": "conditional",
  "name": "Restore traffic or notify for manual intervention",
  "condition": {
    "description": "Replica is streaming and lag is under threshold",
    "check": {
      "type": "sql",
      "statement": "SELECT count(*) FROM pg_stat_replication WHERE client_addr = '10.0.1.52' AND state = 'streaming' AND (extract(epoch FROM replay_lag))::int < 10;",
      "expect": { "operator": "gte", "value": 1 }
    }
  },
  "thenStep": {
    "stepId": "step-009a",
    "type": "system_action",
    "name": "Restore read traffic to recovered replica",
    "executionContext": "linux_process",
    "target": "haproxy-us-east-1",
    "riskLevel": "routine",
    "command": {
      "type": "structured_command",
      "operation": "config_reload",
      "parameters": { "service": "haproxy" }
    },
    "statePreservation": { "before": [], "after": [] },
    "successCriteria": {
      "description": "HAProxy config reloaded successfully",
      "check": {
        "type": "structured_command",
        "operation": "service_status",
        "parameters": { "service": "haproxy" },
        "expect": { "operator": "eq", "value": "running" }
      }
    },
    "blastRadius": {
      "directComponents": ["haproxy-us-east-1"],
      "indirectComponents": [],
      "maxImpact": "load_balancer_config_reload",
      "cascadeRisk": "none"
    },
    "rollback": { "type": "automatic", "description": "HAProxy continues with previous config." },
    "timeout": "PT30S",
    "retryPolicy": { "maxRetries": 1, "retryable": true }
  },
  "elseStep": {
    "stepId": "step-009b",
    "type": "human_notification",
    "name": "Notify DBA: replica not healthy after resync",
    "recipients": [
      { "role": "on_call_dba", "urgency": "high" }
    ],
    "message": {
      "summary": "Replica did not reach healthy state after resynchronization",
      "detail": "pg-replica-us-east-1b completed pg_basebackup but replication lag has not dropped below threshold. Manual investigation is recommended. Read traffic has NOT been restored to this replica.",
      "contextReferences": ["post_resync_replication_state"],
      "actionRequired": true
    },
    "channel": "auto"
  }
}
```

#### 7.6.1 Requirements

- `condition.check` follows the same schema as preconditions and success criteria.
- `thenStep` MUST contain a complete, valid step definition. All requirements for that step type apply.
- `elseStep` MUST contain either a complete, valid step definition OR the string `"skip"`. When `"skip"`, the framework logs the condition result and proceeds to the next step in the plan.
- Both `thenStep` and `elseStep` (when not `"skip"`) are validated at plan validation time. The approver sees both possible paths.
- The `conditional` step type supports a single level of binary decision. `thenStep` and `elseStep` MUST NOT themselves be `conditional` steps. Nesting conditionals is not permitted. If deeper decision logic is needed, use the replanning mechanism (Section 16).
- The higher risk level of the two branches determines the effective risk of the `conditional` step for approval purposes.

### 7.7 `replanning_checkpoint`

Pauses execution and invokes the agent's `replan()` interface with updated context. See Section 16.

```json
{
  "stepId": "step-007",
  "type": "replanning_checkpoint",
  "name": "Assess recovery progress before proceeding",
  "description": "Verify recovery is on track. Agent may revise the remaining plan based on current system state.",
  "fastReplan": true,
  "replanTimeout": "PT30S",
  "diagnosticCaptures": [
    {
      "name": "post_resync_replication_state",
      "captureType": "sql_query",
      "statement": "SELECT * FROM pg_stat_replication;",
      "captureCost": "negligible"
    }
  ]
}
```

- `diagnosticCaptures` are executed before the agent's `replan()` is called.
- `fastReplan` enables the expedited replan validation path (Section 16.4).
- `replanTimeout` bounds how long the agent has to produce a revised plan. RECOMMENDED default: 30 seconds. If the agent exceeds this timeout, the framework proceeds with the existing plan.

### 7.8 Future Step Types [Phase 2]

The following step types are reserved for future specification. Phase 1 implementations MUST accept and reject these types gracefully (clear error message) rather than failing silently.

- `parallel_group` — Concurrent execution of multiple steps.
- `stakeholder_communication` — Audience-aware communications with template rendering.
- `sub_plan` — Invocation of another agent's plan for a specific target.

---

## 8. Risk Classification

Every `system_action` step MUST declare a `riskLevel`. The framework uses risk levels to enforce approval gates, notification policies, and audit requirements.

### 8.1 Risk Levels

| Level | Definition | Framework Behavior |
|---|---|---|
| `routine` | Safe, well-understood, easily reversible. No data loss risk. Impact limited to the specific component. | Logged. State preservation per `capturePolicy`. No approval at `copilot`+ trust. |
| `elevated` | Broader impact, MAY cause temporary disruption, but fully reversible. No data loss risk. | State preservation REQUIRED. On-call notification. Approval required unless trust is `autopilot`+ AND `requireApprovalForAllElevated` policy is `false`. |
| `high` | Risk of service disruption or partial data loss. Affects multiple components. Rollback may be partial. | State preservation REQUIRED. Explicit human approval REQUIRED regardless of trust level. |
| `critical` | Risk of significant data loss, extended outage, or irreversible state change. | State preservation REQUIRED. Multi-party approval REQUIRED. Timeout escalation MUST be `escalate` or `abort`. |

### 8.2 Risk Level Assignment

Agents MUST assign risk levels conservatively. When uncertain, agents SHOULD assign the higher level. The framework MAY override risk levels upward (never downward) based on organizational policy.

### 8.3 Organizational Policy Overrides

The framework MUST support organizational policies that modify risk-level behavior. These policies are configured in the framework; agents MUST NOT make assumptions about organizational policy.

Required configurable policies:

- **`requireApprovalForAllElevated`** (boolean, default: `false`): When `true`, all `elevated`-risk steps require explicit human approval regardless of trust level. Organizations operating in highly regulated environments or those with lower risk tolerance SHOULD enable this policy. When `false`, `elevated`-risk steps may execute autonomously at `autopilot`+ trust level, consistent with Section 13.
- **Environment-level risk floor**: Elevate all actions in a specified environment (e.g., production) to at least a specified risk level (e.g., `elevated`).
- **Multi-party approval requirement**: Require multi-party approval for specified environments or risk levels beyond the plan's own declaration.
- **P1 lockdown**: During declared P1 incidents, restrict autonomous execution to `routine` only regardless of trust level.

### 8.4 Rationale for Configurable Elevated Approval

Different organizations have different risk tolerances. A startup recovering a staging database has different safety requirements than a hospital recovering a patient records system. The `requireApprovalForAllElevated` policy allows organizations to choose their position on the safety-speed spectrum:

- **Maximum safety**: Enable `requireApprovalForAllElevated` and `P1 lockdown`. Every non-routine action requires a human. Recovery is slower but every action is human-authorized.
- **Balanced (default)**: `elevated` actions can execute autonomously for high-trust agents in pre-authorized scenarios. `high` and `critical` always require approval. This balances fast response for validated scenarios with human control for dangerous ones.
- **Maximum speed**: Rely heavily on pre-authorized catalogs (Section 17) to pre-satisfy approval for well-understood recovery paths. Humans are still notified and can intervene, but pre-validated recoveries execute without blocking on approval.

The framework defaults to the balanced position. Organizations explicitly opt into the other positions through policy configuration.

---

## 9. State Preservation

State preservation is the framework's responsibility to execute and the agent's responsibility to declare. The foundational guarantee: **the framework captures relevant system state before mutating actions, within the constraints of system health and capture cost.**

### 9.1 Preservation Directives

Agents declare state preservation in two locations:

1. Within `system_action` steps via `statePreservation` (before/after captures specific to that step).
2. Within `checkpoint` steps via `stateCaptures` (broader captures at logical boundaries).

### 9.2 Capture Types

| Type | Description | Example |
|---|---|---|
| `sql_query` | Executes a read-only SQL query and stores the result set. | `SELECT * FROM pg_stat_replication;` |
| `file_snapshot` | Captures a copy of one or more files. | Configuration files, WAL segments |
| `command_output` | Executes a read-only command and captures output. | `kubectl get pods -o json` |
| `api_snapshot` | Calls a read-only API endpoint and stores the response. | Health check endpoints |
| `filesystem_snapshot` | Creates a point-in-time snapshot of a volume. | LVM snapshots, EBS snapshots |
| `custom` | Agent-defined capture with a specified handler. | Proprietary backup formats |

### 9.3 Capture Cost and Policy

Every capture directive MUST include `captureCost` and `capturePolicy`.

**`captureCost`**:

| Cost | Definition | Examples |
|---|---|---|
| `negligible` | Milliseconds, no measurable system impact. | SQL metadata queries, small config files. |
| `moderate` | Seconds, minor IO/CPU impact. | Process dumps, medium file copies. |
| `expensive` | Minutes, significant IO/CPU/storage impact. | Filesystem snapshots, full database dumps. |

**`capturePolicy`**:

| Policy | Behavior |
|---|---|
| `required` | If capture fails or would worsen system health, the associated action MUST NOT proceed. |
| `best_effort` | Attempt capture. If it fails or is skipped, proceed. Log the gap. |
| `deferred` | Queue capture for execution after the action or after system health improves. |

### 9.4 Cost-Aware Execution

The framework MUST implement cost-awareness:

- `negligible` captures: always attempted.
- `moderate` captures: attempted unless the target system is under severe resource pressure (implementation-defined threshold).
- `expensive` captures: attempted only if the system can sustain additional load. During active degradation, `expensive` + `best_effort` captures SHOULD be deferred or skipped.

The framework MUST log the decision for every capture — attempted, succeeded, skipped (with reason), or deferred.

### 9.5 Default Policies

- `elevated`+ risk steps MUST have at least one `before` capture with `required` policy.
- `routine` risk captures are OPTIONAL. If present, `best_effort` is RECOMMENDED.
- All `after` captures SHOULD use `best_effort` or `deferred`, since an `after` capture failure should not retroactively fail a completed action.

### 9.6 Capture Storage and Immutability

- Captures MUST be stored immutably. Once created, a capture MUST NOT be modified or deleted before its retention period.
- Each capture MUST include a `retention` duration (ISO 8601).
- Captures MUST be linked to the forensic record.

---

## 10. Human Interaction Model

Human-in-the-loop is a first-class primitive. The framework manages all human interactions — agents declare what is needed, and the framework routes, tracks, and enforces them.

### 10.1 Interaction Primitives

| Primitive | Direction | Blocking | Description |
|---|---|---|---|
| `human_notification` | Framework → Human | No | Inform a human of an event or action. |
| `human_approval` | Framework → Human → Framework | Yes | Request explicit approval before proceeding. |
| `human_escalation` | Framework → Human | No | Escalate due to timeout, failure, or policy trigger. |

**[Phase 2]**: `human_input` — Request a decision or additional information beyond approve/reject.

### 10.2 Role-Based Addressing

All human interactions address **roles**, not individuals. The framework resolves roles to individuals based on organizational configuration (on-call schedules, team assignments).

Standard roles:

| Role | Typical Responsibility |
|---|---|
| `on_call_engineer` | First responder for the affected service. |
| `on_call_dba` | First responder for database issues. |
| `incident_commander` | Overall incident coordinator. |
| `database_owner` | Technical owner of the affected database. |
| `service_owner` | Technical owner of the affected service. |
| `engineering_lead` | Engineering management escalation point. |
| `engineering_vp` | Executive engineering escalation. |
| `customer_success_lead` | Customer communication owner. |
| `security_lead` | Security team escalation. |

Frameworks MUST support custom role definitions. Agents SHOULD use standard roles where applicable.

### 10.3 Escalation

When a `human_approval` step times out and `timeoutAction` is `escalate`:

1. The framework MUST send the escalation to the specified `escalateTo` role.
2. The escalation MUST include original request context and elapsed time.
3. If the escalation also times out, the next escalation tier's timeout action applies.
4. Escalation chains MUST terminate. Maximum depth: RECOMMENDED 3 levels. At maximum depth, the framework MUST `abort` or `pause` per organizational policy.

### 10.4 Approval Speed, Not Approval Bypass

The framework is designed to make approval fast rather than skippable:

- **Pre-authorized action catalogs** (Section 17) pre-satisfy approval for known scenarios.
- **One-click approval** with full context — the presentation includes everything the approver needs.
- **Short timeouts with automatic escalation** — if the designated approver doesn't respond quickly, escalate rather than wait.

The framework MUST NOT implement a general-purpose "bypass all approvals" mode.

### 10.5 Fallback Approval Mechanism

When Layer 3's primary notification and approval channels are unavailable, the framework MUST NOT silently skip approval steps. Instead, the framework MUST attempt an out-of-band fallback mechanism.

The framework MUST support configuration of at least one fallback approval channel that is independent of the primary channel infrastructure. The specific technology is implementation-defined, but the fallback MUST NOT depend on the same services as the primary channels.

Examples of suitable fallback mechanisms:

- Direct SMS via a cellular gateway with a numeric confirmation code.
- Automated phone call with a spoken confirmation code.
- A dedicated lightweight webhook endpoint deployed on a separate network path.
- A pre-shared out-of-band messaging channel (e.g., a dedicated Signal group).

Fallback configuration MUST specify:

```json
{
  "fallbackApproval": {
    "channels": [
      {
        "type": "sms",
        "priority": 1,
        "config": { }
      },
      {
        "type": "phone_call",
        "priority": 2,
        "config": { }
      }
    ],
    "retryIntervalSeconds": 60,
    "maxRetries": 10
  }
}
```

**Behavior when all channels (primary and fallback) are unavailable:**

- For `routine` and `elevated` risk steps: the framework MUST `pause` and retry both primary and fallback channels at the configured interval. The framework MUST NOT proceed without approval.
- For `high` and `critical` risk steps: the framework MUST `pause`, retry all channels, and log the approval blockage as a critical event in the forensic record. When any channel becomes available, the escalation chain resumes from the current tier.

The framework MUST log every channel attempt (primary and fallback), including failures, in the forensic record. This ensures post-incident review can determine exactly what happened with the approval process.

---

## 11. Stakeholder Communication

### 11.1 Phase 1: Structured Notifications

In Phase 1, stakeholder communication uses the `human_notification` step type. Agents include relevant context in the `message` field, and the framework delivers it to specified roles through configured channels.

Phase 1 notifications are plain structured messages — summary, detail, context references, urgency. They are not rendered through audience-specific templates.

### 11.2 Phase 2: Audience-Aware Communication [Phase 2]

Phase 2 introduces a `stakeholder_communication` step type with template-based rendering, audience-specific content adaptation, periodic update schedules, and communication approval workflows. See Section 23.1.

Phase 1 implementations MUST NOT preclude the Phase 2 model. The `human_notification` message schema MUST support structured content that a future template renderer could consume.

---

## 12. Context and Observability

### 12.1 Agent Context Bundle

When the framework invokes an agent, it provides an `AgentContext`:

```json
{
  "trigger": {
    "type": "alert",
    "source": "prometheus",
    "payload": { },
    "receivedAt": "2026-03-12T14:28:15Z"
  },
  "topology": {
    "source": "framework_model",
    "staleness": "PT5M",
    "authoritative": false,
    "components": [
      {
        "identifier": "pg-primary-us-east-1",
        "technology": "postgresql",
        "version": "16.2",
        "role": "primary",
        "reachable": true,
        "lastHealthCheck": "2026-03-12T14:27:50Z",
        "healthStatus": "degraded"
      }
    ],
    "relationships": [
      {
        "from": "pg-primary-us-east-1",
        "to": "pg-replica-us-east-1b",
        "type": "replication",
        "status": "lagging"
      }
    ]
  },
  "frameworkLayers": {
    "execution_kernel": "available",
    "safety": "available",
    "coordination": "available",
    "enrichment": "unavailable"
  },
  "trustLevel": "copilot",
  "trustScenarioOverrides": {
    "replication_lag_cascade": "autopilot"
  },
  "organizationalPolicies": {
    "maxAutonomousRiskLevel": "routine",
    "requireApprovalAbove": "routine",
    "requireApprovalForAllElevated": false,
    "shellCommandsEnabled": false,
    "approvalTimeoutMinutes": 15,
    "escalationDepth": 3
  },
  "preAuthorizedCatalogs": ["pg-replication-standard-recovery"],
  "availableExecutionContexts": ["postgresql_read", "postgresql_write", "linux_process"],
  "priorIncidents": [ ]
}
```

### 12.2 Context Requirements

- `topology` MUST include `staleness` and MUST set `authoritative` to `false`. Topology data is advisory. Agents SHOULD perform live system introspection during `diagnose()` and MUST NOT assume topology is complete or current.
- `topology.components[].reachable` MUST reflect the framework's current ability to reach each component.
- `frameworkLayers` MUST indicate current layer availability. Agents SHOULD adapt plans accordingly.
- `trustLevel` is the baseline. `trustScenarioOverrides` provides per-scenario overrides. The effective trust is: override for the specific scenario if present, otherwise baseline.
- `organizationalPolicies` MUST include all policy flags that affect plan validation and approval. Agents MAY use this to construct plans that conform to organizational requirements.
- `availableExecutionContexts` MAY be a subset of the manifest if systems are unreachable.

### 12.3 Topology as Advisory

The framework's topology model MAY be incomplete or stale. This is explicitly acknowledged:

- Agents MUST treat topology as a starting point, not ground truth.
- When live diagnosis discovers components not in topology, the agent MUST include them in the plan's `impact`.
- Conflicts between topology and live observation MUST be logged in the forensic record.
- **[Phase 2]**: Agent discoveries feed back into the framework's model.

---

## 13. Trust and Permission Model

### 13.1 Trust Levels

| Level | Description | Permitted Behavior |
|---|---|---|
| `observe` | Diagnose and produce plans, but all actions require approval. | All steps require `human_approval`. |
| `copilot` | Execute `routine` actions autonomously. Higher risk requires approval. | `routine`: autonomous. `elevated`+: approval required. |
| `autopilot` | Execute `routine` and `elevated` autonomously (subject to `requireApprovalForAllElevated` policy). | `routine` and `elevated`: autonomous (unless policy overrides). `high`+: approval required. |
| `full_autonomy` | Execute all risk levels autonomously. Reserved for extensively validated scenarios. | All steps: autonomous. Framework still enforces state preservation, blast radius, and audit. |

### 13.2 Trust Scope

Trust is scoped to: **agent + scenario + environment**.

An agent may have different trust levels for different scenarios:

```
postgresql-replication-recovery:
  replication_lag_cascade:
    production: copilot
    staging: autopilot
  replica_divergence:
    production: observe
    staging: copilot
  wal_corruption:
    production: observe
    staging: observe
```

In Phase 1, trust defaults to the agent's overall trust level (set by an administrator at registration), with per-scenario overrides configured in the framework. The `AgentContext` communicates the effective trust level.

### 13.3 Trust Progression [Phase 2]

In Phase 2, the framework tracks per-scenario metrics:

- Plans executed, success rate, rollback frequency
- Blast radius accuracy (declared vs. observed)
- Human modification rate

Trust changes MUST always be approved by a human administrator. The framework MAY recommend but MUST NOT auto-promote.

### 13.4 Trust Violations

The framework MUST detect and respond to:

- **Undeclared interaction**: Action affects a target not in the plan's `impact` or step's execution context. Framework MUST suspend the agent.
- **Manifest mismatch**: Agent requests undeclared context or target. Framework MUST reject and log.
- **Risk level exceeded**: Plan steps exceed manifest's `maxRiskLevel`. Framework MUST reject plan.

---

## 14. Blast Radius

Blast radius operates on three tiers with distinct enforcement models, assigned to specific framework layers. This reflects the reality that some impacts can be mechanically prevented while others can only be observed.

### 14.1 Declaration

Every `system_action` step MUST include a `blastRadius`:

```json
{
  "blastRadius": {
    "directComponents": ["pg-replica-us-east-1b"],
    "indirectComponents": ["user-api-read-pool"],
    "maxImpact": "single_replica_disconnected",
    "cascadeRisk": "low"
  }
}
```

- `directComponents`: Components the action directly interacts with.
- `indirectComponents`: Components that may be affected as a consequence.
- `maxImpact`: Human-readable worst-case description.
- `cascadeRisk`: `none`, `low`, `medium`, or `high`.

### 14.2 Three-Tier Enforcement

**Tier 1 — Hard Enforcement** (Layer 2 — Safety):

The framework verifies that the action's command targets only components the agent has execution context for. If the `target` field references a system not in the manifest's execution contexts, the framework MUST reject the step. This is mechanical validation with no false positives.

**Tier 2 — Declaration Validation** (Layer 2 — Safety):

The framework compares `directComponents` and `indirectComponents` against available topology data and flags obvious omissions. For example, if an action targets a database primary but the blast radius lists no replicas or dependent services, the framework SHOULD include this warning in the approval presentation so the human reviewer is aware. Tier 2 validation is limited by topology completeness and staleness. When topology data is unavailable, the framework MUST log that Tier 2 validation was skipped and proceed with Tier 1 only.

**Tier 3 — Observed Impact Monitoring** (Layer 4 — Enrichment) [Phase 2]:

After execution, the framework monitors for unexpected state changes outside the declared blast radius. Anomalies are logged and flagged for human review. They are NOT automatically treated as trust violations because cascading effects are difficult to attribute definitively.

### 14.3 Declaration as a Thinking Tool

The blast radius declaration requirement exists as much for the agent builder's benefit as for enforcement. Forcing explicit declaration of direct and indirect impact makes the agent builder reason about consequences. This produces better agents even when the framework cannot fully verify the declarations.

---

## 15. Execution Contexts

Execution contexts mediate all agent interaction with target systems. This section defines the contract without mandating specific isolation mechanisms.

### 15.1 Execution Context Contract

Every execution context declared in the manifest MUST specify:

```json
{
  "name": "postgresql_write",
  "type": "sql",
  "privilege": "write",
  "target": "postgresql",
  "allowedOperations": ["select", "insert", "update", "delete", "function_call"],
  "capabilities": ["db.query.read", "db.query.write", "db.replica.disconnect"]
}
```

- `name`: Unique within the manifest.
- `type`: Command class. Determines valid command schemas. See Section 15.2.
- `privilege`: Scope. Meaning is type-dependent.
- `target`: Technology this context connects to.
- `allowedOperations`: Permitted operation categories. Framework MUST reject commands outside these.
- `capabilities`: OPTIONAL. Standard capability identifiers this context provides. Used by the provider registry for resolving which providers can satisfy plan steps. When omitted, provider resolution falls back to manifest-level declarations.

### 15.2 Command Types

| Command Type | Description | Audit Properties |
|---|---|---|
| `sql` | SQL statements. Subtypes: `query`, `dml`, `ddl`, `function_call`. | Statement text fully visible and parseable. |
| `structured_command` | Predefined operation with typed parameters from a registry. | Operation name and parameters explicit. No arbitrary code. |
| `kubernetes_api` | Kubernetes API call: resource, verb, payload. | API verb, resource, namespace explicit. |
| `api_call` | HTTP call: method, URL pattern, headers, body. | Full request structure visible. |
| `configuration_change` | Targeted config modification. | Target file, key, old value, new value explicit. |

### 15.3 Command Validation

The framework MUST validate commands before execution:

- `sql` with `query` subtype MUST NOT contain DDL or DML. SHOULD use a SQL parser.
- `structured_command` operations MUST match the `allowedOperations` list.
- All command types MUST have fully visible, auditable parameters.

### 15.4 Shell Commands

The `shell` command type is NOT available by default.

Organizations MAY enable shell through explicit framework configuration. When enabled:

- Shell commands MUST be classified `high` risk or above.
- Execution context MUST specify an `allowedCommands` allowlist. Framework MUST reject non-matching commands.
- Execution MUST be logged with full command text, environment variables, stdout, stderr, exit code.
- Agents SHOULD prefer structured command types.

### 15.5 Credential Management

Agents MUST NOT receive, store, or transmit credentials. The framework manages all authentication and injects credentials at invocation time. Credentials MUST NOT appear in plans, command parameters, or audit logs.

---

## 16. Replanning

Replanning is the mechanism by which recovery adapts to changing conditions.

### 16.1 Design Rationale

Real incident recovery often requires adapting the approach. This specification uses replanning instead of complex control flow: the agent periodically receives updated state and either confirms the plan or produces a new one.

Benefits:

- **Individual plans remain simple.** Each plan is a linear sequence with bounded decision points.
- **Clean audit trail.** Each revision is a separate, immutable record.
- **Novel situations handled naturally.** The agent reasons about new conditions rather than navigating pre-planned branches.
- **Humans can review revisions.** Higher-risk revised plans go through approval gates.

### 16.2 Replanning Checkpoints

When execution reaches a `replanning_checkpoint`:

1. Framework executes any `diagnosticCaptures`.
2. Framework assembles `ExecutionState`: completed steps and results, diagnostic captures, state preservation captures, human feedback received.
3. Framework invokes agent's `replan()` with original diagnosis and current execution state.
4. Agent returns: `continue`, `revised_plan`, or `abort`.
5. Revised plans are validated and gated — unless fast replan conditions are met (Section 16.4).

### 16.3 Replanning Limits

The framework MUST enforce a maximum replan count per incident (RECOMMENDED: 5). Excessive replanning indicates the agent is struggling; human intervention is warranted. When the limit is reached, the framework MUST pause and notify the designated human role.

### 16.4 Fast Replan

To minimize latency for routine plan adjustments, the `replanning_checkpoint` supports a `fastReplan` flag.

When `fastReplan` is `true` and the revised plan meets ALL of the following conditions, the framework SHOULD skip re-validation and re-approval:

1. The revised plan does not introduce any new execution contexts beyond those already approved.
2. The revised plan does not introduce any steps with a higher risk level than the maximum risk level in the original approved plan.
3. The revised plan does not target any systems not already declared in the original plan's `impact`.
4. The revised plan does not exceed the original plan's `estimatedDuration` by more than 50%.

If any condition is not met, the revised plan goes through the full validation and approval pipeline as normal.

The framework MUST log whether fast replan was used or whether full re-validation was triggered, including which condition(s) caused the fallback.

**Rationale:** Fast replan addresses the latency concern of the replan cycle. When an agent adjusts tactics (e.g., using a different resync method) without escalating risk or scope, the adjustment should not require re-approval. When the agent escalates risk or scope, full approval is appropriate regardless of speed pressure.

### 16.5 Revised Plan Requirements

A revised plan MUST:
- Set `metadata.supersedes` to the original plan's `planId`.
- Include only remaining recovery steps (not already-executed steps).
- Not contradict state changes from executed steps.

The framework validates consistency with current execution state.

### 16.6 Replan Timeout

The `replanTimeout` field on `replanning_checkpoint` bounds the agent's response time. If the agent exceeds the timeout:

- If the remaining steps of the current plan are still structurally valid (targets are reachable, contexts available), the framework proceeds with the existing plan and logs the timeout.
- If the remaining plan is no longer structurally valid, the framework pauses and notifies the designated human role.

RECOMMENDED default: 30 seconds.

---

## 17. Pre-Authorized Action Catalogs

Pre-authorized action catalogs solve the approval speed problem for known scenarios without compromising safety for novel situations.

### 17.1 Concept

An organization pre-authorizes specific recovery approaches for specific scenarios. When an agent's plan matches a catalog entry, the approval requirement is satisfied automatically — the plan executes with notification rather than blocking on approval gates.

This is analogous to how military and aviation emergency procedures work: responses are reviewed and approved during calm conditions, and a crisis activates the pre-approved response.

### 17.2 Catalog Entry Schema

```json
{
  "$schema": "https://recoveryagents.dev/schema/catalog-entry/v0.2.1",
  "apiVersion": "v0.2.1",
  "kind": "CatalogEntry",
  "metadata": {
    "catalogId": "pg-replication-standard-recovery",
    "name": "Standard PostgreSQL Replication Recovery",
    "description": "Pre-authorized recovery for PostgreSQL replication lag cascades using the disconnect-stabilize-resync approach.",
    "approvedBy": "jane.chen@example.com",
    "approvedAt": "2026-02-15T10:00:00Z",
    "reviewSchedule": "P90D",
    "expiresAt": "2026-05-15T10:00:00Z"
  },
  "matchCriteria": {
    "agentName": "postgresql-replication-recovery",
    "agentVersionConstraint": ">=1.2.0 <2.0.0",
    "scenario": "replication_lag_cascade",
    "environment": "production",
    "maxRiskLevel": "elevated",
    "requiredStepPatterns": [
      { "type": "checkpoint", "position": "before_first_mutation" },
      { "type": "human_notification", "position": "any" }
    ],
    "forbiddenOperations": ["ddl", "admin_privilege"],
    "maxStepCount": 15,
    "maxEstimatedDuration": "PT30M"
  },
  "authorization": {
    "satisfiesApprovalFor": ["routine", "elevated"],
    "notificationRequired": true,
    "notificationRecipients": [
      { "role": "on_call_dba", "urgency": "high" }
    ]
  }
}
```

### 17.3 Matching Rules

A plan matches a catalog entry if:

- Agent name and version satisfy the catalog's constraints.
- Diagnosed scenario matches.
- Environment matches.
- No step exceeds the catalog's `maxRiskLevel`.
- Required step patterns are present.
- No forbidden operations are present.
- Step count and estimated duration are within limits.

If multiple entries match, the framework uses the most specific match.

### 17.4 Catalog Match Behavior

When a plan matches:

- `human_approval` steps for risk levels in `satisfiesApprovalFor` are automatically satisfied. The forensic record references the catalog entry.
- The notification in `authorization.notificationRecipients` is sent. Designated humans are informed with the option to intervene.
- Approval steps for risk levels NOT covered still require manual approval.

### 17.5 Catalog Lifecycle

- Entries MUST have `expiresAt`. Expired entries MUST NOT satisfy approval.
- `reviewSchedule` triggers framework alerts when review is due.
- Organizations SHOULD build catalogs through recovery drills.
- The framework MUST log every catalog match and non-match with specific criteria.

---

## 18. Audit and Forensic Record

Every plan execution produces a complete forensic record.

### 18.1 Record Contents

The forensic record MUST include:

- Complete Recovery Plan(s) — original and all revisions.
- `AgentContext` at invocation.
- `DiagnosisResult`.
- Diagnostic plan and results, if executed.
- All state preservation captures (linked by reference), including which were skipped and why.
- Timestamped step execution log:
  - Precondition evaluations.
  - Capture results and cost decisions.
  - Command text (credentials redacted) and output.
  - Success criteria evaluations.
  - Human interactions: requests, responses, timeouts, escalations, fallback attempts, catalog matches.
  - Conditional evaluations and branch selection.
  - Replanning results (fast or full, agent responses).
- Final system state.
- Framework layer availability throughout.
- Trust violations detected.
- Approval channel details (primary, fallback, or console).
- Total and per-step timing.

### 18.2 Record Immutability

Forensic records MUST be append-only during execution and immutable after plan completion.

### 18.3 Completeness Flag

The forensic record MUST include a `completeness` assessment:

- `complete`: All declared captures successfully executed.
- `partial`: Some captures skipped (reasons documented).
- `minimal`: Only audit log produced (Layer 1 operation).

### 18.4 Retention

Records MUST be retained for at least the maximum `retention` of any capture within the record. Organizations MAY configure longer retention.

---

## 19. Error Handling and Rollback

### 19.1 Step Failure

When a step fails:

1. Log failure in forensic record.
2. Execute `after` captures (`best_effort`).
3. Evaluate `retryPolicy`. Retry if applicable.
4. If no retries remain, consult `rollbackStrategy`.
5. Send `human_notification` to designated on-call role.

### 19.2 Plan-Level Rollback

`stepwise`: Rollback directives in reverse order.
`checkpoint`: Roll back to last completed checkpoint.

Rollback failures are `critical`:
- Escalate to highest configured authority.
- Do NOT attempt further automated rollback.
- Capture full detail in forensic record.

### 19.3 Agent Failure

If the agent crashes or produces invalid output:
- Mark as `failed`, notify administrators.
- Attempt alternative agent if registered.
- Do NOT re-invoke failed agent without administrator intervention.

---

## 20. Agent Packaging and Distribution

### 20.1 Package Contents

MUST include: `manifest.json`, agent implementation, `README`.

SHOULD include: `scenarios/` (simulation definitions), `CHANGELOG`.

### 20.2 Versioning

Semantic Versioning: MAJOR (breaking), MINOR (new capabilities), PATCH (fixes).

### 20.3 Compatibility

Manifest declares minimum framework version. Framework rejects incompatible agents.

---

## 21. Conformance

### 21.1 Agent Conformance (Phase 1)

A conforming agent MUST:

1. Provide a valid Agent Manifest per Section 4.
2. Implement `assessHealth()`, `diagnose()`, and `plan()` per Section 5.3.
3. Implement `replan()` if plans contain `replanning_checkpoint` steps.
4. Produce valid Recovery Plans per Sections 6 and 7.
5. Assign risk levels conservatively per Section 8.
6. Declare state preservation with cost and policy for all `elevated`+ steps per Section 9.
7. Include at least one `human_notification` in plans with `elevated`+ steps.
8. Declare blast radius for all `system_action` steps per Section 14.
9. Use only structured command types per Section 15.
10. Respect reachability in agent context per Section 12.
11. Treat topology as advisory per Section 12.3.
12. Not perform mutating actions during `diagnose()`.
13. Not interact with target systems except through framework-mediated execution contexts.

### 21.2 Framework Conformance (Phase 1)

A conforming framework MUST:

1. Implement degradation Layers 1, 2, and 3 per Section 3.
2. Validate agent manifests at registration.
3. Validate Recovery Plans against manifests and organizational policy.
4. Execute state preservation per cost and policy model (Section 9).
5. Enforce human approval gates per trust level and organizational policy (Sections 10, 13, 8.3).
6. Implement fallback approval mechanism per Section 10.5.
7. Enforce execution context scoping per Section 15.
8. Support replanning lifecycle including fast replan per Section 16.
9. Support pre-authorized action catalogs per Section 17.
10. Produce forensic records with completeness flags per Section 18.
11. Handle errors and rollback per Section 19.
12. Route human interactions by role with escalation per Section 10.
13. Enforce Tier 1 and Tier 2 blast radius checks per Section 14.2.
14. Report framework layer availability in `AgentContext`.
15. Fall back gracefully when Layer 3 is unavailable per Sections 3.2 and 10.5.
16. Support organizational policy overrides including `requireApprovalForAllElevated` per Section 8.3.

---

## 22. Security Considerations

### 22.1 Execution Context Isolation

The framework MUST enforce isolation between contexts. Specific mechanism is implementation-defined.

### 22.2 Credential Management

See Section 15.5.

### 22.3 Agent Sandboxing

The framework SHOULD sandbox agents to prevent: direct network access to targets, access to other agents' state, modification of framework configuration, access to other forensic records.

### 22.4 Command Safety

The structured command type system (Section 15) is the primary defense. Agents are constrained to typed, schema-validated commands with explicit allowlists.

### 22.5 Plan Injection

The framework MUST validate all plan content against manifest declarations. Plans referencing undeclared contexts, targets, or exceeding risk levels MUST be rejected. LLM-based agents SHOULD have additional pre-validation.

### 22.6 Supply Chain

Organizations SHOULD review agent packages before registration.

### 22.7 Fallback Channel Security

Out-of-band fallback approval channels (Section 10.5) MUST implement authentication to prevent unauthorized approval injection. Confirmation codes MUST be cryptographically random and single-use. The framework MUST log the channel and authentication method used for every fallback approval.

---

## 23. Future Capabilities

### 23.1 Audience-Aware Stakeholder Communication [Phase 2]

`stakeholder_communication` step type with template rendering, audience adaptation, periodic updates, and communication approval. Phase 1 `human_notification` schema supports structured `contextReferences` for forward compatibility.

### 23.2 Parallel Execution [Phase 2]

`parallel_group` step type. Phase 1 step IDs are unique and steps don't cross-reference, enabling future concurrency.

### 23.3 Plan Composition [Phase 2]

`sub_plan` step type invoking other agents. Phase 1 plans are self-contained but manifest/context schemas support multi-agent discovery.

### 23.4 Topology Feedback Loop [Phase 2]

Agent discoveries update framework topology model.

### 23.5 Advanced Trust Analytics [Phase 2]

Per-scenario metrics, trust recommendations, human-approved progression.

### 23.6 Observed Impact Monitoring (Tier 3 Blast Radius) [Phase 2]

Post-execution anomaly detection across topology, assigned to Layer 4.

### 23.7 Local Execution Mode [Phase 3]

Lightweight runtime on target node without central connectivity. Separate specification due to fundamentally different security and policy model.

### 23.8 Iteration Primitives [Phase 3]

`for_each_component` for multi-target recovery. Requires plan composition (Phase 2).

### 23.9 Agent Lifecycle State Machine Runtime [Phase 2]

Full runtime tracking and inspection of the agent lifecycle state machine defined in Section 5.1. Phase 1 implementations enforce state machine constraints through interface design. Phase 2 adds explicit state tracking, state transition events, and runtime-inspectable agent state for operational dashboards and diagnostics.

---

## Appendix A: Schema References

Schemas at `https://recoveryagents.dev/schema/v0.2.1/`:

- `manifest.schema.json`
- `recovery-plan.schema.json` (includes all step types)
- `agent-context.schema.json`
- `diagnosis-result.schema.json`
- `execution-state.schema.json`
- `catalog-entry.schema.json`
- `forensic-record.schema.json`

Schema versions are locked to spec versions. This document takes precedence over schemas in case of discrepancy.

---

## Appendix B: Example Agent — PostgreSQL Replication Recovery

### B.1 Scenario

A PostgreSQL primary with three streaming replicas experiences a replication lag cascade. One replica falls behind, read traffic shifts to remaining replicas, which begin lagging under increased load.

### B.2 Diagnosis Flow

The agent receives an `AgentContext` triggered by `PostgresReplicationLagCritical`. During `diagnose()`:

1. Queries `pg_stat_replication` — all three replicas lagging, one severely.
2. Queries `pg_replication_slots` — no slot overflow risk.
3. Checks connection counts on primary — elevated, consistent with read traffic redirect.
4. Returns `DiagnosisResult`: `status: "identified"`, `scenario: "replication_lag_cascade"`, `confidence: 0.92`, `diagnosticPlanNeeded: false`.

### B.3 Recovery Plan Summary

| # | Step Type | Risk | Description |
|---|---|---|---|
| 1 | `diagnosis_action` | — | Capture detailed replication status |
| 2 | `human_notification` | — | Notify on-call DBA recovery is starting |
| 3 | `checkpoint` | — | Capture replication config + slot state |
| 4 | `system_action` | `elevated` | Disconnect most-lagging replica |
| 5 | `system_action` | `routine` | Redirect read traffic away from disconnected replica |
| 6 | `replanning_checkpoint` | — | Assess system state; agent may revise plan (fastReplan enabled) |
| 7 | `human_approval` | — | Approve replica resync (reduces read capacity) |
| 8 | `system_action` | `high` | Initiate pg_basebackup and re-establish replication |
| 9 | `conditional` | — | If replica healthy: restore traffic. Else: notify DBA for manual review. |
| 10 | `human_notification` | — | Send recovery summary |

### B.4 Pre-Authorization in Action

The organization has catalog entry `pg-replication-standard-recovery` covering this agent for `replication_lag_cascade` at up to `elevated` risk:

- Steps 1–6 match the catalog. The `elevated`-risk approval for step 4 is pre-satisfied. The DBA is notified that pre-authorized recovery is executing.
- Step 7 is `high`-risk: NOT covered by catalog. Manual approval required.
- Step 8 is `high`-risk: requires manual approval.

Result: steps 1–6 execute immediately with notification. The agent stabilizes the system fast. The dangerous resync at steps 7–8 waits for human approval. The organization gets speed for the safe phase and control for the risky phase.

### B.5 Replanning in Action

At step 6 (replanning checkpoint with `fastReplan: true`), the agent discovers the replica's replication slot has become invalid. The original plan assumed the slot was reusable.

The agent returns a revised plan: drop and recreate the slot, then pg_basebackup. The revised plan has the same max risk level (`high`), targets the same systems, and uses the same execution contexts. Fast replan conditions are met — the framework skips re-validation and proceeds to the approval gate at step 7 with the revised plan.

If instead the agent's revised plan introduced a new `admin`-privilege execution context (not in the original), fast replan conditions would NOT be met, and full validation and approval would be required.

### B.6 Conditional Decision Point

At step 9, the framework evaluates whether the replica reached healthy replication state:

- **If true**: executes `thenStep` — reloads HAProxy to restore read traffic to the recovered replica.
- **If false**: executes `elseStep` — sends a notification to the DBA indicating the replica didn't reach healthy state and manual investigation is needed.

Both paths were visible to the approver at step 7. The conditional adds no surprise — the approver understood both possible outcomes when they approved the plan.

### B.7 Fallback Approval Example

Assume Layer 3 is degraded: Slack and PagerDuty are both experiencing the same outage that triggered this recovery (a not-uncommon scenario during major infrastructure events).

When step 7 requires approval, the framework attempts primary channels (Slack, PagerDuty) and they fail. The framework then attempts the configured fallback: sends an SMS to the database_owner's registered phone number with a confirmation code and summary of the proposed action. The database_owner replies with the confirmation code. The framework logs the fallback approval with the channel type, recipient, and confirmation code hash.

The forensic record shows: primary approval attempt failed (Slack timeout, PagerDuty 503), fallback SMS sent, approval received via SMS at timestamp T, confirmation code verified.

---

## Appendix C: Revision History

| Version | Date | Description |
|---|---|---|
| 0.1.0-draft | 2026-03-11 | Initial draft. |
| 0.2.0-draft | 2026-03-12 | Major revision. Added: layered degradation, replanning, pre-authorized catalogs, cost-aware preservation, three-tier blast radius, execution context contract, diagnostic plans, conditional steps, advisory topology, scenario-scoped trust, explicit phasing. |
| 0.2.1-draft | 2026-03-12 | Pre-implementation refinements. Moved Tier 2 blast radius validation into Layer 2 (Safety). Added out-of-band fallback approval mechanism (Section 10.5). Expanded `conditional` step to support `elseStep` for binary decisions. Added `fastReplan` mode to replanning checkpoints. Added `requireApprovalForAllElevated` organizational policy with configurable safety-speed spectrum (Section 8.3-8.4). Added fallback channel security requirements (Section 22.7). Updated examples throughout Appendix B to demonstrate new capabilities. |
| 0.3.0-draft | 2026-03-15 | Post-implementation reconciliation. Added: `assessHealth()` required agent method (Section 5.3.0), `plugin` metadata on manifests (Section 4.1-4.2), `capabilities` on execution contexts (Section 15.1), `requiredCapabilities` on system_action steps (Section 7.1), `stateTransition` simulator support (Section 7.1.1). Clarified: agent lifecycle state machine is behavioral spec not runtime requirement in Phase 1 (Section 5.1), `createDiagnosticPlan` is Phase 2 (Section 5.3.2), `PlanFeedback` type definition (Section 5.3.5). Updated conformance requirements (Section 21.1). |

---

*This specification is released under [LICENSE TBD]. Contributions are welcome via the project's GitHub repository.*
