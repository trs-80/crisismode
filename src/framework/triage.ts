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

import type { ProbeResult } from '@crisismode/agent-sdk';
import type { EscalationLevel } from './escalation.js';

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
