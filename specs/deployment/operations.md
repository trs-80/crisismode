# Deployment & Operations Specification
## AI Crisis Recovery Framework

**Hub-and-Spoke Architecture with Autonomous Spoke Operation**

Version 1.0 | March 2026 | DRAFT

Companion to: AI Crisis Recovery Framework Core Specification

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Architecture Overview](#2-architecture-overview)
3. [Spoke Deployment Patterns](#3-spoke-deployment-patterns)
4. [Hub Deployment Options](#4-hub-deployment-options)
5. [Bootstrap and Enrollment](#5-bootstrap-and-enrollment)
6. [Integration Patterns](#6-integration-patterns)
7. [Credential and Access Model](#7-credential-and-access-model)
8. [Upgrade and Lifecycle Management](#8-upgrade-and-lifecycle-management)
9. [Framework Observability](#9-framework-observability)
10. [MVP Deployment Specification](#10-mvp-deployment-specification)
11. [Open Source Considerations](#11-open-source-considerations)
12. [Post-MVP Deployment Roadmap](#12-post-mvp-deployment-roadmap)
- [Appendix A: Glossary](#appendix-a-glossary)
- [Appendix B: Reference Architecture Diagram Keys](#appendix-b-reference-architecture-diagram-keys)

---

## 1. Introduction

This specification defines the deployment architecture, installation procedures, integration patterns, and operational management for the AI Crisis Recovery Framework. It serves as the companion document to the Core Specification, translating the system's layered architecture into concrete deployment models that customers can install, configure, and operate in their environments.

### 1.1 Purpose and Scope

The Core Specification defines what the system does: a four-layer framework for automated infrastructure recovery during crisis events. This document defines where the system lives and how it connects. It covers the deployment topology, spoke runtime packaging, hub control plane deployment, bootstrap and enrollment flows, integration with existing customer tooling, credential and secret management, upgrade and lifecycle management, and observability of the framework itself.

### 1.2 Design Tension

The framework faces a fundamental tension between two competing requirements. Deep system access is needed because the framework executes SQL against databases, restarts services, and modifies configurations. Degraded-mode operation is needed because the framework must work precisely when centralized systems fail. These pull in opposite directions: deep access suggests a centralized control plane, while degraded-mode operation suggests something local to target systems. The hub-and-spoke architecture with autonomous spokes resolves this tension by separating coordination from execution.

### 1.3 Relationship to Core Specification

This document references the four-layer architecture defined in the Core Specification:

- **Layer 1:** Execution Kernel (plan parsing, action dispatch, state machine)
- **Layer 2:** Safety (state capture, plan validation, execution context enforcement)
- **Layer 3:** Coordination (approval routing, catalog matching, escalation management)
- **Layer 4:** Enrichment (topology, trust tracking, analytics, management UI)

The deployment architecture maps these layers to physical components: Layers 1-2 run in the spoke, Layers 3-4 run in the hub. This mapping directly enables the degradation behavior defined in the Core Specification.

---

## 2. Architecture Overview

The deployment model is a hub-and-spoke topology where the hub provides centralized coordination and enrichment while spokes operate autonomously close to target systems.

### 2.1 Hub (Control Plane)

The hub hosts Layers 3 and 4 of the framework. It handles coordination (approval routing, catalog matching, escalation management), enrichment (topology modeling, trust tracking, analytics), and the management UI where organizations configure policies, register agents, manage catalogs, and review forensic records. The hub does not touch target systems directly.

**Deployment options:** The hub can be deployed as SaaS (hosted by the vendor), self-hosted (customer runs it in their cloud or data center), or hybrid (hub components split across vendor and customer infrastructure).

### 2.2 Spoke (Execution Runtime)

Spokes are lightweight runtimes deployed close to target systems. Each spoke contains Layer 1 (execution kernel) and Layer 2 (safety layer including state capture, plan validation, and execution context enforcement). A spoke can execute a validated recovery plan against local target systems without any connection to the hub.

**Connected mode:** Spoke receives plans and context from the hub, streams audit data back in real time.

**Disconnected mode:** Spoke operates from cached policies and locally-cached agent definitions. Forensic records are queued locally and synced when connectivity is restored.

### 2.3 Layer-to-Component Mapping

| Framework Layer | Component | Degradation Behavior |
|---|---|---|
| Layer 4: Enrichment | Hub | Unavailable when hub unreachable; spoke operates without enrichment context |
| Layer 3: Coordination | Hub | Unavailable when hub unreachable; spoke falls back to cached approval policies |
| Layer 2: Safety | Spoke | Always available; state capture, validation, and context enforcement run locally |
| Layer 1: Execution | Spoke | Always available; plan execution against local targets continues independently |

### 2.4 Security Boundary Principle

The spoke runs in the customer's environment with the customer's credentials. The hub never holds database passwords, cloud API keys, or other target system secrets. The spoke authenticates to target systems using credentials the customer provisions (Kubernetes service accounts, IAM roles, database connection strings stored in the customer's secret manager). The hub authenticates to the spoke using a separate identity that has no target system access.

This separation means a compromise of the hub does not expose customer systems. It also means customers in regulated environments can satisfy compliance requirements because the access topology is clear: vendor code runs in the customer's boundary, using the customer's credentials, under the customer's network policies.

---

## 3. Spoke Deployment Patterns

The spoke deployment model varies by customer environment. Three primary patterns are defined, with the Kubernetes pattern serving as the MVP target.

### 3.1 Kubernetes Environments (MVP)

For Kubernetes-native customers, the spoke deploys as a single pod via Helm chart (evolving to DaemonSet or operator in later releases). It runs with a service account scoped to the namespaces and resources it needs to manage.

| Property | Value |
|---|---|
| Packaging | Helm chart (single pod initially, DaemonSet/Operator later) |
| Identity | Kubernetes ServiceAccount with RBAC scoped to target namespaces |
| Trigger ingress | Prometheus AlertManager webhook receiver |
| Hub communication | Outbound HTTPS to hub API endpoint |
| Target access | Kubernetes API, pod exec, database protocols via K8s network |
| Secret source | Kubernetes Secrets, external-secrets-operator, or mounted volumes |
| Resource footprint | 256Mi memory request, 500Mi limit; 100m CPU request, 500m limit |

**Service Account RBAC:** The Helm chart generates a ClusterRole and RoleBindings scoped to specific namespaces. Minimum permissions for the MVP PostgreSQL agent include: get/list pods, exec into pods (for psql commands), get/list services, get/list/watch events, and read access to specified Secrets.

### 3.2 Cloud-Managed Services

For cloud-managed databases and services (RDS, Aurora, ElastiCache, managed Kafka), the spoke deploys as a lightweight container or serverless function in the customer's cloud account.

| Property | Value |
|---|---|
| Packaging | Container image (ECS/Fargate) or Lambda/Cloud Function |
| Identity | IAM role scoped to specific managed services |
| Trigger ingress | CloudWatch Alarm actions, EventBridge rules, or SNS topics |
| Hub communication | Outbound HTTPS over internet or VPC peering |
| Target access | VPC network to managed service endpoints |
| Secret source | AWS Secrets Manager, Azure Key Vault, GCP Secret Manager |
| Resource footprint | 512Mi memory, 0.25 vCPU (container); 256Mi memory (Lambda) |

### 3.3 On-Premise Environments

For on-premise infrastructure, the spoke deploys as a system service on a management host within the customer's network. This is the most operationally complex pattern but represents the least competitive landscape in the AI SRE space.

| Property | Value |
|---|---|
| Packaging | systemd unit, Docker container, or lightweight VM appliance |
| Identity | Service account on management host with network access to targets |
| Trigger ingress | Nagios/Zabbix webhooks, Prometheus push, or custom alert adapters |
| Hub communication | Outbound HTTPS through corporate proxy/firewall |
| Target access | SSH, database protocols, API endpoints on internal network |
| Secret source | HashiCorp Vault, CyberArk, or local encrypted credential store |
| Resource footprint | 1GB memory, 1 vCPU minimum |

### 3.4 Deployment Pattern Priority

| Phase | Pattern | Rationale |
|---|---|---|
| MVP | Kubernetes (Helm chart, single pod) | Easiest deployment story; K8s has a built-in model for scoped access; majority of early adopters are K8s-native |
| Phase 2 | Cloud-managed (IAM + container/Lambda) | Expands to RDS/Aurora customers; leverages cloud-native identity |
| Phase 3 | On-premise (systemd/Docker on management host) | Addresses regulated industries; lowest competition in market |
| Phase 4 | Multi-spoke topology | Complex environments with multiple clusters, accounts, or data centers |

### 3.5 Resource Sizing Guidance

The resource footprints listed in sections 3.1-3.3 represent baseline values for the MVP single-agent (PostgreSQL) configuration. Actual resource requirements are agent-dependent and scale with the number of concurrent recovery operations, the complexity of agent diagnosis steps, and the volume of incoming alerts.

**Sizing factors:**

- **Agent count:** Each additional agent loaded into the spoke adds memory overhead for its definition, cached state, and execution context. Budget approximately 50-100Mi per active agent beyond the first.
- **Alert volume:** Under sustained high-alert conditions (e.g., cascading failures generating dozens of alerts per minute), the spoke's webhook receiver and trigger normalization pipeline consume additional CPU. The Helm chart exposes CPU burst limits (default: 500m request, 1000m limit) to accommodate spikes.
- **Forensic queue:** During extended disconnected operation, the forensic queue grows. The PVC size (default: 1GB) should be increased for environments expecting prolonged hub outages.
- **Concurrent executions:** Each in-progress recovery plan holds execution state in memory. The default concurrency limit is 5 simultaneous plans; environments expecting higher concurrency should increase memory limits proportionally.

All resource values in the Helm chart are exposed as configurable parameters. The hub UI will surface resource utilization data from spoke health signals to help customers right-size their deployments after initial installation.

---

## 4. Hub Deployment Options

### 4.1 SaaS (Vendor-Hosted)

The default deployment for MVP and most customers. The vendor operates the hub as a multi-tenant cloud service. Customers connect their spokes via outbound HTTPS. No customer infrastructure is required beyond the spoke deployment.

- Multi-tenant with logical isolation per organization
- Vendor manages availability, upgrades, and scaling
- Data residency: initially single region; multi-region in later phases
- SLA target: 99.9% availability for hub API endpoints

### 4.2 Self-Hosted

For customers with strict data residency or air-gapped requirements, the hub is packaged for deployment in the customer's own environment.

- Delivered as Helm chart (Kubernetes) or Docker Compose (single-node)
- Customer manages availability, upgrades, and backups
- Hub components: API server, event processor, database (PostgreSQL), object store
- Minimum resources: 4 vCPU, 8GB RAM, 100GB persistent storage

### 4.3 Hybrid

Hub management UI and analytics run as vendor SaaS. Plan delivery and approval routing run as a lightweight relay in the customer's environment, reducing data that leaves the customer boundary. This model suits customers who want vendor-managed operations but have constraints on where execution telemetry can reside.

---

## 5. Bootstrap and Enrollment

This section defines the end-to-end flow from customer sign-up to first automated recovery.

### 5.1 Enrollment Sequence

1. Customer creates an organization in the hub (SaaS sign-up or self-hosted initialization).
2. Customer creates an Environment representing a deployment target (production K8s cluster, AWS account, on-prem data center).
3. Hub generates a spoke configuration package: deployment manifest plus a one-time bootstrap token.
4. Customer deploys the spoke using the generated manifest (Helm chart, Terraform module, or installation script depending on pattern).
5. Spoke starts, presents its bootstrap token to the hub, and completes a mutual authentication handshake.
6. Hub provisions a long-lived identity (mTLS certificate or signed JWT) for the spoke.
7. Spoke begins discovery: inventories reachable systems and reports back to the hub, populating the initial topology model.
8. Customer configures execution contexts in the hub, granting the spoke access to specific systems with specific privileges.
9. Customer registers agents and configures catalogs.
10. System is operational. First alert triggers end-to-end recovery flow.

### 5.2 Bootstrap Token Security

Bootstrap tokens are single-use, time-limited (default: 24 hours), and scoped to a specific environment. They are transmitted to the customer through the hub UI or API and are never stored in the spoke manifest itself. The Helm chart accepts the token as a Kubernetes Secret reference, not a plain-text value.

### 5.3 Spoke Identity Lifecycle

After bootstrap, the spoke holds a long-lived identity credential (mTLS client certificate preferred; signed JWT as alternative). This credential is rotated automatically on a configurable schedule (default: 90 days). If a spoke's identity is compromised or the spoke is decommissioned, the hub revokes the identity and the spoke can no longer authenticate. Revocation is immediate and does not depend on certificate expiry.

**In-flight action protection:** Identity rotation and revocation must not interrupt in-progress recovery plan execution. The spoke implements a "drain then rotate" semantic: when a rotation or revocation signal arrives, the spoke finishes any active plan execution under the current identity before switching to the new credential (rotation) or entering a locked-out state (revocation). The maximum drain window is configurable (default: 15 minutes). If an active plan exceeds the drain window, the spoke logs a warning, completes the current action step, captures state, and then rotates. This prevents partial-state failures where a recovery operation is interrupted mid-execution. Every rotation and revocation event is logged to the forensic record with timestamps and the execution state at transition time.

### 5.4 Discovery Phase

On first connection, the spoke performs an automated inventory of reachable systems. For Kubernetes environments, this includes namespaces, deployments, statefulsets, services, and any resources matching configured label selectors. For cloud environments, this includes tagged resources within the IAM role's permission scope. Discovery results are reported to the hub and used to populate the topology model. Discovery can be re-triggered manually or runs on a configurable schedule (default: hourly).

---

## 6. Integration Patterns

The framework plugs into a customer's existing tooling ecosystem rather than replacing it. Four integration categories are defined.

### 6.1 Trigger Integration (Alert Ingress)

The spoke receives alerts from the customer's existing monitoring and converts them into the trigger format defined in the Core Specification. The spoke exposes a webhook receiver with adapter plugins for common alert formats.

| Source | Integration Method | MVP Priority |
|---|---|---|
| Prometheus AlertManager | Webhook receiver with native AlertManager payload parsing | MVP |
| Datadog | Webhook with Datadog alert payload adapter | Phase 2 |
| PagerDuty | PagerDuty Event Rules webhook adapter | Phase 2 |
| CloudWatch Alarms | SNS topic subscription with CloudWatch payload adapter | Phase 2 |
| Nagios / Zabbix | Webhook adapter for legacy monitoring formats | Phase 3 |
| Custom | Generic JSON webhook with configurable field mapping | Phase 2 |

Each adapter normalizes the incoming alert into a standard trigger envelope containing: source system identifier, alert name/ID, severity, affected resource(s), timestamp, and raw payload for forensic records.

### 6.2 Notification and Approval Integration

Layer 3 sends notifications and approval requests through the customer's existing communication channels. Notification routing is configurable per role and per escalation tier.

| Channel | Integration Method | MVP Priority |
|---|---|---|
| Slack | Slack App with interactive message buttons for approve/deny | MVP |
| Microsoft Teams | Teams Bot with adaptive cards for approval actions | Phase 2 |
| PagerDuty | PagerDuty incident creation with custom details | Phase 2 |
| OpsGenie | OpsGenie alert API with action callbacks | Phase 3 |
| Email | SMTP with unique reply-to addresses for approval actions | Phase 2 |
| SMS (fallback) | Twilio or SNS for emergency escalation when primary channels fail | Phase 3 |

**Fallback approval channel:** The Core Specification (Section 10.5) requires a fallback approval path when primary notification channels are unreachable. The fallback channel must be configured separately from the primary channel and should ideally use a different infrastructure provider (for example, SMS via Twilio as fallback for Slack-primary).

### 6.3 Observability Integration (Metrics Read)

Agent diagnosis steps need to query the customer's existing monitoring to gather context during incident assessment. This is implemented through a `metrics_read` execution context type.

| Source | Query Method | MVP Priority |
|---|---|---|
| Prometheus | PromQL via Prometheus HTTP API | MVP |
| Datadog | Datadog Metrics API v2 | Phase 2 |
| Grafana | Grafana Data Source proxy API | Phase 2 |
| CloudWatch | CloudWatch GetMetricData API via IAM role | Phase 2 |
| Custom endpoints | HTTP GET with configurable URL template and response parsing | Phase 3 |

### 6.4 Secret Management Integration

The spoke retrieves target system credentials from the customer's existing secret manager at execution time. Credentials are never stored persistently by the spoke; they are fetched when an action requires them and discarded after the action completes.

| Secret Manager | Integration Method | MVP Priority |
|---|---|---|
| Kubernetes Secrets | Native K8s API with projected volume or API read | MVP |
| HashiCorp Vault | Vault Agent sidecar or direct API with AppRole auth | Phase 2 |
| AWS Secrets Manager | AWS SDK with IAM role assumption | Phase 2 |
| Azure Key Vault | Azure SDK with managed identity | Phase 3 |
| GCP Secret Manager | GCP SDK with workload identity | Phase 3 |

---

## 7. Credential and Access Model

### 7.1 Credential Separation

Three distinct credential domains exist in the system, and they must never be co-mingled:

| Domain | Purpose | Holder | Storage |
|---|---|---|---|
| Hub-to-Spoke | Hub authenticates to spoke for plan delivery, approval relay | Hub | Hub database (encrypted) |
| Spoke-to-Hub | Spoke authenticates to hub for telemetry, sync | Spoke | Local credential store (mTLS cert or JWT) |
| Spoke-to-Target | Spoke authenticates to customer systems for action execution | Customer | Customer's secret manager; never persisted by spoke |

### 7.2 Execution Context Scoping

Execution contexts (defined in the Core Specification) are configured in the hub and enforced by the spoke. Each context grants the spoke access to a specific target system with specific privileges. The customer explicitly defines what the spoke can touch.

Context types for MVP:

- **database_write:** Connection to a specific database with DML/DDL permissions (e.g., PostgreSQL via connection string from K8s Secret)
- **database_read:** Read-only connection for diagnostic queries
- **k8s_admin:** Kubernetes API access scoped to specific namespaces and resource types
- **metrics_read:** Query access to a monitoring system endpoint

### 7.3 Least Privilege Enforcement

The spoke validates at startup that its configured credentials match the declared execution context scope. If a `database_read` context's credentials have write permissions, the spoke logs a warning and optionally blocks the context from activating (configurable as warn or enforce mode). This prevents credential over-provisioning from expanding the blast radius.

---

## 8. Upgrade and Lifecycle Management

### 8.1 Spoke Upgrade Strategy

Spoke upgrades must be non-disruptive and must not interrupt in-progress recovery operations.

- **Rolling updates:** For Kubernetes deployments, spoke pods are updated via standard rolling deployment. The pod gracefully drains in-progress operations before terminating.
- **Version compatibility:** The hub maintains backward compatibility with the previous two spoke versions. Spokes older than N-2 generate a warning in the hub UI.
- **Canary upgrades:** Customers with multiple spokes can upgrade one spoke first and validate before rolling to the rest.
- **Automatic updates:** Optional auto-update channel where the spoke polls the hub for new versions and self-upgrades during configurable maintenance windows.

### 8.2 Hub Upgrade Strategy

For SaaS-hosted hubs, upgrades are managed by the vendor with zero-downtime deployment. For self-hosted hubs, upgrade manifests are provided with migration scripts and rollback procedures.

### 8.3 Spoke Decommissioning

When a spoke is decommissioned, the customer deletes the deployment. The hub detects the spoke's absence (heartbeat timeout, default: 5 minutes) and marks it inactive. An inactive spoke's identity is automatically revoked after a configurable grace period (default: 24 hours). All forensic records and audit trails associated with the spoke are retained in the hub per the organization's data retention policy.

### 8.4 Configuration Drift Detection

The spoke periodically validates that its local configuration matches the hub's declared state. If drift is detected (for example, an execution context was removed in the hub but the spoke still has it cached), the spoke reconciles to the hub's state on next sync. During disconnected operation, drift detection is paused and reconciliation occurs on reconnection.

### 8.5 Policy Staleness Window

When operating in disconnected mode, the spoke relies on cached policies, agent definitions, and catalog rules. These caches become increasingly unreliable over time as the hub-side configuration may have changed. To prevent a spoke from executing recovery plans based on outdated logic, the spoke enforces a maximum offline policy age.

**Behavior thresholds:**

- **Warning (default: 1 hour):** Spoke logs a warning and emits the `spoke_cached_policies_age_seconds` metric at elevated severity. Recovery operations continue normally.
- **Degraded (default: 24 hours):** Spoke restricts execution to pre-approved auto-execute policies only. Actions requiring hub-side approval are queued, not executed. The hub UI shows the spoke in a "degraded-stale" state on reconnection.
- **Lockout (default: 7 days):** Spoke stops executing new recovery plans entirely and emits a critical alert. Existing in-flight plans are allowed to complete. The spoke requires a policy sync (or manual override via CLI) before resuming operations.

All thresholds are configurable per environment. Each cached policy bundle carries a revision number and timestamp, and the spoke evaluates staleness against the bundle timestamp, not the last hub contact time.

---

## 9. Framework Observability

The framework itself must be observable. This section defines the metrics, logs, and health signals that the spoke and hub emit.

### 9.1 Spoke Health Signals

| Signal | Type | Description |
|---|---|---|
| `spoke_heartbeat` | Gauge | Last successful heartbeat timestamp; hub uses for liveness detection |
| `spoke_plan_executions_total` | Counter | Total recovery plans executed, labeled by outcome (success/failure/rollback) |
| `spoke_action_duration_seconds` | Histogram | Duration of individual action executions |
| `spoke_hub_sync_lag_seconds` | Gauge | Time since last successful hub synchronization |
| `spoke_cached_policies_age_seconds` | Gauge | Age of locally cached policies; alerts when stale beyond threshold |
| `spoke_forensic_queue_depth` | Gauge | Number of forensic records queued for hub sync (nonzero indicates disconnected operation) |
| `spoke_target_reachability` | Gauge | Per-target reachability status (1 = reachable, 0 = unreachable) |

### 9.2 Hub Health Signals

| Signal | Type | Description |
|---|---|---|
| `hub_connected_spokes` | Gauge | Number of spokes currently connected and reporting |
| `hub_approval_latency_seconds` | Histogram | Time from approval request to approval decision |
| `hub_catalog_match_duration_seconds` | Histogram | Time to match a trigger to an agent and plan |
| `hub_forensic_records_total` | Counter | Total forensic records received, labeled by spoke and outcome |
| `hub_trust_score_distribution` | Histogram | Distribution of agent trust scores across the fleet |

### 9.3 Logging Standards

Both hub and spoke emit structured JSON logs. Log levels follow standard severity (DEBUG, INFO, WARN, ERROR). Every log entry includes: timestamp (RFC 3339), component (hub or spoke ID), correlation ID (traces across hub-spoke boundary), and action context (execution ID when within a recovery operation). Logs are written to stdout for container-native collection.

### 9.4 Alerting on the Framework

Customers should configure alerts on the framework itself using their existing monitoring. Recommended alert conditions:

- Spoke heartbeat missing for more than 5 minutes
- Forensic queue depth growing (indicates hub connectivity issues)
- Cached policy age exceeding threshold (default: 1 hour)
- Plan execution failure rate exceeding threshold (default: 20% over 1 hour window)
- Hub approval latency exceeding threshold (default: 5 minutes p95)

### 9.5 Forensic Queue Durability

During disconnected operation, the spoke queues forensic records locally for later synchronization to the hub. Because auditability is a foundational requirement of the framework, this queue must survive spoke restarts, pod evictions, and node failures.

**Storage implementation:** The forensic queue is persisted to a local embedded store (SQLite in WAL mode or an append-only file) on a Kubernetes PersistentVolumeClaim. The Helm chart provisions a small PVC (default: 1GB) for forensic queue storage. Each record is written to the durable store before the corresponding action is acknowledged as complete, ensuring no forensic gap even on abrupt termination.

**Queue replay:** On reconnection to the hub, the spoke replays queued forensic records in chronological order via a batch sync API. Records are removed from the local store only after the hub acknowledges receipt. If replay fails partway through, the spoke resumes from the last acknowledged record on next attempt.

**Capacity management:** If the local store approaches capacity (default threshold: 80%), the spoke emits a critical alert via the `spoke_forensic_queue_depth` metric. The spoke continues executing recovery plans even when the queue is full — operational recovery takes priority over telemetry — but logs a warning that forensic completeness is degraded. This tradeoff (recovery over audit completeness) is explicit and visible in the hub UI on reconnection.

**MVP note:** For the MVP Kubernetes deployment, the PVC uses the cluster's default StorageClass. Customers with strict durability requirements can specify a StorageClass backed by replicated storage (e.g., EBS gp3, Ceph, Longhorn).

---

## 10. MVP Deployment Specification

This section defines the concrete, buildable first deployment of the system. The MVP targets Kubernetes environments with PostgreSQL recovery as the first agent.

### 10.1 MVP Components

| Component | Implementation |
|---|---|
| Hub | Vendor-hosted SaaS with REST API and web management UI |
| Spoke | Single Kubernetes pod deployed via Helm chart |
| Trigger source | Prometheus AlertManager webhook |
| Notification channel | Slack (interactive messages with approval buttons) |
| First agent | PostgreSQL recovery (connection pooling, query termination, vacuum, replication health) |
| Secret source | Kubernetes Secrets |
| Identity | Bootstrap token into mTLS certificate |

### 10.2 MVP Helm Chart Structure

The Helm chart produces the following Kubernetes resources:

- **Deployment:** Single replica spoke pod running the spoke container image
- **ServiceAccount:** With RBAC bindings scoped to configured target namespaces
- **ClusterRole / RoleBinding:** Minimum permissions for PostgreSQL agent operation
- **Service:** ClusterIP service exposing the webhook receiver for AlertManager
- **ConfigMap:** Spoke configuration (hub endpoint, environment ID, alert adapter settings)
- **Secret reference:** Pointer to the Kubernetes Secret containing the bootstrap token

### 10.3 MVP Installation Flow

The target experience is: customer installs one Helm chart, configures their Slack workspace, and has automated PostgreSQL recovery running.

1. Customer signs up at the hub web UI and creates an organization.
2. Customer creates an environment for their Kubernetes cluster.
3. Hub generates a Helm values file containing the hub API endpoint, environment ID, and a bootstrap token reference.
4. Customer creates a Kubernetes Secret with the bootstrap token.
5. Customer runs: `helm install crisis-spoke crisis-chart/ -f values.yaml`
6. Spoke starts, authenticates with hub, discovers cluster resources.
7. Customer configures the PostgreSQL execution context in the hub UI (selects which K8s Secret holds the database credentials, specifies target namespace and pod selectors).
8. Customer configures Slack integration in the hub UI (installs Slack app, selects notification channel).
9. Customer configures AlertManager to send PostgreSQL-related alerts to the spoke's webhook endpoint.
10. System is operational.

### 10.4 MVP Success Criteria

- End-to-end time from Helm install to first automated recovery: under 30 minutes
- Spoke operates correctly when hub connectivity is temporarily lost
- Forensic records for all actions are complete and retrievable from hub
- Approval flow works through Slack with configurable timeout and escalation
- PostgreSQL agent successfully handles: connection pool exhaustion, long-running query termination, vacuum operations, and replication lag remediation

---

## 11. Open Source Considerations

The spoke is a candidate for open-source release. The hub provides the commercial value. This follows the model established by HashiCorp (Terraform/Vault), Grafana Labs, and GitLab.

### 11.1 Rationale

- **Trust:** The spoke runs in the customer's environment and handles their data. Open-sourcing lets security teams audit exactly what runs in their infrastructure.
- **Platform:** If the spoke is open source, third-party agent builders can test against a real runtime without needing access to the commercial hub.
- **Adoption:** Open-source spokes lower the barrier to evaluation and proof-of-concept deployments.
- **Community:** Agent contributions from the community expand the framework's coverage of infrastructure types.

### 11.2 Boundary

| Component | License | Rationale |
|---|---|---|
| Spoke runtime (Layers 1-2) | Open source (Apache 2.0 or BSL) | Runs in customer environment; trust through transparency |
| Agent SDK and agent format spec | Open source (Apache 2.0) | Enables third-party agent ecosystem |
| Hub API and coordination (Layers 3-4) | Commercial | Provides management, analytics, multi-tenant coordination |
| Hub management UI | Commercial | Primary product interface and workflow configuration |

### 11.3 Decision Timeline

The open source decision is not required for MVP. The architecture should be designed to support open-sourcing the spoke in the future, with clean API boundaries between spoke and hub that allow the spoke to run independently for development and testing purposes.

---

## 12. Post-MVP Deployment Roadmap

| Phase | Timeline | Scope |
|---|---|---|
| Phase 2 | MVP + 3 months | Cloud-managed database support (RDS/Aurora via IAM); PagerDuty and Teams notification integration; Datadog trigger adapter; HashiCorp Vault secret integration |
| Phase 3 | MVP + 6 months | On-premise spoke deployment pattern; Nagios/Zabbix trigger adapters; OpsGenie and email notification; Azure Key Vault and GCP Secret Manager support |
| Phase 4 | MVP + 9 months | Multi-spoke topology with cross-spoke coordination; Hub self-hosted packaging (Helm chart); Spoke auto-update channel; Advanced topology visualization |
| Phase 5 | MVP + 12 months | Hybrid hub deployment option; Air-gapped operation mode; SOC 2 compliance documentation; Enterprise SSO integration for hub |

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| Hub | The centralized control plane hosting Layers 3-4 (coordination, enrichment, management UI) |
| Spoke | The lightweight execution runtime hosting Layers 1-2, deployed close to target systems |
| Bootstrap token | Single-use, time-limited credential used for initial spoke-to-hub authentication |
| Execution context | A scoped permission grant that defines what target system a spoke can access and with what privileges |
| Trigger | An incoming alert from a monitoring system that initiates the recovery workflow |
| Forensic record | The immutable audit trail of every action taken during a recovery operation |
| Discovery | The automated inventory process where a spoke catalogs reachable target systems |
| Agent | A domain-specific recovery module that defines diagnosis and remediation steps for a particular system type |
| Catalog | The registry of available agents and their trigger-matching rules |
| Trust score | A dynamic confidence metric for an agent based on its historical execution outcomes |

---

## Appendix B: Reference Architecture Diagram Keys

The following component relationships define the data flow:

- Alert Source (Prometheus/Datadog/etc.) sends webhook to Spoke webhook receiver
- Spoke normalizes trigger and, if connected, sends to Hub for catalog matching and approval routing
- Hub routes approval request to configured notification channel (Slack/Teams/PagerDuty)
- Approval response flows back through Hub to Spoke
- Spoke fetches credentials from customer secret manager at execution time
- Spoke executes recovery plan against target system
- Spoke streams forensic records to Hub (or queues locally if disconnected)
- Hub updates topology model, trust scores, and analytics from forensic data

When hub connectivity is lost, steps 2-4 and 7-8 are deferred. The spoke operates from cached policies for steps 5-6 and queues forensic records locally for step 7.
