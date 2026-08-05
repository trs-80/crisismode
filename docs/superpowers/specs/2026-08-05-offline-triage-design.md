# PR 2 — Offline Triage: "Is it me, my network, or them?"

**Date:** 2026-08-05
**Series:** Reliability-first (PR 2 of 5). Depends on PR 1 (honesty foundation) only for merged scan-output snapshots; functionally independent.

## Problem

When a vibe coder's stack is unreachable, the first question is not "what is wrong with my services" but "is this my machine, my network, or the remote side?" CrisisMode currently emits one unreachable-service finding per target, which reads as "six services are down" when the real cause is the operator's wifi, VPN, or a captive portal. This is also the one diagnosis that must work with **no internet and no LLM** — localization is tractable deterministically; remote diagnosis offline is not.

## Goals

1. A deterministic, dependency-free localization pass with a plain-language verdict: `local | network | remote | mixed | healthy`.
2. A standalone `crisismode triage` command (human/pipe/json).
3. Scan runs a fast triage subset as step 0 and **reframes** unreachable-service findings when the verdict is local/network.
4. Correct behavior on both a laptop and a cloud VM.

## Non-goals

- Diagnosing remote/cloud systems while offline (impossible by definition — triage tells the user it's "them", not what's wrong with them).
- New dependencies. Node built-ins only (`node:dns`, `node:net`, `node:os`, global `fetch`), respecting the 256Mi spoke target.
- Replacing per-target health checks — triage localizes; agents diagnose.

## Design

### Module: `src/framework/triage.ts`

Builds on the existing `network-profile.ts` (`probeNetwork`, `isInternetAvailable`, `isHubReachable`). Layered checks, each with a hard timeout (default 1500ms per probe, whole triage bounded ≤ ~5s):

1. **Interfaces** — `os.networkInterfaces()`: any non-loopback interface with an address? No → `local`.
2. **Gateway** — discover the default gateway (parse `ip route`/`route -n get default` per platform; both invocations read-only). Unresolvable gateway discovery → record `unknown`, continue (honesty over guessing). TCP/ICMP-less probe: attempt a TCP connect to the gateway on common ports is unreliable; instead treat gateway reachability as inferred from later layers and report gateway address as context only.
3. **DNS, two-step** — resolve a known name via the system resolver (`dns.promises.resolve`), then via a direct public resolver (`dns.promises.Resolver` with servers `1.1.1.1`, `8.8.8.8`). System fails + direct succeeds → "your DNS resolver is broken" (local). Both fail → network.
4. **Captive portal** — fetch a known HTTP 204 endpoint (`http://connectivitycheck.gstatic.com/generate_204`, fallback `http://captive.apple.com`). A redirect or a 200 with a body → captive portal (network, with a specific hint: "open a browser and complete the network sign-in page").
5. **Internet** — HTTPS HEAD to two well-known hosts. Both fail with DNS OK → network.
6. **Per-target reachability** — TCP connect to each discovered/configured target (host:port from autodiscovery + crisismode.yaml). Only runs in the standalone command and full scan (not the fast subset), since scan's agents already probe targets.

**Verdict synthesis** (pure function over layer results):
- `local` — interface/resolver-level failure on this machine.
- `network` — machine fine, gateway/portal/internet layer failing.
- `remote` — local + network layers healthy, specific targets unreachable.
- `mixed` — layered results conflict (e.g., some targets reachable, DNS flaky); reported honestly with per-layer detail.
- `healthy` — all layers pass.

Every verdict carries a plain-language explanation and next step, per the Arc 1 static-first language conventions.

### Observer context

Detect laptop vs. cloud VM cheaply and without network calls: presence of cloud vendor DMI markers (`/sys/class/dmi/id/product_name`, `sys_vendor` on Linux) or well-known env markers; darwin → laptop/workstation assumption. On a VM, the captive-portal check is skipped and reported as "not applicable (server environment)". Detection is best-effort and says so.

### CLI: `crisismode triage`

- New command in `src/cli/commands/triage.ts`, registered in `src/cli/index.ts`, completions, README, CLAUDE.md command table.
- Output modes follow existing conventions: human (colored, per-layer lines with severity glyphs, verdict banner), pipe (tab-separated layer results), machine (`--json` structured verdict + layers).
- Exit code 0 on `healthy`/`remote` (machine is fine), 1 on `local`/`network`/`mixed` — documented, so scripts can branch.

### Scan integration (step 0)

- Scan runs layers 1–5 with short timeouts (800ms per probe) before agent checks.
- If verdict is `local` or `network`: unreachable-service findings are **grouped and reframed** — the plain-language summary leads with "N services appear unreachable, but the likely cause is this machine's network (<specific layer>). Fix that first." Individual findings remain in machine output with a `possiblyObserverCaused: true` field; human output collapses them under the reframe.
- If verdict is `healthy`/`remote`, scan output is unchanged (one added line in the visibility/context section noting triage passed).
- The existing `observer-environment` correlation rule becomes redundant for this path; it is kept (freeze policy is about additions) but scan's deterministic reframe takes precedence in presentation.

## Error handling

- Every probe failure is a data point, never a thrown error; a probe that errors unexpectedly records `unknown` for its layer.
- Total time is bounded; a slow network cannot hang scan (Promise.race with per-probe timeout).
- No probe writes anything anywhere; all checks are read-only (Observe escalation level).

## Testing

- Probes are behind an injectable `TriageProbes` interface (simulator pattern): unit tests cover every verdict, mixed/unknown layers, VM-context skip, and timeout behavior with fake timers.
- Verdict synthesis is a pure function — table-driven tests.
- Live validation (verify skill): run `crisismode triage` on the real machine (healthy path) and with networking disabled (local/network path) before claiming done.

## Acceptance criteria

- `crisismode triage` completes in ≤ 5s offline, no API key, no internet, and prints a correct `local`/`network` verdict when the machine's network is down.
- `crisismode scan` with an unreachable stack and broken local DNS leads with the observer reframe, not six service-down findings.
- Zero new package.json dependencies.
