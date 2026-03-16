// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { detectServices } from '../cli/detect.js';

describe('detectServices', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    // Start a TCP server on a random port
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('detects a running service on an open port', async () => {
    const results = await detectServices('127.0.0.1', [
      { kind: 'test-service', port },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].detected).toBe(true);
    expect(results[0].kind).toBe('test-service');
    expect(results[0].port).toBe(port);
  });

  it('reports false for closed ports', async () => {
    const results = await detectServices('127.0.0.1', [
      { kind: 'no-service', port: port + 10000 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].detected).toBe(false);
  });

  it('probes multiple ports in parallel', async () => {
    const results = await detectServices('127.0.0.1', [
      { kind: 'open', port },
      { kind: 'closed', port: port + 10000 },
    ]);
    expect(results).toHaveLength(2);
    const open = results.find((r) => r.kind === 'open');
    const closed = results.find((r) => r.kind === 'closed');
    expect(open?.detected).toBe(true);
    expect(closed?.detected).toBe(false);
  });

  it('uses default probes when called with no arguments', async () => {
    // Just verify it returns results for default ports (all likely closed in test)
    const results = await detectServices('127.0.0.1');
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      expect(r).toHaveProperty('kind');
      expect(r).toHaveProperty('detected');
    }
  });
});
