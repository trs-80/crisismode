// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Offline triage — "is it me, my network, or them?"
 *
 * When a stack is unreachable, the first question is not "what is wrong with
 * my services" but "is this my machine, my network, or the remote side?"
 * Triage answers that deterministically, with no internet and no LLM.
 *
 * Layers, each with a hard per-probe timeout:
 *   1. interfaces     — any non-loopback interface with an address?
 *   2. gateway        — default gateway address, context only (never probed,
 *                       never contributes to the verdict)
 *   3. dns            — system resolver, then public resolvers directly
 *   4. captive-portal — connectivity-check endpoints, per-endpoint expected
 *                       response (skipped in server environments)
 *   5. internet       — HTTPS HEAD to two well-known hosts
 *   6. targets        — TCP connect to discovered/configured targets
 *
 * Escalation level is Diagnose (2): triage makes read-only queries against
 * live third-party endpoints, which is more than Observe's no-interaction
 * contract. It never mutates anything.
 */

import type { ConnectivityStatus, NetworkLayer, NetworkProfile, ProbeResult } from '@crisismode/agent-sdk';
import type { EscalationLevel } from './escalation.js';
import { detectObserverContext, nodeTriageProbes, runBounded } from './triage-probes.js';
import type { BoundedOutcome } from './triage-probes.js';
import { inferNetworkMode, resetNetworkProfile, setNetworkProfile } from './network-profile.js';

// ── Verdict and layer model ──

export type TriageVerdict = 'local' | 'network' | 'remote' | 'mixed' | 'healthy';

export type TriageLayerName =
  | 'interfaces'
  | 'gateway'
  | 'dns'
  | 'captive-portal'
  | 'internet'
  | 'targets';

export type TriageLayerStatus = 'pass' | 'fail' | 'skipped' | 'unknown';

/** Machine-stable reason code. Verdict synthesis reads only these, never prose. */
export type TriageLayerCode =
  | 'no-active-interface'
  | 'gateway-unknown'
  | 'resolver-broken'
  | 'dns-unreachable'
  | 'captive-portal'
  | 'internet-unreachable'
  | 'targets-unreachable'
  | 'targets-partial';

export interface TriageLayerResult {
  layer: TriageLayerName;
  status: TriageLayerStatus;
  /** One-line, operator-facing statement of what was observed. */
  detail: string;
  code?: TriageLayerCode | undefined;
  /** Plain-language next step. Present on failing layers. */
  nextStep?: string | undefined;
  /** Per-endpoint results, for layers that probe endpoints. */
  probes?: ProbeResult[] | undefined;
  durationMs: number;
}

// ── Observer context ──

export type ObserverContext = 'laptop' | 'server' | 'unknown';

export interface ObserverContextResult {
  context: ObserverContext;
  /** What the classification was based on. Best-effort, and says so. */
  evidence: string;
}

// ── Probe contracts (injectable for tests) ──

export interface TriageTarget {
  host: string;
  port: number;
  label: string;
}

export interface InterfaceProbeResult {
  /** Names of non-loopback interfaces that have an assigned address. */
  activeInterfaces: string[];
}

export interface GatewayProbeResult {
  /** Default gateway address, or null when it could not be determined. */
  address: string | null;
}

export interface DnsProbeResult {
  systemResolved: boolean;
  publicResolved: boolean;
  systemError?: string | undefined;
  publicError?: string | undefined;
}

export interface HttpProbeResult {
  /** HTTP status code, or null when the request never completed. */
  status: number | null;
  /** Response body, truncated to the first 256 characters. Empty for HEAD. */
  body: string;
  /** True when the response was a 3xx redirect. */
  redirected: boolean;
  latencyMs: number;
  error?: string | undefined;
}

export interface TriageProbes {
  listInterfaces(): Promise<InterfaceProbeResult>;
  findDefaultGateway(): Promise<GatewayProbeResult>;
  resolveDns(hostname: string): Promise<DnsProbeResult>;
  fetchUrl(url: string, method: 'GET' | 'HEAD'): Promise<HttpProbeResult>;
  connectTcp(host: string, port: number, label: string): Promise<ProbeResult>;
}

