// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Unit tests for RedisLiveClient's executeCommand operations.
 *
 * Follows the pattern used for K8sLiveClient in live-clients.test.ts:
 * inject a mocked underlying client via Object.defineProperty so no real
 * Redis connection is required, then verify observable behavior (calls
 * made, values returned) rather than internals.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RedisLiveClient as RedisLiveClientType } from '../agent/redis/live-client.js';
import type { Command } from '../types/common.js';

function structuredCommand(operation: string, parameters?: Record<string, unknown>): Command {
  return { type: 'structured_command', operation, ...(parameters !== undefined ? { parameters } : {}) };
}

async function loadClient(): Promise<typeof RedisLiveClientType> {
  const mod = await import('../agent/redis/live-client.js');
  return mod.RedisLiveClient;
}

function makeClient(
  RedisLiveClient: typeof RedisLiveClientType,
  mock: Record<string, unknown>,
): InstanceType<typeof RedisLiveClientType> {
  const client = Object.create(RedisLiveClient.prototype) as InstanceType<typeof RedisLiveClientType>;
  Object.defineProperty(client, 'client', { value: mock, writable: true });
  return client;
}

describe('RedisLiveClient executeCommand', () => {
  describe('client_kill', () => {
    it('kills only clients that are idle past the threshold or blocked, by ID', async () => {
      const RedisLiveClient = await loadClient();
      const clientListReply = [
        'id=1 addr=10.0.0.1:1 idle=5 flags=N',
        'id=2 addr=10.0.0.2:1 idle=900 flags=N',
        'id=3 addr=10.0.0.3:1 idle=0 flags=b',
        'id=4 addr=10.0.0.4:1 idle=1 flags=N',
      ].join('\n');

      const call = vi.fn(async (...args: unknown[]) => {
        if (args[0] === 'CLIENT' && args[1] === 'LIST') return clientListReply;
        if (args[0] === 'CLIENT' && args[1] === 'KILL') return 'OK';
        throw new Error(`unexpected call: ${args.join(' ')}`);
      });
      const backend = makeClient(RedisLiveClient, { call });

      const result = await backend.executeCommand(
        structuredCommand('client_kill', { filter: 'idle>300', includeBlocked: true }),
      );

      expect(result).toEqual({ disconnectedClients: 2 });
      expect(call).toHaveBeenCalledWith('CLIENT', 'KILL', 'ID', '2');
      expect(call).toHaveBeenCalledWith('CLIENT', 'KILL', 'ID', '3');
      expect(call).not.toHaveBeenCalledWith('CLIENT', 'KILL', 'ID', '1');
      expect(call).not.toHaveBeenCalledWith('CLIENT', 'KILL', 'ID', '4');
    });

    it('does not issue any KILL and does not throw when no client matches', async () => {
      const RedisLiveClient = await loadClient();
      const clientListReply = 'id=1 addr=10.0.0.1:1 idle=0 flags=N';
      const call = vi.fn(async (...args: unknown[]) => {
        if (args[0] === 'CLIENT' && args[1] === 'LIST') return clientListReply;
        throw new Error(`unexpected call: ${args.join(' ')}`);
      });
      const backend = makeClient(RedisLiveClient, { call });

      const result = await backend.executeCommand(
        structuredCommand('client_kill', { filter: 'idle>300', includeBlocked: true }),
      );

      expect(result).toEqual({ disconnectedClients: 0 });
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('tolerates a client that disconnected between LIST and KILL', async () => {
      const RedisLiveClient = await loadClient();
      const clientListReply = 'id=9 addr=10.0.0.9:1 idle=900 flags=N';
      const call = vi.fn(async (...args: unknown[]) => {
        if (args[0] === 'CLIENT' && args[1] === 'LIST') return clientListReply;
        if (args[0] === 'CLIENT' && args[1] === 'KILL') throw new Error('ERR No such client');
        throw new Error(`unexpected call: ${args.join(' ')}`);
      });
      const backend = makeClient(RedisLiveClient, { call });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await backend.executeCommand(
        structuredCommand('client_kill', { filter: 'idle>300', includeBlocked: true }),
      );

      expect(result).toEqual({ disconnectedClients: 0 });
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('surfaces an unexpected KILL failure instead of swallowing it silently', async () => {
      const RedisLiveClient = await loadClient();
      const clientListReply = 'id=9 addr=10.0.0.9:1 idle=900 flags=N';
      const call = vi.fn(async (...args: unknown[]) => {
        if (args[0] === 'CLIENT' && args[1] === 'LIST') return clientListReply;
        if (args[0] === 'CLIENT' && args[1] === 'KILL') throw new Error('ERR connection reset by peer');
        throw new Error(`unexpected call: ${args.join(' ')}`);
      });
      const backend = makeClient(RedisLiveClient, { call });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await backend.executeCommand(
        structuredCommand('client_kill', { filter: 'idle>300', includeBlocked: true }),
      );

      expect(result).toEqual({ disconnectedClients: 0 });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CLIENT KILL ID 9 failed'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe('active_expiry', () => {
    it('aggressively unlinks keys that carry a TTL, and leaves persistent keys alone', async () => {
      const RedisLiveClient = await loadClient();
      const scan = vi.fn(async () => ['0', ['volatile:1', 'volatile:2', 'persistent:1']]);
      const ttl = vi.fn(async (key: string) => {
        if (key === 'volatile:1') return 250; // TTL set, far from expiry
        if (key === 'volatile:2') return 5; // TTL set, close to expiry
        if (key === 'persistent:1') return -1; // no TTL — not volatile
        return -2;
      });
      const unlink = vi.fn(async () => 1);
      const backend = makeClient(RedisLiveClient, { scan, ttl, unlink });

      const result = await backend.executeCommand(
        structuredCommand('active_expiry', { effort: 'aggressive' }),
      );

      expect(unlink).toHaveBeenCalledWith('volatile:1');
      expect(unlink).toHaveBeenCalledWith('volatile:2');
      expect(unlink).not.toHaveBeenCalledWith('persistent:1');
      expect(result).toEqual({ expiredKeys: 2 });
    });

    it('does not unlink persistent (no-TTL) keys even under aggressive effort', async () => {
      const RedisLiveClient = await loadClient();
      const scan = vi.fn(async () => ['0', ['persistent:1', 'persistent:2']]);
      const ttl = vi.fn(async () => -1);
      const unlink = vi.fn(async () => 1);
      const backend = makeClient(RedisLiveClient, { scan, ttl, unlink });

      const result = await backend.executeCommand(
        structuredCommand('active_expiry', { effort: 'aggressive' }),
      );

      expect(unlink).not.toHaveBeenCalled();
      expect(result).toEqual({ expiredKeys: 0 });
    });

    it('counts a key that lazily expired during the TTL check without a separate unlink call', async () => {
      const RedisLiveClient = await loadClient();
      const scan = vi.fn(async () => ['0', ['about-to-expire']]);
      const ttl = vi.fn(async () => 0);
      const unlink = vi.fn(async () => 1);
      const backend = makeClient(RedisLiveClient, { scan, ttl, unlink });

      const result = await backend.executeCommand(
        structuredCommand('active_expiry', { effort: 'aggressive' }),
      );

      expect(unlink).not.toHaveBeenCalled();
      expect(result).toEqual({ expiredKeys: 1 });
    });
  });
});
