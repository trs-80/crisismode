// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * VectorStoreLiveClient — read-only reachability/auth/index probes against
 * managed vector stores over raw fetch (no SDKs, no new dependencies).
 *
 * Degradation contract: a provider-level failure never throws and never
 * suppresses another provider's report; a check that cannot be evaluated
 * reports 'unknown' with the reason rather than guessing.
 *
 * Offline handling is deliberately NOT here — the agent's OfflineGate decides
 * whether to probe at all, using PR 2's triage verdict.
 *
 * SECURITY: keys are used only as request headers. Output carries the
 * provider name and a last-4 fingerprint, never the key.
 */

import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import type {
  VectorStoreBackend, VectorStoreCheck, VectorStoreIndexInfo, VectorStoreReport,
} from './backend.js';
import { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
import { fingerprintKey } from '../llm-provider/provider-table.js';
import type { VectorStoreConnection } from './provider-table.js';

/**
 * Per-request timeout. Scan races each agent's assessHealth against
 * AGENT_TIMEOUT_MS (2000ms) and a timed-out assessHealth returns a signal-less
 * 'unknown' — losing every checkId. Two sequential Pinecone requests (control
 * plane, then data plane) must fit inside that budget, so this is a ceiling
 * derived from scan's contract, not a tuning preference.
 */
export const DEFAULT_TIMEOUT_MS = 1_500;

export interface VectorStoreLiveConfig {
  connections: VectorStoreConnection[];
  /** Per-request timeout. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface PineconeIndexEntry {
  name?: unknown;
  dimension?: unknown;
  host?: unknown;
  status?: { ready?: unknown; state?: unknown } | undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class VectorStoreLiveClient implements VectorStoreBackend {
  private readonly connections: VectorStoreConnection[];
  private readonly timeoutMs: number;

  constructor(config: VectorStoreLiveConfig) {
    this.connections = config.connections;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async queryVectorStores(): Promise<VectorStoreReport[]> {
    return Promise.all(this.connections.map((connection) => this.probe(connection)));
  }

  private async probe(connection: VectorStoreConnection): Promise<VectorStoreReport> {
    const fingerprint = fingerprintKey(connection.apiKey);
    return connection.provider === 'pinecone'
      ? this.probePinecone(connection, fingerprint)
      : this.probeUpstash(connection, fingerprint);
  }

  /** Non-2xx that is neither 401 nor 403: reachable, but nothing else is known. */
  private nonAuthFailure(
    provider: string, status: number, fingerprint: string, latencyMs: number,
  ): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `${provider} answered in ${latencyMs}ms.` },
      {
        checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown',
        detail: `${provider} returned HTTP ${status} for key ${fingerprint} — the key was neither accepted nor rejected.`,
      },
      {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown',
        detail: `not checked — ${provider} returned HTTP ${status}.`,
      },
    ];
  }

  private unreachable(provider: string, message: string): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'fail', detail: `${provider} did not answer (${message}).` },
      { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
      { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
    ];
  }

  private rejectedKey(provider: string, status: number, fingerprint: string, latencyMs: number): VectorStoreCheck[] {
    return [
      { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `${provider} answered in ${latencyMs}ms.` },
      {
        checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'fail',
        detail: `${provider} rejected the key ${fingerprint} (HTTP ${status}).`,
      },
      { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the key was rejected.' },
    ];
  }

  /**
   * A 2xx response whose body could not be parsed as JSON, or whose shape
   * does not match what this provider is documented to return. This is
   * distinct from a well-formed body reporting zero indexes: an un-evaluable
   * response degrades to 'unknown', never to a fabricated definitive status
   * (never counted as "no indexes" and never counted as "index ready").
   */
  private malformedBody(provider: string): VectorStoreCheck {
    return {
      checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown',
      detail: `${provider} returned a response body that could not be parsed into the expected shape — index status could not be determined.`,
    };
  }

  private indexStatusCheck(provider: string, indexes: VectorStoreIndexInfo[]): VectorStoreCheck {
    if (indexes.length === 0) {
      return {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail',
        detail: `${provider} reports no indexes — retrieval has nothing to query.`,
      };
    }
    const notReady = indexes.filter((index) => !index.ready);
    if (notReady.length > 0) {
      return {
        checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail',
        detail: `not ready: ${notReady.map((i) => i.name).join(', ')}.`,
      };
    }
    return {
      checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'pass',
      detail: indexes
        .map((i) => `${i.name} ready (dimension ${i.dimension ?? 'unreported'}, ` +
          `${i.recordCount === null ? 'record count unreported' : `${i.recordCount} records`})`)
        .join('; ') + '.',
    };
  }

  private async request(url: string, headers: Record<string, string>, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async probePinecone(
    connection: VectorStoreConnection, fingerprint: string,
  ): Promise<VectorStoreReport> {
    const headers = {
      'Api-Key': connection.apiKey,
      'X-Pinecone-API-Version': '2025-04',
      accept: 'application/json',
    };
    const start = Date.now();
    let response: Response;
    try {
      response = await this.request(`${connection.baseUrl}/indexes`, headers);
    } catch (err) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.unreachable('pinecone', err instanceof Error ? err.message : String(err)),
      };
    }
    const latencyMs = Date.now() - start;

    if (response.status === 401 || response.status === 403) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.rejectedKey('pinecone', response.status, fingerprint, latencyMs),
      };
    }
    if (!response.ok) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.nonAuthFailure('pinecone', response.status, fingerprint, latencyMs),
      };
    }

    // `body.indexes` missing or not an array is a malformed response, not a
    // report of zero indexes — those two cases must not collapse into the
    // same 'fail: no indexes' outcome (see `malformedBody`).
    let entries: PineconeIndexEntry[] = [];
    let bodyMalformed = false;
    try {
      const body = (await response.json()) as { indexes?: unknown };
      if (Array.isArray(body.indexes)) {
        entries = body.indexes as PineconeIndexEntry[];
      } else {
        bodyMalformed = true;
      }
    } catch {
      bodyMalformed = true;
    }

    const indexes = await Promise.all(
      entries.map(async (entry): Promise<VectorStoreIndexInfo> => ({
        name: typeof entry.name === 'string' ? entry.name : 'unnamed',
        ready: entry.status?.ready === true,
        dimension: asNumber(entry.dimension),
        recordCount: typeof entry.host === 'string'
          ? await this.pineconeRecordCount(entry.host, connection.apiKey)
          : null,
      })),
    );

    return {
      provider: connection.provider,
      keyFingerprint: fingerprint,
      indexes,
      checks: [
        { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `pinecone answered in ${latencyMs}ms.` },
        {
          checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
          detail: `pinecone accepted the key ${fingerprint}.`,
        },
        bodyMalformed ? this.malformedBody('pinecone') : this.indexStatusCheck('pinecone', indexes),
      ],
    };
  }

  /**
   * Record count lives on the data plane, not the control plane. A failure
   * here leaves the count null (honest unreported) and never downgrades the
   * index_status check, which is a control-plane fact.
   */
  private async pineconeRecordCount(host: string, apiKey: string): Promise<number | null> {
    try {
      const response = await this.request(
        `https://${host}/describe_index_stats`,
        { 'Api-Key': apiKey, 'content-type': 'application/json' },
        { method: 'POST', body: '{}' },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { totalVectorCount?: unknown };
      return asNumber(body.totalVectorCount);
    } catch {
      return null;
    }
  }

  private async probeUpstash(
    connection: VectorStoreConnection, fingerprint: string,
  ): Promise<VectorStoreReport> {
    const headers = {
      Authorization: `Bearer ${connection.apiKey}`,
      accept: 'application/json',
    };
    const start = Date.now();
    let response: Response;
    try {
      response = await this.request(`${connection.baseUrl}/info`, headers);
    } catch (err) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.unreachable('upstash-vector', err instanceof Error ? err.message : String(err)),
      };
    }
    const latencyMs = Date.now() - start;

    if (response.status === 401 || response.status === 403) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.rejectedKey('upstash-vector', response.status, fingerprint, latencyMs),
      };
    }
    if (!response.ok) {
      return {
        provider: connection.provider, keyFingerprint: fingerprint, indexes: [],
        checks: this.nonAuthFailure('upstash-vector', response.status, fingerprint, latencyMs),
      };
    }

    // A missing or non-object `result` is a malformed response, not "index
    // ready with unreported stats" — fabricating a synthetic ready index here
    // would turn an un-evaluable response into a false 'pass' (see
    // `malformedBody`).
    let result: { vectorCount?: unknown; dimension?: unknown } | undefined;
    try {
      const body = (await response.json()) as { result?: unknown };
      if (body.result !== null && typeof body.result === 'object') {
        result = body.result as { vectorCount?: unknown; dimension?: unknown };
      }
    } catch {
      result = undefined;
    }

    if (result === undefined) {
      return {
        provider: connection.provider,
        keyFingerprint: fingerprint,
        indexes: [],
        checks: [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `upstash-vector answered in ${latencyMs}ms.` },
          {
            checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
            detail: `upstash-vector accepted the token ${fingerprint}.`,
          },
          this.malformedBody('upstash-vector'),
        ],
      };
    }

    // One REST URL addresses exactly one Upstash index; the host is its name.
    const name = connection.baseUrl.replace(/^https?:\/\//, '');
    const indexes: VectorStoreIndexInfo[] = [{
      name,
      ready: true,
      dimension: asNumber(result.dimension),
      recordCount: asNumber(result.vectorCount),
    }];

    return {
      provider: connection.provider,
      keyFingerprint: fingerprint,
      indexes,
      checks: [
        { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: `upstash-vector answered in ${latencyMs}ms.` },
        {
          checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass',
          detail: `upstash-vector accepted the token ${fingerprint}.`,
        },
        this.indexStatusCheck('upstash-vector', indexes),
      ],
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported vector-store command type: ${command.type}`);
    }
    if (command.operation === 'query_vector_stores') {
      return { reports: await this.queryVectorStores() };
    }
    throw new Error(`Unsupported vector-store operation: ${command.operation}`);
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const reports = await this.queryVectorStores();

    if (statement.includes('auth_valid')) {
      // `Array.prototype.every` is vacuously true on an empty array — a
      // client with zero configured providers must not satisfy `auth_valid`,
      // since nothing was actually verified.
      const allValid = reports.length > 0 && reports.every(
        (r) => r.checks.find((c) => c.checkId === VECTOR_STORE_CHECK_IDS.authValid)?.status === 'pass',
      );
      return compareCheckValue(allValid ? 'pass' : 'fail', check.expect.operator, check.expect.value);
    }
    if (statement.includes('ready_index_count')) {
      const count = reports.reduce((sum, r) => sum + r.indexes.filter((i) => i.ready).length, 0);
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    return false;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [{
      id: 'vector-store-rest-reader',
      kind: 'capability_provider',
      name: 'Vector Store REST Reader',
      maturity: 'live_validated',
      capabilities: ['vectorstore.index.read'],
      executionContexts: ['vector_store_read'],
      targetKinds: ['vector-store'],
      commandTypes: ['structured_command'],
      supportsDryRun: true,
      supportsExecute: true,
    }];
  }

  async close(): Promise<void> {}
}
