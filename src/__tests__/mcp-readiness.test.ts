// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before imports) ──

vi.mock('../readiness/run.js', () => ({
  runReadiness: vi.fn(),
}));

// ── Imports ──

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server.js';
import { runReadiness } from '../readiness/run.js';
import type { ReadinessReport } from '../readiness/types.js';

// ── Helpers ──

const EXPECTED_TOOLS = [
  'crisismode_bundle_ingest',
  'crisismode_bundle_plan',
  'crisismode_bundle_respond',
  'crisismode_diagnose',
  'crisismode_list_agents',
  'crisismode_readiness',
  'crisismode_scan',
  'crisismode_status',
];

const REPORT: ReadinessReport = {
  verdict: 'ready',
  score: 100,
  evaluated: 3,
  unknown: 0,
  findings: [],
};

async function connectedClient() {
  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// ── Tests ──

describe('MCP server — crisismode_readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('protocol surface', () => {
    it('registers crisismode_readiness alongside the other 7 tools', async () => {
      const { client, close } = await connectedClient();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
      } finally {
        await close();
      }
    });

    it('annotates every tool as read-only — the MCP surface must never mutate infrastructure', async () => {
      const { client, close } = await connectedClient();
      try {
        const { tools } = await client.listTools();
        expect(tools.length).toBe(8);
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
        }
      } finally {
        await close();
      }
    });
  });

  describe('crisismode_readiness', () => {
    it('is callable through the protocol and returns the readiness report', async () => {
      vi.mocked(runReadiness).mockResolvedValue(REPORT);

      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({ name: 'crisismode_readiness', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual(REPORT);
        expect(runReadiness).toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    it('reports readiness failures as isError results, not protocol errors', async () => {
      vi.mocked(runReadiness).mockRejectedValue(new Error('readiness pipeline crashed'));

      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({ name: 'crisismode_readiness', arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).toContain('readiness pipeline crashed');
      } finally {
        await close();
      }
    });
  });
});