// ── Report ──

export interface TriageReport {
  verdict: TriageVerdict;
  /** Plain-language explanation of the verdict. */
  explanation: string;
  /** The single next step the operator should take. */
  nextStep: string;
  layers: TriageLayerResult[];
  observerContext: ObserverContext;
  observerContextEvidence: string;
  escalationLevel: EscalationLevel;
  checkedAt: string;
  durationMs: number;
}

// ── Constants ──

/** Same host network-profile.ts probes, so the two agree about DNS. */
export const DNS_TEST_HOST = 'api.anthropic.com';

export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'] as const;

export interface CaptiveEndpoint {
  url: string;
  expectedStatus: number;
  /** Substring the body must contain. An empty string means the body must be empty. */
  expectedBody: string;
}

/**
 * Per-endpoint expected responses. A bare "200 with a body" rule would
 * misclassify captive.apple.com, whose healthy response IS a 200 with a body.
 */
export const CAPTIVE_ENDPOINTS: readonly CaptiveEndpoint[] = [
  { url: 'http://connectivitycheck.gstatic.com/generate_204', expectedStatus: 204, expectedBody: '' },
  { url: 'http://captive.apple.com', expectedStatus: 200, expectedBody: 'Success' },
];

export const INTERNET_PROBE_URLS = ['https://api.anthropic.com', 'https://api.github.com'] as const;

/**
 * Per-probe hard timeout. Four probe stages (interfaces, gateway+DNS,
 * portal+internet, targets) run back to back, so this must stay at or below
 * TRIAGE_DEADLINE_MS / 4 for the deadline to be reachable without truncation.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

/** Scan's step 0 runs tighter than the standalone command. */
export const SCAN_PROBE_TIMEOUT_MS = 800;

/**
 * Whole-run budget, measured from the first probe. Per-probe timeouts do not
 * compose into a total bound on their own, and the spec makes "≤ 5s offline"
 * an acceptance criterion — so the bound is explicit and tested.
 */
export const TRIAGE_DEADLINE_MS = 5_000;

/** Read-only queries against live systems. */
export const TRIAGE_ESCALATION_LEVEL: EscalationLevel = 2;

// ── Verdict synthesis (pure) ──

/**
 * Collapse layer results into one verdict.
 *
 * Precedence, highest first:
 *   1. no active interface            -> local
 *   2. system resolver broken         -> local
 *   3. dns/portal/internet failure    -> mixed when a target still answered,
 *                                        network otherwise
 *   4. some targets answered          -> mixed
 *   5. no target answered             -> remote
 *   6. any non-gateway layer unknown  -> mixed (we cannot claim healthy for a
 *                                        layer we could not assess)
 *   7. otherwise                      -> healthy
 *
 * The gateway layer is context only: it is reported but never changes the
 * verdict, because a gateway that does not answer an unprivileged probe is
 * not evidence of anything.
 */
export function synthesizeVerdict(layers: TriageLayerResult[]): TriageVerdict {
  const failed = new Set<TriageLayerCode>();
  for (const l of layers) {
    if (l.status === 'fail' && l.code !== undefined) failed.add(l.code);
  }

  if (failed.has('no-active-interface') || failed.has('resolver-broken')) return 'local';

  const targetsLayer = layers.find((l) => l.layer === 'targets');
  const someTargetAnswered =
    targetsLayer?.status === 'pass' || targetsLayer?.code === 'targets-partial';

  const networkFailed =
    failed.has('dns-unreachable') || failed.has('captive-portal') || failed.has('internet-unreachable');
  if (networkFailed) return someTargetAnswered ? 'mixed' : 'network';

  if (failed.has('targets-partial')) return 'mixed';
  if (failed.has('targets-unreachable')) return 'remote';

  if (layers.some((l) => l.layer !== 'gateway' && l.status === 'unknown')) return 'mixed';
  return 'healthy';
}

// ── Verdict explanation (pure) ──

export interface TriageExplanation {
  explanation: string;
  nextStep: string;
}

