# Service Status — "Is It Down for Everyone, or Just Me?" for Third-Party Dependencies

**Date:** 2026-08-08
**Depends on:** the honesty foundation (maturity/visibility contract), offline triage (`OfflineGate`, verdict machinery), and the guidance registry (finding-type-anchored remediation guides). Reuses llm-provider's Statuspage-v2 parser.

## Problem

The target user's stack leans on third-party services they do not operate — Stripe, GitHub, Vercel, Supabase, Twilio, npm — and when one of them breaks, the user's first question is Downdetector's question: *is it down for everyone, or just me?* Today CrisisMode answers this only for LLM providers (llm-provider's `provider_status` check) and only generically for everything else (triage layer 6 says "the remote side isn't answering" without naming a culprit). Downdetector itself has no free API (Ookla enterprise-only; scraping violates ToS), so the answer must be built from **official status pages plus direct probes** — which is also the more honest source: provider-confirmed incidents rather than crowd noise.

## Goals

1. A shared **service-status checker** that, for a given service, establishes two independent facts — what the provider's official status page reports, and whether the service is reachable from this machine — and combines them into a plain-language verdict.
2. A curated **catalog** of well-known services (vibe-coder-stack weighted) mapping service ids to probe hosts and status endpoints.
3. Three surfaces:
   - **`crisismode down [service...]`** — ad-hoc CLI answer, zero setup.
   - **`crisismode scan` / `watch`** — a standard-pattern `service-status` agent over the services configured in `crisismode.yaml`.
   - **Triage enrichment** — when triage's verdict is `remote` or `mixed`, name which configured services' status pages report incidents.
4. User-provided targets both as catalog ids (`stripe`, `github`) and raw domains (`api.myvendor.com`), the latter with honestly reduced capability (probes only).

## Non-goals

- Downdetector/Ookla integration, scraping, or any crowd-sourced signal.
- AWS service health (the AWS Health feed is a different format and account-scoped story; aws-rds control-plane coverage already exists). Candidate for a later arc.
- Autodiscovery of services from env vars or `package.json` in v1 (inference can mislabel; explicit lists only — revisit once the feature earns trust).
- Status-*subdomain guessing* for unknown domains (`https://status.<domain>` conventions are too inconsistent to probe honestly).
- Historical uptime tracking, notifications/alerting on incident start, or an MCP tool (all v2 candidates; the MCP surface addition is mechanical once the checker exists).
- Any mutation. There is nothing to execute against a third-party outage; the agent is Observe/Diagnose with suggestion-only plans.

## Design

### Shared module

```
src/framework/service-status/
  catalog.ts        # SERVICE_CATALOG — curated known services
  checker.ts        # checkService()/checkServices() — probes + status fetch + verdict
  statuspage.ts     # Statuspage-v2 summary parser (MOVED from llm-provider; llm-provider imports from here)
  types.ts          # ServiceStatusReport, verdict unions (re-exported via src/types if surfaced in public plan types)
```

The Statuspage-v2 parsing currently inside `src/agent/llm-provider/live-client.ts` moves to `service-status/statuspage.ts` as a pure function `parseStatuspageSummary(json): StatusPageAssessment`; llm-provider imports it (series contract: one implementation, no copies). `google_cloud_incidents` parsing stays in llm-provider (no catalog service uses it).

### Catalog (v1 contents)

| id | probe host | status endpoint | format |
|---|---|---|---|
| github | api.github.com:443 | https://www.githubstatus.com/api/v2/summary.json | statuspage_v2 |
| stripe | api.stripe.com:443 | https://www.stripestatus.com/api/v2/summary.json | statuspage_v2 |
| vercel | vercel.com:443 | https://www.vercel-status.com/api/v2/summary.json | statuspage_v2 |
| netlify | api.netlify.com:443 | https://www.netlifystatus.com/api/v2/summary.json | statuspage_v2 |
| supabase | supabase.com:443 | https://status.supabase.com/api/v2/summary.json | statuspage_v2 |
| neon | console.neon.tech:443 | https://neonstatus.com/api/v2/summary.json | statuspage_v2 |
| cloudflare | api.cloudflare.com:443 | https://www.cloudflarestatus.com/api/v2/summary.json | statuspage_v2 |
| npm | registry.npmjs.org:443 | https://status.npmjs.org/api/v2/summary.json | statuspage_v2 |
| twilio | api.twilio.com:443 | https://status.twilio.com/api/v2/summary.json | statuspage_v2 |
| sendgrid | api.sendgrid.com:443 | https://status.sendgrid.com/api/v2/summary.json | statuspage_v2 |
| resend | api.resend.com:443 | https://resend-status.com/api/v2/summary.json | statuspage_v2 |
| render | api.render.com:443 | https://status.render.com/api/v2/summary.json | statuspage_v2 |
| fly | api.fly.io:443 | https://status.flyio.net/api/v2/summary.json | statuspage_v2 |
| planetscale | api.planetscale.com:443 | https://www.planetscalestatus.com/api/v2/summary.json | statuspage_v2 |
| upstash | api.upstash.com:443 | https://status.upstash.com/api/v2/summary.json | statuspage_v2 |

