# Operator Health, AI Services, and Site Configuration

**Version:** 0.1-draft
**Status:** Design Guide
**Date:** 2026-03-15
**Companion to:** [Recovery Agent Contract](../foundational/recovery-agent-contract.md), [Plugin Platform Architecture](plugin-platform.md), [Deployment & Operations](../deployment/operations.md)

---

## 1. Purpose

This document specifies three capabilities that were implemented during Phase 1 but are not covered by the foundational contract or the plugin platform guide:

1. **Operator Health Summary** — a system that translates agent health assessments and execution results into actionable operator guidance.
2. **AI Services** — framework-level AI-powered diagnosis and plan explanation available to all agents.
3. **Site Configuration** — a YAML-based configuration model for declaring targets, credentials, and agent bindings.

These capabilities are part of the spoke runtime (Layers 1–2) and operate independently of the hub.

---

## 2. Operator Health Summary

### 2.1 Problem

Recovery agents produce structured data — health assessments, plan validation results, execution step results. Operators need a single, clear answer: what is the current state, what happened, and what should I do next?

The operator summary system bridges this gap by synthesizing multiple data sources into a single actionable summary.

### 2.2 Health Assessment

Every `RecoveryAgent` MUST implement `assessHealth(context: AgentContext): Promise<HealthAssessment>`.

`HealthAssessment` captures a point-in-time view of the target system's health:

```ts
interface HealthAssessment {
  status: 'healthy' | 'recovering' | 'unhealthy' | 'unknown';
  confidence: number;       // 0.0–1.0
  summary: string;           // one-line human-readable
  observedAt: string;        // ISO 8601
  signals: HealthSignal[];   // individual observations
  recommendedActions: string[];
}

interface HealthSignal {
  source: string;            // e.g., "pg_stat_replication"
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  detail: string;
  observedAt: string;
}
```

Key constraints:

- `assessHealth()` MUST be non-mutating. It performs read-only queries against the target system.
- `assessHealth()` MAY be called outside the recovery lifecycle — for dashboards, readiness checks, or periodic monitoring.
- Health signals MUST reference their source so operators can verify independently.

### 2.3 Operator Summary

The `OperatorSummary` is the framework's synthesized output, built from health assessments, validation results, and execution results:

```ts
interface OperatorSummary {
  currentState: HealthStatus;
  confidence: number;
  summary: string;
  actionRequired: OperatorActionRequired;
  automationStatus: AutomationStatus;
  executeReadiness: ExecuteReadiness;
  mutationsPerformed: boolean;
  recommendedNextStep: string;
  recommendedActions: string[];
  evidence: HealthSignal[];
  validationBlockers: string[];
  observedAt: string;
}
```

### 2.4 Action Required

The `actionRequired` field tells the operator what to do:

| Value | Meaning |
|---|---|
| `none` | System is healthy. No action needed. |
| `monitor` | System is recovering. Watch health signals. |
| `investigate` | Health is unknown or degraded. Run diagnosis first. |
| `retry_with_execute` | Dry-run completed on an unhealthy system. Review output and rerun with `--execute`. |
| `manual_intervention_required` | Automation cannot resolve the issue. Follow manual runbook. |
| `use_different_tool` | Required capabilities lack live providers. Use manual workflows for blocked capabilities. |

### 2.5 Automation Status

| Value | Meaning |
|---|---|
| `no_mutations_performed` | Dry-run mode, or execution did not reach mutation steps. |
| `partial_mutations_performed` | Some mutations executed, but health is not fully restored. |
| `recovery_completed` | Mutations executed and health probe shows system healthy. |

### 2.6 Execute Readiness

| Value | Meaning |
|---|---|
| `ready` | Plan validates for execute mode. All capabilities have live providers. |
| `blocked` | Execute mode is blocked by validation failures or missing providers. |
| `not_applicable` | Health-check-only run, or no plan was generated. |

### 2.7 Provider Resolution in Operator Summary

When execute readiness is `blocked`, the summary MUST include:

- Which capabilities are blocked and why.
- Manual fallback instructions from the capability registry for each blocked capability.
- A clear statement not to partially execute the plan.

This ensures operators are never left with a "blocked" status and no path forward.

### 2.8 Building the Summary

`buildOperatorSummary()` accepts:

- `health`: The agent's `HealthAssessment`.
- `mode`: `'dry-run'` or `'execute'`.
- `currentValidation`: Validation result for the current execution mode.
- `executeValidation`: Validation result for execute mode (may differ from current mode).
- `results`: Step execution results (if a plan was executed).
- `healthCheckOnly`: Whether this was a health-check-only run.