const LAYER_CAUSE_LABEL: Record<TriageLayerCode, string> = {
  'no-active-interface': 'no active network interface on this machine',
  'gateway-unknown': 'the default gateway could not be determined',
  'resolver-broken': 'this machine\'s DNS resolver is not answering',
  'dns-unreachable': 'DNS is not resolving from this machine',
  'captive-portal': 'a captive portal (network sign-in page) is intercepting traffic',
  'internet-unreachable': 'this machine has no internet egress',
  'targets-unreachable': 'your services did not accept a connection',
  'targets-partial': 'some services answered and others did not',
};

/** Plain-language cause for a layer code. */
export function layerCauseLabel(code: TriageLayerCode): string {
  return LAYER_CAUSE_LABEL[code];
}

/**
 * The first failing layer's code in probe order — the cause we lead with.
 * The gateway layer is skipped: it is context, not evidence.
 */
export function primaryFailureCode(layers: TriageLayerResult[]): TriageLayerCode | null {
  for (const l of layers) {
    if (l.layer === 'gateway') continue;
    if (l.status === 'fail' && l.code !== undefined) return l.code;
  }
  return null;
}

export function explainVerdict(verdict: TriageVerdict, layers: TriageLayerResult[]): TriageExplanation {
  const code = primaryFailureCode(layers);
  const cause = code === null ? 'the failing layer could not be identified' : layerCauseLabel(code);
  const layerNextStep = code === null
    ? undefined
    : layers.find((l) => l.code === code)?.nextStep;

  switch (verdict) {
    case 'local':
      return {
        explanation: `Something on this machine is broken: ${cause}. Your services may be perfectly healthy.`,
        nextStep: layerNextStep
          ?? 'Check this machine\'s network settings (Wi-Fi, VPN, DNS configuration) before looking at your services.',
      };
    case 'network':
      return {
        explanation: `This machine looks fine, but the network it is on does not: ${cause}. Your services may be perfectly healthy.`,
        nextStep: layerNextStep
          ?? 'Fix the network path (router, Wi-Fi sign-in, VPN) before looking at your services.',
      };
    case 'remote':
      return {
        explanation: 'This machine and its network are fine — the services themselves did not answer.',
        nextStep: 'Run `crisismode scan` to diagnose the services.',
      };
    case 'mixed':
      return {
        explanation: 'Results conflict, so triage cannot say where the problem is. Read the per-layer lines below and treat failing layers as leads, not conclusions.',
        nextStep: 'Re-run `crisismode triage` in a few seconds; if the layers still disagree, investigate the failing layers individually.',
      };
    case 'healthy':
      return {
        explanation: 'This machine, its network, and everything triage could reach look fine.',
        nextStep: 'Nothing to fix here — if a service is failing, run `crisismode scan` to check the services themselves.',
      };
  }
}

// ── Layer builders (pure) ──

/** A layer we deliberately did not run. Never contributes to the verdict. */
export function skippedLayer(layer: TriageLayerName, detail: string, durationMs: number): TriageLayerResult {
  return { layer, status: 'skipped', detail, durationMs };
}

export function buildInterfaceLayer(result: InterfaceProbeResult, durationMs: number): TriageLayerResult {
  if (result.activeInterfaces.length === 0) {
    return {
      layer: 'interfaces',
      status: 'fail',
      code: 'no-active-interface',
      detail: 'No non-loopback interface has an address — this machine is not on any network.',
      nextStep: 'Turn on Wi-Fi or plug in the network cable, then re-run `crisismode triage`.',
      durationMs,
    };
  }
  return {
    layer: 'interfaces',
    status: 'pass',
    detail: `Active interfaces: ${result.activeInterfaces.join(', ')}`,
    durationMs,
  };
}

export function buildGatewayLayer(result: GatewayProbeResult, durationMs: number): TriageLayerResult {
  if (result.address === null) {
    return {
      layer: 'gateway',
      status: 'unknown',
      code: 'gateway-unknown',
      detail: 'Could not read the default gateway from the route table (context only — this does not change the verdict).',
      durationMs,
    };
  }
  return {
    layer: 'gateway',
    status: 'pass',
    detail: `Default gateway: ${result.address} (context only — not probed)`,
    durationMs,
  };
}