Rules for the table:
- **Every status URL must be verified live during implementation** (fetch it, confirm it parses as Statuspage-v2). Any that don't check out are dropped or corrected in the same task — the table above is the candidate list, not gospel. A unit test fetches nothing; a separate live-marked test validates the catalog against the real endpoints.
- Aliases resolve at lookup (`flyio` → `fly`, `pscale` → `planetscale`); unknown ids fall through to raw-domain handling.
- Anthropic/OpenAI are **not** duplicated here: `down anthropic`/`down openai` resolve through llm-provider's provider table (`statusUrl` fields) so there is exactly one owner per provider's status endpoint.

### Check semantics

Two independent facts per service, never conflated (honesty foundation):

**Fact 1 — provider's own report** (`statusAssessment`):
- `incident_reported` — unresolved incidents present (Statuspage `incidents` non-empty) or overall indicator `major`/`critical`.
- `degraded_reported` — indicator `minor` or any component not `operational`, with no unresolved incident.
- `operational` — indicator `none` and components operational.
- `status_unavailable` — fetch failed/timed out/unparseable. **Explicitly not evidence the service is down.**
- `no_status_source` — raw domain with no catalog entry.

**Fact 2 — reachability from here** (`probeResult`): DNS resolve of the probe host, then TCP+TLS connect (no HTTP request body; connect-level only, mirroring triage's target probe). `reachable` / `dns_failed` / `connect_failed`. All timing via `performance.now()` (series contract).

**Combined verdict** (plain language shown in parentheses):

| statusAssessment | probe | verdict |
|---|---|---|
| incident_reported | any | `confirmed_incident` ("down for everyone — <provider> has confirmed an incident") |
| degraded_reported | reachable | `degraded_upstream` ("degraded on their side") |
| degraded_reported | failed | `confirmed_incident` (degraded + unreachable ≈ their problem) |
| operational | reachable | `healthy` |
| operational | failed | `down_for_you` ("they say all clear, but this machine can't reach them — likely your network, DNS, or config") |
| status_unavailable | reachable | `healthy_unverified` ("reachable; their status page couldn't be checked") |
| status_unavailable | failed | `unreachable_unverified` ("can't reach the service or its status page — can't tell whose problem it is") |
| no_status_source | reachable | `healthy_probe_only` ("reachable; no known status page — reachability only") |
| no_status_source | failed | `unreachable_probe_only` |

**OfflineGate first**: the existing gate from llm-provider/triage runs before any checks; when offline, every service reports a distinct `offline_skipped` state and no provider is blamed. Budgets: status fetch 1500ms, probe 1500ms, run **in parallel per service** and services in parallel (bounded, 5 at a time), so the agent stays inside scan's 2000ms `AGENT_TIMEOUT_MS` for typical lists; `down` (interactive, not scan-budgeted) allows a 3500ms per-service ceiling.

### Config

`crisismode.yaml` gains a top-level `services:` list (schema in `src/config/schema.ts`):

```yaml
services:
  - stripe          # catalog id
  - github
  - api.myvendor.com   # raw domain — probes only
  - host: api.other.com    # long form
    port: 8443
```

String entries: catalog id if it (or an alias) matches, else treated as a domain (validated: no scheme, no path, no spaces). Long form allows a port. Invalid entries fail config validation with a plain-language message listing valid catalog ids.

### `crisismode down` command

`src/cli/commands/down.ts`:
- `crisismode down` — checks the configured `services:` list; if none configured, prints a short pointer to both usages (not an error).
- `crisismode down stripe github api.foo.com` — ad-hoc list, no config needed.
- Output modes per the standard: human (verdict emoji + plain-language line + incident names from the status page when present), pipe (tab-separated: id, verdict, statusAssessment, probeResult, detail), machine (`--json` JSONL with metadata). `--terse` suppresses explanations.
- Exit codes: `0` all healthy/healthy_unverified/healthy_probe_only; `1` any confirmed_incident, degraded_upstream, down_for_you, or unreachable_*; `2` usage errors (unknown flag, invalid domain). Documented in the command help and README (mirrors triage's exit-code contract style).
- When verdict is `down_for_you`, the command suggests `crisismode triage` (localize the problem) — cross-linking the two features.

### Agent (`src/agent/service-status/`)

Standard pattern, Observe/Diagnose only:
- `backend.ts` — `ServiceStatusBackend extends ExecutionBackend` with `queryServices(): Promise<ServiceStatusReport[]>`.
- `simulator.ts` — states: `healthy`, `incident`, `degraded`, `down_for_you`, `status_unavailable`. `evaluateCheck` handles `service_verdict` and `unreachable_service_count`, **fail-closed** on anything else (both backends, from day one).
- `live-client.ts` — thin delegation to `checkServices()` with the configured list.
- `manifest.ts` — kind `service-status`, per-target dotted kinds `service-status.<id>` derived from config (matching the llm-provider kind scheme); `maxRiskLevel: 'routine'`; `failureScenarios`: `dependency_incident`, `dependency_degraded`, `dependency_unreachable`, `no_finding` — **every scenario `plan()` can emit, each with a real `validatePlan` test** (pinned rule).
- `agent.ts` — plans are suggestion-only: diagnosis_action (capture the report) + human_notification ("Stripe has a confirmed incident affecting Payments API — this is not your bug"). Guidance is not a step type — the remediation guide attaches via the finding-type anchoring the guidance registry already enforces. No system_action steps at all, so no new capabilities to register (verify via the validatePlan tests rather than assuming).
- `registration.ts` + `src/config/builtin-agents.ts`; targets derived **only** from the `services:` config list (no env inference).
- Scan visibility: configured services appear in "What CrisisMode can see" as watched; raw domains annotated "reachability only."

### Triage enrichment

In `src/cli/commands/triage.ts` (composition at the command layer, keeping `src/framework/triage.ts` pure): when the verdict is `remote` or `mixed` **and** `services:` are configured, run status-page fetches only (skip probes — triage already probed) with a 1500ms shared deadline, and append one line per service with a non-operational report: `GitHub's status page reports an incident: Git Operations degraded`. No configured services or all-operational → no extra output. Never changes the verdict or exit code — enrichment is annotation, not evidence re-weighing (v2 may promote it into verdict synthesis once field-tested).

### Guides

One new remediation guide (platform-scoped appropriately, anchored to the agent's finding types per the guidance registry's enforcement tests): "A service you depend on is having an incident" — subscribe to the provider's status page, check your app's error handling for the failing dependency, don't ship debugging changes against an upstream outage, know the provider's incident-history URL. `verifiedOn` per the CONTRIBUTING rule (no console login needed — status pages are public, so this one is walkable by anyone including CI-adjacent tooling, but it still follows the same walkthrough flow).

### Honesty rules (binding)

1. A status-page fetch failure is never presented as a service outage (`status_unavailable` ≠ down).
2. Raw domains are always labeled "reachability only" wherever they surface.
3. Offline (per OfflineGate) skips all checks with an explicit skipped state — no provider blame while the user's own network is down.
4. The maturity label is `live_validated` only if the catalog-validation live test actually ran against real endpoints during development; catalog entries that could not be live-verified are removed rather than shipped unverified.
5. `down_for_you` wording must point at the user's side without asserting certainty ("likely your network, DNS, or config").

### Testing

- Unit: verdict-combination table (every row above), catalog alias resolution, config validation, parser against recorded Statuspage fixtures (operational / minor / major / unresolved-incident payloads), exit codes, pipe/JSON output shape, evaluateCheck fail-closed, per-scenario real `validatePlan`.
- Live (network-marked, excluded from the default suite the same way existing live checks are handled): catalog validation against real endpoints; one real `down github` run.
- Simulator drives demo coverage; no podman needed.

## Maturity claim

`service-status` ships `live_validated` for catalog services (public endpoints, verified during implementation) and the checker's raw-domain path is probe-only by construction. This is the rare agent where live validation costs nothing — no credentials exist to be missing.

## Rollout

Single PR (`feat/service-status`), standard pipeline: subagent-driven tasks, adversarial reviews, fable final review, CodeRabbit wave. Docs: README (`down` command + services config), CLAUDE.md rows (module, agent, command), config reference. Follow-ups ledgered, not built: AWS health, autodiscovery inference, MCP tool, incident notifications, triage-verdict promotion.