The function derives `actionRequired`, `automationStatus`, and `executeReadiness` from these inputs using deterministic logic. No AI or heuristics are involved.

---

## 3. AI Services

### 3.1 Design Principles

AI services in CrisisMode are:

- **Advisory only.** AI outputs are never executable. They inform diagnosis and explain plans but do not modify system state.
- **Optional.** All AI services degrade gracefully when no API key is configured. Rule-based fallbacks produce valid, if less insightful, results.
- **Time-bounded.** Every AI call has a hard timeout (default: 10 seconds) via `AbortController`. During a crisis, blocking on an AI API call is unacceptable.
- **Input-sanitized.** All inputs to AI models are sanitized: control characters stripped, fields length-limited, to mitigate prompt injection from system telemetry.
- **Framework-level.** AI services are provided by the framework, not individual agents. This ensures consistent safety properties across all agents.

### 3.2 AI Diagnosis Toolkit

The AI diagnosis toolkit (`src/framework/ai-diagnosis.ts`) provides a reusable AI diagnosis service:

```ts
interface AiDiagnosisConfig {
  apiKey?: string;       // defaults to ANTHROPIC_API_KEY env var
  model?: string;        // defaults to claude-sonnet-4-20250514
  timeoutMs?: number;    // defaults to 10000
  maxTokens?: number;    // defaults to 1024
}

interface AiDiagnosisRequest {
  systemPrompt: string;  // domain-specific analysis instructions
  userMessage: string;   // structured system state
  parseResponse?: (text: string) => DiagnosisResult;
}

function aiDiagnose(
  request: AiDiagnosisRequest,
  config?: AiDiagnosisConfig,
): Promise<DiagnosisResult | null>;
```

Usage pattern for agents:

1. Agent collects system state through read-only queries.
2. Agent formats state into a structured message and provides a domain-specific system prompt.
3. `aiDiagnose()` calls the AI model with sanitized inputs and a timeout.
4. If the AI call succeeds, the parsed `DiagnosisResult` is returned.
5. If the AI call fails (no API key, timeout, parse error), `null` is returned.
6. Agent MUST have a rule-based fallback when `aiDiagnose()` returns `null`.

### 3.3 Input Sanitization

The `sanitizeInput()` function:

- Strips control characters (except `\n`, `\r`, `\t`).
- Truncates fields to a configurable maximum length (default: 10,000 characters).
- Appends a `[truncated]` marker when truncation occurs.

This is applied to both system prompts and user messages before any AI API call.

### 3.4 AI Plan Explainer

The plan explainer (`src/framework/ai-explainer.ts`) generates plain-English summaries of recovery plans:

```ts
interface PlanExplanation {
  summary: string;                // one-paragraph overview
  stepExplanations: StepExplanation[];  // per-step explanations
  risks: string[];                // key risks for operator awareness
  source: 'ai' | 'fallback';     // whether AI or rule-based
}

function explainPlan(
  plan: RecoveryPlan,
  diagnosis: DiagnosisResult,
): Promise<PlanExplanation>;
```

The explainer:

- Uses AI when `ANTHROPIC_API_KEY` is set.
- Falls back to a structural summary (step type + risk level + blast radius) when no key is available.
- Never modifies the plan. Explanations are purely informational.
- Uses the same timeout and sanitization as the diagnosis toolkit.

### 3.5 Safety Model

| Property | Guarantee |
|---|---|
| Non-mutating | AI outputs are never fed back as executable commands. |
| Timeout-bounded | 10-second default. `AbortController`-enforced. |
| Graceful fallback | All callers have rule-based fallbacks. No AI dependency in the critical path. |
| Input sanitization | Control characters stripped. Length limits enforced. |
| Lazy SDK loading | The Anthropic SDK is dynamically imported. It is not required at startup. |
| No credential exposure | System state passed to AI models MUST NOT include credentials. Agent authors are responsible for excluding sensitive fields from the `userMessage`. |

---

## 4. Site Configuration

### 4.1 Purpose

The site configuration system (`crisismode.yaml`) provides a declarative way to configure the spoke runtime. It defines targets (what systems to manage), credentials (how to authenticate), and agent bindings (which agents handle which targets).

### 4.2 Configuration Schema