export function buildDnsLayer(result: DnsProbeResult, durationMs: number): TriageLayerResult {
  const resolvers = PUBLIC_RESOLVERS.join(', ');
  if (result.systemResolved) {
    return {
      layer: 'dns',
      status: 'pass',
      detail: `The system resolver answered for ${DNS_TEST_HOST}.`,
      durationMs,
    };
  }
  if (result.publicResolved) {
    const why = result.systemError === undefined ? '' : ` Resolver error: ${result.systemError}`;
    return {
      layer: 'dns',
      status: 'fail',
      code: 'resolver-broken',
      detail: `The system resolver failed for ${DNS_TEST_HOST}, but public resolvers (${resolvers}) answered — this machine's DNS configuration is broken.${why}`,
      nextStep: "Fix this machine's DNS settings (VPN split-DNS, /etc/resolv.conf, or a corporate resolver) — the network itself is reachable.",
      durationMs,
    };
  }
  return {
    layer: 'dns',
    status: 'fail',
    code: 'dns-unreachable',
    detail: `Neither the system resolver nor public resolvers (${resolvers}) answered for ${DNS_TEST_HOST}.`,
    nextStep: 'Check the network you are on (Wi-Fi sign-in, VPN, router) — DNS traffic is not getting out.',
    durationMs,
  };
}

export interface CaptiveProbe {
  endpoint: CaptiveEndpoint;
  probe: HttpProbeResult;
}

export interface InternetProbe {
  url: string;
  probe: HttpProbeResult;
}

/**
 * Does this response match what this specific endpoint promises when the
 * network is clean? Redirects never match: a redirect is the signature of a
 * portal intercepting the request.
 */
export function matchesCaptiveExpectation(endpoint: CaptiveEndpoint, result: HttpProbeResult): boolean {
  if (result.error !== undefined || result.status === null) return false;
  if (result.redirected) return false;
  if (result.status !== endpoint.expectedStatus) return false;
  return endpoint.expectedBody === ''
    ? result.body.trim() === ''
    : result.body.includes(endpoint.expectedBody);
}

export function buildCaptiveLayer(results: CaptiveProbe[], durationMs: number): TriageLayerResult {
  const responded = results.filter((r) => r.probe.status !== null && r.probe.error === undefined);
  if (responded.length === 0) {
    return {
      layer: 'captive-portal',
      status: 'unknown',
      detail: 'No connectivity-check endpoint responded — a captive portal cannot be distinguished from a blocked path here.',
      durationMs,
    };
  }

  // Every endpoint that answered must match its own expectation. A gstatic
  // 204 does not clear the layer by itself: a portal can intercept one
  // connectivity-check host and let another through, and any redirect or
  // mismatching body among the responses is the signature we are looking for.
  const mismatch = responded.find((r) => !matchesCaptiveExpectation(r.endpoint, r.probe));
  if (mismatch !== undefined) {
    const shape = mismatch.probe.redirected ? ' (a redirect)' : '';
    return {
      layer: 'captive-portal',
      status: 'fail',
      code: 'captive-portal',
      detail: `${mismatch.endpoint.url} returned HTTP ${mismatch.probe.status}${shape} instead of the expected ${mismatch.endpoint.expectedStatus} — something is intercepting traffic.`,
      nextStep: 'Open a browser and complete the network sign-in page, then re-run `crisismode triage`.',
      durationMs,
    };
  }

  return {
    layer: 'captive-portal',
    status: 'pass',
    detail: `${responded.map((r) => r.endpoint.url).join(' and ')} returned their expected response — no portal is intercepting traffic.`,
    durationMs,
  };
}

