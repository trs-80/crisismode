// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import type {
  VectorStoreBackend, VectorStoreCheck, VectorStoreIndexInfo, VectorStoreReport,
} from './backend.js';
import { VECTOR_STORE_CHECK_IDS } from './check-ids.js';
import { fingerprintKey } from '../llm-provider/provider-table.js';

export type VectorStoreScenario =
  | 'healthy'
  | 'unreachable'
  | 'bad_key'
  | 'index_not_ready'
  | 'no_indexes';

const SCENARIOS: VectorStoreScenario[] = [
  'healthy', 'unreachable', 'bad_key', 'index_not_ready', 'no_indexes',
];

/**
 * Obviously-fake key: the simulator has no real credential and must not imply
 * one. Exported so the secrecy test can assert the raw value never escapes.
 */
export const SIMULATOR_FIXTURE_KEY = 'vs-simulator-fixture-key-0000';

const SIMULATOR_FINGERPRINT = fingerprintKey(SIMULATOR_FIXTURE_KEY);

const READY_INDEX: VectorStoreIndexInfo = {
  name: 'documents', ready: true, dimension: 1536, recordCount: 42_000,
};

export class VectorStoreSimulator implements VectorStoreBackend {
  private scenario: VectorStoreScenario = 'healthy';

  getScenario(): VectorStoreScenario {
    return this.scenario;
  }

  /**
   * `to: string` is the ExecutionBackend signature, so the value is validated
   * rather than cast. This is deliberately stricter than PgSimulator, which
   * casts blindly (`this.state = to as SimulatorState`) and so accepts a typo'd
   * scenario silently — a test that then asserts healthy behaviour passes for
   * the wrong reason.
   */
  transition(to: string): void {
    if (!SCENARIOS.includes(to as VectorStoreScenario)) {
      throw new Error(
        `Invalid vector-store simulator scenario: ${to} (expected one of ${SCENARIOS.join(', ')})`,
      );
    }
    this.scenario = to as VectorStoreScenario;
  }

  async queryVectorStores(): Promise<VectorStoreReport[]> {
    return [{
      provider: 'pinecone',
      keyFingerprint: SIMULATOR_FINGERPRINT,
      checks: this.checks(),
      indexes: this.indexes(),
    }];
  }

  private indexes(): VectorStoreIndexInfo[] {
    switch (this.scenario) {
      case 'healthy':
        return [READY_INDEX];
      case 'index_not_ready':
        return [{ name: 'documents', ready: false, dimension: 1536, recordCount: 0 }];
      case 'unreachable':
      case 'bad_key':
      case 'no_indexes':
        return [];
    }
  }

  private checks(): VectorStoreCheck[] {
    switch (this.scenario) {
      case 'healthy':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 41ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'pass', detail: '1 index ready: documents (dimension 1536, 42000 records).' },
        ];
      case 'unreachable':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'fail', detail: 'pinecone control plane did not answer (network error).' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the provider was unreachable.' },
        ];
      case 'bad_key':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 38ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'fail', detail: `pinecone rejected the key ${SIMULATOR_FINGERPRINT} (HTTP 401).` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'unknown', detail: 'not checked — the key was rejected.' },
        ];
      case 'index_not_ready':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 44ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail', detail: 'index documents is not ready (state: Initializing).' },
        ];
      case 'no_indexes':
        return [
          { checkId: VECTOR_STORE_CHECK_IDS.reachable, status: 'pass', detail: 'pinecone control plane answered in 36ms.' },
          { checkId: VECTOR_STORE_CHECK_IDS.authValid, status: 'pass', detail: `pinecone accepted the key ${SIMULATOR_FINGERPRINT}.` },
          { checkId: VECTOR_STORE_CHECK_IDS.indexStatus, status: 'fail', detail: 'the account has no indexes — retrieval has nothing to query.' },
        ];
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported vector-store simulator command type: ${command.type}`);
    }
    if (command.operation === 'query_vector_stores') {
      return { reports: await this.queryVectorStores() };
    }
    return { simulated: true, operation: command.operation, parameters: command.parameters };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const [report] = await this.queryVectorStores();
    if (!report) return false;

    if (statement === 'auth_valid') {
      const status = report.checks.find((c) => c.checkId === VECTOR_STORE_CHECK_IDS.authValid)?.status ?? 'unknown';
      return compareCheckValue(status, check.expect.operator, check.expect.value);
    }
    if (statement === 'ready_index_count') {
      const count = report.indexes.filter((i) => i.ready).length;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    // Fail closed, matching the live client: a precondition/success-criteria
    // check on an unrecognized statement is a plan-authoring bug, and this
    // backend must not let it pass silently. Throwing was considered instead,
    // but the graph engine's node functions (src/framework/graph-nodes.ts)
    // call evaluateCheck without a surrounding try/catch — an exception here
    // would propagate out of LangGraph's stream() uncaught rather than
    // surface as a failed step, so `false` is the only semantic both
    // execution engines handle safely.
    return false;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [{
      id: 'vector-store-simulator-reader',
      kind: 'capability_provider',
      name: 'Vector Store Simulator Reader',
      maturity: 'simulator_only',
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