```yaml
apiVersion: crisismode/v1
kind: SiteConfig

metadata:
  name: my-cluster
  environment: production  # production | staging | development

hub:
  endpoint: https://hub.crisismode.ai
  credentials:
    type: env
    key: CRISISMODE_HUB_TOKEN

webhook:
  port: 9095
  secret:
    type: env
    key: WEBHOOK_SECRET

execution:
  mode: dry-run  # dry-run | execute

targets:
  - name: pg-primary
    kind: postgresql
    version: "16.2"       # optional, can be auto-discovered
    agent: postgresql-replication-recovery  # optional, pin to specific agent
    primary:
      host: localhost
      port: 5432
      database: postgres
    replicas:
      - host: localhost
        port: 5433
    credentials:
      type: env
      username: PG_USER
      password: PG_PASSWORD
```

### 4.3 Credential Resolution

Three credential reference types are supported:

| Type | Description | Use Case |
|---|---|---|
| `env` | Environment variable reference | Local development, CI, containers |
| `k8s-secret` | Kubernetes Secret reference | Production Kubernetes deployments |
| `value` | Inline value | Testing only. SHOULD NOT be used in production. |

Credentials are resolved at startup. The `ResolvedTarget` type contains hydrated credential values that are never persisted to disk.

### 4.4 Agent Registry

The `AgentRegistry` (`src/config/agent-registry.ts`) resolves targets to agents:

1. If a target specifies an `agent` name, that exact agent is used.
2. Otherwise, agents are matched by `kind` (e.g., `postgresql`) and filtered by version compatibility using semver.
3. The first compatible registration is selected.

#### 4.4.1 Version-Aware Agent Selection

Agents declare version constraints in their manifest (`spec.targetSystems[].versionConstraint`). When a target specifies a `version`, only agents whose constraints satisfy that version are selected.

If no version is specified, all agents for that kind match (backward-compatible).

#### 4.4.2 Version Discovery

For live infrastructure, the registry supports runtime version discovery:

```ts
static async discoverVersion(instance: AgentInstance): Promise<void>;
```

This calls the backend's optional `discoverVersion()` method with a 3-second timeout. Discovery is best-effort — it updates the target's version if successful but does not fail the recovery flow if it can't determine the version.

### 4.5 Alert Dispatch

The registry can dispatch incoming alerts to the appropriate agent:

```ts
async dispatchAlert(alertLabels: Record<string, string>): Promise<AgentInstance | undefined>;
```

Matching uses the manifest's `triggerConditions[].matchLabels`. When multiple targets of the same kind exist, the alert's `instance` label is used for disambiguation by matching against `host:port`.

### 4.6 Initialization

The `crisismode init` command generates a starter `crisismode.yaml` with:

- Placeholder targets for each registered agent kind.
- Environment variable credential references.
- Default dry-run execution mode.
- Commented examples for each configuration section.

### 4.7 Relationship to Deployment Spec

The site configuration system is the spoke-local configuration model for Phase 1. It corresponds to the "spoke configuration" referenced in the Deployment & Operations spec (Section 10.2 MVP Helm Chart Structure, ConfigMap). In future phases:

- Hub-managed configuration may override or supplement `crisismode.yaml`.
- The YAML schema will evolve to support additional target kinds and credential backends.
- Configuration drift detection (Deployment spec Section 8.4) will reconcile local config against hub state.

---

## 5. Relationship to Other Specifications

| This Document | Foundational Contract | Plugin Platform | Deployment & Operations |
|---|---|---|---|
| `assessHealth()` | Required agent method (Section 5.3.0) | — | Health signals feed spoke health metrics (Section 9.1) |
| `OperatorSummary` | Uses validation results from Section 6-7 | Uses capability resolution from provider registry | Feeds operator dashboard |
| AI diagnosis | Advisory findings alongside agent diagnosis (Section 5.3.1) | — | — |
| AI plan explainer | Explains plans from Section 6 | — | — |
| Site config | Configures execution contexts from Section 15 | Configures agent/target bindings | Spoke-local config (Section 10.2) |
| Agent registry | Selects agents per Section 2.2 | Precursor to domain pack routing (Section 9.1) | Agent catalog (Appendix A) |

---

## 6. Open Questions

- Should `OperatorSummary` be included in the forensic record?
- Should AI diagnosis findings be flagged differently in the forensic record to distinguish them from rule-based findings?
- Should the site config schema support multiple configuration files (e.g., split targets across files)?
- Should version discovery be mandatory for live execution mode?