export function buildInternetLayer(results: InternetProbe[], durationMs: number): TriageLayerResult {
  const probes: ProbeResult[] = results.map(({ url, probe }) => ({
    target: url,
    reachable: probe.error === undefined && probe.status !== null,
    latencyMs: probe.latencyMs,
    ...(probe.error !== undefined ? { error: probe.error } : {}),
  }));

  const reachable = probes.filter((p) => p.reachable);
  if (reachable.length === 0) {
    return {
      layer: 'internet',
      status: 'fail',
      code: 'internet-unreachable',
      detail: `No response from ${probes.map((p) => p.target).join(' or ')}.`,
      nextStep: 'This machine cannot reach the internet — check Wi-Fi, VPN, or the network you are on.',
      probes,
      durationMs,
    };
  }
  return {
    layer: 'internet',
    status: 'pass',
    detail: `${reachable.length} of ${probes.length} internet endpoint(s) answered.`,
    probes,
    durationMs,
  };
}

/**
 * `omitted` counts targets that were dropped by Stage 4's probe cap before
 * they were ever probed — reported here so the operator can see that the
 * layer's verdict is over a truncated list, not the whole configuration.
 */
export function buildTargetsLayer(probes: ProbeResult[], durationMs: number, omitted = 0): TriageLayerResult {
  const omittedNote = omitted > 0
    ? ` (${omitted} additional target(s) were not probed — over the per-run cap.)`
    : '';

  if (probes.length === 0) {
    return skippedLayer('targets', `No targets to probe.${omittedNote}`, durationMs);
  }

  const unreachable = probes.filter((p) => !p.reachable);
  if (unreachable.length === 0) {
    return {
      layer: 'targets',
      status: 'pass',
      detail: `All ${probes.length} target(s) accepted a TCP connection.${omittedNote}`,
      probes,
      durationMs,
    };
  }

  const names = unreachable.map((p) => p.target).join(', ');
  if (unreachable.length === probes.length) {
    return {
      layer: 'targets',
      status: 'fail',
      code: 'targets-unreachable',
      detail: `None of ${probes.length} target(s) accepted a TCP connection: ${names}.${omittedNote}`,
      nextStep: 'This machine and its network look fine — run `crisismode scan` to diagnose the services themselves.',
      probes,
      durationMs,
    };
  }

  return {
    layer: 'targets',
    status: 'fail',
    code: 'targets-partial',
    detail: `${probes.length - unreachable.length} of ${probes.length} target(s) answered; these did not: ${names}.${omittedNote}`,
    nextStep: 'Some services answered and others did not — run `crisismode scan` and treat the silent ones as the leads.',
    probes,
    durationMs,
  };
}

// ── Orchestration ──

export interface TriageOptions {
  /** Injectable probe set. Defaults to the real Node probes. */
  probes?: TriageProbes | undefined;
  /** Hard per-probe timeout. Defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
  /** Whole-run budget. Defaults to TRIAGE_DEADLINE_MS. */
  deadlineMs?: number | undefined;
  /** Targets for layer 6. Absent or empty skips the layer. */
  targets?: TriageTarget[] | undefined;
  /** Override observer detection (tests). */
  observerContext?: ObserverContextResult | undefined;
  /**
   * Publish the results to the process-lifetime caches — the triage report
   * (read by agents via getTriageReport) and the NetworkProfile singleton.
   * Default true; set false for a side-effect-free run.
   */
  cacheResults?: boolean | undefined;
}

/** Report order, which is the spec's layer numbering — not execution order. */
const LAYER_ORDER: readonly TriageLayerName[] = [
  'interfaces', 'gateway', 'dns', 'captive-portal', 'internet', 'targets',
];

/**
 * Hard cap on Stage 4 targets. `resolveTriageTargets` (Task 9) applies the
 * same cap before targets ever reach `runTriage`, but the bound is enforced
 * here too so a caller that builds `options.targets` directly cannot make
 * Stage 4 open one socket and one timer per target for an unbounded list.
 */
const MAX_STAGE4_TARGETS = 20;

/**
 * Sockets probed at once in Stage 4. A large target list must not open
 * hundreds of connections simultaneously and exhaust file descriptors before
 * the whole-run deadline even has a chance to bite.
 */
