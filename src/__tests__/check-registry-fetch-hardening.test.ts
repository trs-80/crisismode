// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Transport hardening for the check-plugin registry fetcher.
 *
 * fetchUrl/fetchBuffer are how executable plugin code reaches the machine, so
 * a hostile or misconfigured server must not be able to hang the process in a
 * redirect loop, exhaust memory with an endless body, or quietly downgrade a
 * TLS-protected fetch to plaintext.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchUrl, fetchBuffer, resolveRedirectTarget } from '../config/check-registry.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))),
  );
});

/** Start a throwaway HTTP server and return its base URL. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('redirect policy', () => {
  it('rejects an HTTPS→HTTP downgrade', () => {
    expect(() =>
      resolveRedirectTarget('https://registry.example/plugin.tgz', 'http://evil.example/plugin.tgz'),
    ).toThrow(/downgrade/i);
  });

  it('rejects a redirect to a non-HTTP scheme', () => {
    expect(() =>
      resolveRedirectTarget('https://registry.example/plugin.tgz', 'file:///etc/passwd'),
    ).toThrow(/scheme/i);
  });

  it('resolves a relative Location against the current URL', () => {
    expect(
      resolveRedirectTarget('https://registry.example/checks/a.tgz', '../other/b.tgz').href,
    ).toBe('https://registry.example/other/b.tgz');
  });

  it('allows an HTTP→HTTPS upgrade', () => {
    expect(
      resolveRedirectTarget('http://registry.example/a', 'https://registry.example/a').href,
    ).toBe('https://registry.example/a');
  });
});

describe('fetch redirect limits', () => {
  it('gives up on a redirect loop instead of recursing forever', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });

    await expect(fetchUrl(`${base}/loop`)).rejects.toThrow(/too many redirects/i);
  }, 20_000);

  it('follows a bounded redirect chain successfully', async () => {
    let hop = 0;
    const base = await serve((_req, res) => {
      hop += 1;
      if (hop <= 2) {
        res.writeHead(302, { location: '/next' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });

    await expect(fetchUrl(`${base}/start`)).resolves.toBe('{"ok":true}');
  }, 20_000);
});

describe('fetch response size limits', () => {
  it('rejects a body that exceeds the size cap', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      // Stream past the cap without ever ending.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = setInterval(() => res.write(chunk), 1);
      res.on('close', () => clearInterval(pump));
    });

    await expect(fetchBuffer(`${base}/huge`, { maxBytes: 256 * 1024 })).rejects.toThrow(
      /size limit|too large/i,
    );
  }, 20_000);

  it('accepts a body within the cap', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(1024, 0x62));
    });

    const data = await fetchBuffer(`${base}/small`, { maxBytes: 256 * 1024 });
    expect(data.length).toBe(1024);
  }, 20_000);
});