const TARGET_PROBE_CONCURRENCY = 5;

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result. This is the one place in the triage path that
 * needs a concurrency limiter, so it is a few lines here rather than a
 * dependency.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run every layer and synthesize a verdict.
 *
 * Layer 1 runs first and short-circuits the rest: with no network interface,
 * every later probe would fail for the same reason and only add latency.
 * Everything after it runs in three concurrent stages, and the whole run is
 * capped by a monotonic deadline so a pathological network cannot stretch the
 * report past the ≤5s the spec promises.
 */
export async function runTriage(options: TriageOptions = {}): Promise<TriageReport> {
  // performance.now() (monotonic) drives every elapsed-time and budget
  // calculation below. Date.now() (wall clock) is kept only for the
  // `checkedAt` timestamp, which is meant to be a real calendar time — an
  // NTP correction or a manual clock change mid-run must never be able to
  // stretch the budget, cut it short, or produce a negative duration.
  const wallClockStartedAt = Date.now();
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = startedAt + (options.deadlineMs ?? TRIAGE_DEADLINE_MS);
  const probes = options.probes ?? nodeTriageProbes(timeoutMs, PUBLIC_RESOLVERS);
  const observer = options.observerContext ?? detectObserverContext();
  const targets = options.targets ?? [];
  const layers: TriageLayerResult[] = [];

  /** Budget for the next probe: whichever of the two bounds bites first. */
  const budget = (): number => Math.min(timeoutMs, Math.max(0, deadline - performance.now()));

  // Layer 1 — interfaces
  const interfaceOutcome = await runBounded(() => probes.listInterfaces(), budget());
  const interfaceLayer = interfaceOutcome.ok
    ? buildInterfaceLayer(interfaceOutcome.value, interfaceOutcome.durationMs)
    : unknownLayer('interfaces', interfaceOutcome.error, interfaceOutcome.durationMs);
  layers.push(interfaceLayer);

  if (interfaceLayer.status === 'fail') {
    const remaining: TriageLayerName[] = ['gateway', 'dns', 'captive-portal', 'internet', 'targets'];
    for (const name of remaining) {
      layers.push(skippedLayer(name, 'Skipped — this machine has no active network interface.', 0));
    }
    return finish(layers, observer, wallClockStartedAt, startedAt, options);
  }

  // Stage 2 — gateway (context) and DNS, concurrently
  if (budget() === 0) return finishExpired(layers, observer, wallClockStartedAt, startedAt, options);
  const stage2Budget = budget();
  const [gatewayOutcome, dnsOutcome] = await Promise.all([
    runBounded(() => probes.findDefaultGateway(), stage2Budget),
    runBounded(() => probes.resolveDns(DNS_TEST_HOST), stage2Budget),
  ]);
  layers.push(gatewayOutcome.ok
    ? buildGatewayLayer(gatewayOutcome.value, gatewayOutcome.durationMs)
    : unknownLayer('gateway', gatewayOutcome.error, gatewayOutcome.durationMs));
  layers.push(dnsOutcome.ok
    ? buildDnsLayer(dnsOutcome.value, dnsOutcome.durationMs)
    : unknownLayer('dns', dnsOutcome.error, dnsOutcome.durationMs));

  // Stage 3 — captive portal and internet. Independent HTTP probes, so they
  // run concurrently; serializing them is what pushed the worst case past 5s.
  if (budget() === 0) return finishExpired(layers, observer, wallClockStartedAt, startedAt, options);
  const stage3Budget = budget();
  const stage3Start = performance.now();
  const captiveWork: Promise<TriageLayerResult> = observer.context === 'server'
    ? Promise.resolve(skippedLayer('captive-portal', 'Not applicable (server environment).', 0))
    : Promise.all(
        CAPTIVE_ENDPOINTS.map(async (endpoint) => ({
          endpoint,
          probe: asHttpProbe(await runBounded(() => probes.fetchUrl(endpoint.url, 'GET'), stage3Budget)),
        })),
      ).then((captiveProbes: CaptiveProbe[]) => buildCaptiveLayer(captiveProbes, performance.now() - stage3Start));

  const internetWork: Promise<TriageLayerResult> = Promise.all(
    INTERNET_PROBE_URLS.map(async (url) => ({
      url,
      probe: asHttpProbe(await runBounded(() => probes.fetchUrl(url, 'HEAD'), stage3Budget)),
    })),
  ).then((internetProbes: InternetProbe[]) => buildInternetLayer(internetProbes, performance.now() - stage3Start));

  const [captiveLayer, internetLayer] = await Promise.all([captiveWork, internetWork]);
  layers.push(captiveLayer);
  layers.push(internetLayer);

  // Stage 4 — per-target reachability. Capped and concurrency-limited: a
  // large config or autodiscovery result must not open one socket and one
  // timer per target all at once — that can exhaust file descriptors or
  // memory well before the whole-run deadline. Each probe races against the
  // *live* remaining budget (`budget()`, re-read per probe) rather than a
  // value captured once — a concurrency-limited executor runs targets in
  // sequential batches, and a fixed per-batch timeout would let enough
  // batches add up past the deadline the same way unbounded per-probe
  // timeouts did before this whole-run bound existed.
  if (budget() === 0) return finishExpired(layers, observer, wallClockStartedAt, startedAt, options);
  const targetsStart = performance.now();
  const boundedTargets = targets.slice(0, MAX_STAGE4_TARGETS);
  const omittedTargets = targets.length - boundedTargets.length;
  const targetProbes: ProbeResult[] = await mapWithConcurrency(
    boundedTargets,
    TARGET_PROBE_CONCURRENCY,
    async (t) => {
      const outcome = await runBounded(() => probes.connectTcp(t.host, t.port, t.label), budget());
      return outcome.ok
        ? outcome.value
        : { target: t.label, reachable: false, latencyMs: outcome.durationMs, error: outcome.error };
    },
  );
  layers.push(buildTargetsLayer(targetProbes, performance.now() - targetsStart, omittedTargets));

  return finish(layers, observer, wallClockStartedAt, startedAt, options);
}

/**
 * Finish a run that hit its deadline. Layers we never got to are `unknown`,
 * not `skipped`: we did intend to check them, so the honest report is "could
 * not assess" (which synthesis turns into `mixed`) rather than a silence that
 * would let the verdict come out `healthy`.
 */
function finishExpired(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  wallClockStartedAt: number,
  startedAt: number,
  options: TriageOptions,
): TriageReport {
  for (const name of LAYER_ORDER) {
    if (layers.some((l) => l.layer === name)) continue;
    layers.push({
      layer: name,
      status: 'unknown',
      detail: 'Not checked — triage ran out of its whole-run budget.',
      durationMs: 0,
    });
  }
  return finish(layers, observer, wallClockStartedAt, startedAt, options);
}

function buildReport(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  wallClockStartedAt: number,
  startedAt: number,
): TriageReport {
  const verdict = synthesizeVerdict(layers);
  const { explanation, nextStep } = explainVerdict(verdict, layers);
  return {
    verdict,
    explanation,
    nextStep,
    layers,
    observerContext: observer.context,
    observerContextEvidence: observer.evidence,
    escalationLevel: TRIAGE_ESCALATION_LEVEL,
    checkedAt: new Date(wallClockStartedAt).toISOString(),
    // performance.now() arithmetic is a float; human/pipe output prints this
    // verbatim, so round it or an operator sees "2034.5830000001ms".
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function unknownLayer(layer: TriageLayerName, error: string, durationMs: number): TriageLayerResult {
  return { layer, status: 'unknown', detail: `Probe did not complete: ${error}`, durationMs };
}

function finish(
  layers: TriageLayerResult[],
  observer: ObserverContextResult,
  wallClockStartedAt: number,
  startedAt: number,
  options: TriageOptions,
): TriageReport {
  const report = buildReport(layers, observer, wallClockStartedAt, startedAt);
  if (options.cacheResults !== false) {
    cachedReport = report;
    // Publish a NetworkProfile only from a DNS layer we actually measured —
    // see the "only measured layers" note above. `unknown` is not the only
    // unmeasured state: the deadline can truncate a run before DNS ever
    // runs (`skipped`, via the interfaces short-circuit or finishExpired's
    // fill-in), and that is just as unmeasured as `unknown`. Require the
    // status to have actually resolved to pass or fail before publishing.
    const dnsStatus = report.layers.find((l) => l.layer === 'dns')?.status;
    const dnsMeasured = dnsStatus === 'pass' || dnsStatus === 'fail';
    if (dnsMeasured) {
      setNetworkProfile(toNetworkProfile(report));
    } else {
      // A profile published by an earlier, fully-measured run must not
      // silently outlive a run that could not measure DNS this time —
      // otherwise a caller reads a stale connectivity picture instead of
      // the honest "no profile yet" that a first run would have given them.
      resetNetworkProfile();
    }
  }
  return report;
}

// ── Cached report ──

let cachedReport: TriageReport | null = null;

/**
 * The last triage report from this process, or null if triage has not run.
 *
 * Cross-PR contract: agents call this from `assessHealth()` to skip network
 * checks when triage already localized the problem to this machine or its
 * network. `null` means "triage never ran here" — no information, not
 * "offline". Non-blocking read; never triggers a probe.
 */
export function getTriageReport(): TriageReport | null {
  return cachedReport;
}

/** Clear the cached report. Used by tests. */
export function resetTriageReport(): void {
  cachedReport = null;
}

// ── NetworkProfile bridge ──

/**
 * Project a triage report onto the NetworkProfile shape the rest of the CLI
 * already consumes. Triage never probes the hub, so that layer stays
 * 'unknown' rather than claiming a result we did not measure.
 */
export function toNetworkProfile(report: TriageReport): NetworkProfile {
  const find = (name: TriageLayerName): TriageLayerResult | undefined =>
    report.layers.find((l) => l.layer === name);
  const checkedAt = report.checkedAt;
  const dnsLayer = find('dns');
  const internetLayer = find('internet');
  const targetsLayer = find('targets');

  const internet: NetworkLayer = {
    status: layerConnectivity(internetLayer),
    probes: internetLayer?.probes ?? [],
    checkedAt,
  };
  const hub: NetworkLayer = { status: 'unknown', probes: [], checkedAt };
  const targets: NetworkLayer = {
    status: layerConnectivity(targetsLayer),
    probes: targetsLayer?.probes ?? [],
    checkedAt,
  };
  const dns = {
    available: dnsLayer?.status === 'pass',
    // dnsLayer.durationMs is float performance.now() arithmetic — round it
    // before it lands in the published profile (same fix as probeDns in
    // network-profile.ts, commit 80c3624).
    latencyMs: Math.round(dnsLayer?.durationMs ?? 0),
  };

  return {
    internet,
    hub,
    targets,
    dns,
    mode: inferNetworkMode(internet, hub, targets, dns.available),
    profiledAt: checkedAt,
  };
}

function layerConnectivity(layer: TriageLayerResult | undefined): ConnectivityStatus {
  if (layer === undefined) return 'unknown';
  if (layer.status === 'pass') {
    const probes = layer.probes ?? [];
    return probes.some((p) => !p.reachable) ? 'degraded' : 'available';
  }
  if (layer.status === 'fail') {
    return layer.code === 'targets-partial' ? 'degraded' : 'unavailable';
  }
  return 'unknown';
}

/**
 * A timed-out HTTP or TCP probe becomes "no response" — evidence, because
 * that is exactly what unreachable looks like from here, and it is how
 * network-profile.ts has always treated a socket timeout. A timed-out DNS
 * probe becomes `unknown` instead (see unknownLayer): it cannot distinguish
 * "the resolver is broken" from "we did not wait long enough", and guessing
 * between those is the difference between a `local` and a `network` verdict.
 * The asymmetry is deliberate — do not "fix" it into consistency.
 */
function asHttpProbe(outcome: BoundedOutcome<HttpProbeResult>): HttpProbeResult {
  return outcome.ok
    ? outcome.value
    : { status: null, body: '', redirected: false, latencyMs: outcome.durationMs, error: outcome.error };
}
