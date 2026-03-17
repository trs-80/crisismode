// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be before imports) ──

vi.mock('../cli/detect.js', () => ({
  detectServices: vi.fn(async () => []),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  passthrough.dim = passthrough;
  passthrough.bold = passthrough;
  passthrough.green = passthrough;
  passthrough.cyan = passthrough;
  passthrough.yellow = passthrough;
  passthrough.red = passthrough;
  return { default: passthrough };
});

// ── Imports ──

import { discoverStack, printStackProfile } from '../cli/autodiscovery.js';
import type { StackProfile } from '../cli/autodiscovery.js';
import { detectServices } from '../cli/detect.js';
import { readFile, access } from 'node:fs/promises';

// ── Helpers ──

const mockedDetectServices = vi.mocked(detectServices);
const mockedReadFile = vi.mocked(readFile);
const mockedAccess = vi.mocked(access);

function makePkgJson(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string {
  return JSON.stringify({
    name: 'test-app',
    dependencies: deps,
    devDependencies: devDeps,
  });
}

/** Make access succeed for specific file path substrings */
function allowFiles(...substrings: string[]): void {
  mockedAccess.mockImplementation(async (path: unknown) => {
    const p = String(path);
    if (substrings.some((s) => p.includes(s))) {
      return undefined;
    }
    throw new Error('ENOENT');
  });
}

// ── Tests ──

describe('discoverStack', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all file reads fail (no package.json, no files)
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedDetectServices.mockResolvedValue([]);
  });

  afterEach(() => {
    // Restore env vars
    process.env = { ...savedEnv };
  });

  // ── Basic case: no signals ──

  it('returns a basic profile with null framework/language when nothing is found', async () => {
    const profile = await discoverStack();

    expect(profile.services).toEqual([]);
    expect(profile.appStack.framework).toBeNull();
    expect(profile.appStack.language).toBeNull();
    expect(profile.appStack.hasDockerfile).toBe(false);
    expect(profile.appStack.hasCIConfig).toBe(false);
    expect(profile.appStack.dependencies).toEqual([]);
    expect(profile.confidence).toBe(0);
  });

  // ── Package.json detection ──

  it('detects TypeScript + Express from package.json', async () => {
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ express: '^4.18.0' }, { typescript: '^5.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('typescript');
    expect(profile.appStack.framework).toBe('express');
  });

  it('detects JavaScript when no typescript dep', async () => {
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ express: '^4.18.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('javascript');
    expect(profile.appStack.framework).toBe('express');
  });

  it('collects infrastructure dependencies from package.json', async () => {
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ pg: '^8.0.0', ioredis: '^5.0.0', typescript: '^5.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.dependencies).toContain('pg');
    expect(profile.appStack.dependencies).toContain('ioredis');
  });

  it('collects AI SDK dependencies from package.json', async () => {
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ '@anthropic-ai/sdk': '^0.20.0', openai: '^4.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.dependencies).toContain('@anthropic-ai/sdk');
    expect(profile.appStack.dependencies).toContain('openai');
  });

  // ── Non-JS language detection ──

  it('detects Go from go.mod', async () => {
    allowFiles('go.mod');

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('go');
  });

  it('detects Python from requirements.txt', async () => {
    allowFiles('requirements.txt');

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('python');
  });

  it('detects Python from pyproject.toml', async () => {
    allowFiles('pyproject.toml');

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('python');
  });

  it('detects Rust from Cargo.toml', async () => {
    allowFiles('Cargo.toml');

    const profile = await discoverStack();

    expect(profile.appStack.language).toBe('rust');
  });

  // ── Dockerfile and CI detection ──

  it('detects Dockerfile presence', async () => {
    allowFiles('Dockerfile');
    // Also need a package.json to not short-circuit into language detection
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ typescript: '^5.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.hasDockerfile).toBe(true);
  });

  it('detects CI config presence', async () => {
    allowFiles('.github/workflows');
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ typescript: '^5.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    expect(profile.appStack.hasCIConfig).toBe(true);
  });

  // ── Environment variable scanning ──

  it('reports DATABASE_URL as present when set', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/test';

    const profile = await discoverStack();

    const dbHint = profile.envHints.find((h) => h.name === 'DATABASE_URL');
    expect(dbHint).toBeDefined();
    expect(dbHint!.present).toBe(true);
    expect(dbHint!.inferredService).toBe('postgresql');
  });

  it('reports REDIS_URL as present when set', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    const profile = await discoverStack();

    const redisHint = profile.envHints.find((h) => h.name === 'REDIS_URL');
    expect(redisHint).toBeDefined();
    expect(redisHint!.present).toBe(true);
    expect(redisHint!.inferredService).toBe('redis');
  });

  it('reports env hints as not present when unset', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;

    const profile = await discoverStack();

    const dbHint = profile.envHints.find((h) => h.name === 'DATABASE_URL');
    expect(dbHint).toBeDefined();
    expect(dbHint!.present).toBe(false);
  });

  // ── AI provider detection ──

  it('detects configured AI provider (SDK + env var)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ '@anthropic-ai/sdk': '^0.20.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    const anthropic = profile.aiProviders.find((p) => p.provider === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.configured).toBe(true);
    expect(anthropic!.envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('detects unconfigured AI provider (SDK found, no env var)', async () => {
    delete process.env.OPENAI_API_KEY;
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ openai: '^4.0.0' });
      }
      throw new Error('ENOENT');
    });

    const profile = await discoverStack();

    const openai = profile.aiProviders.find((p) => p.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.configured).toBe(false);
  });

  it('detects AI provider from env var alone (no SDK dep)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const profile = await discoverStack();

    const openai = profile.aiProviders.find((p) => p.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.configured).toBe(true);
  });

  // ── Platform detection via env vars ──

  it('detects Vercel platform from VERCEL env var', async () => {
    process.env.VERCEL = '1';

    const profile = await discoverStack();

    expect(profile.platform.platform).toBe('vercel');
    expect(profile.platform.detected).toBe(true);
    expect(profile.platform.signals).toContain('env:VERCEL');
  });

  it('detects Fly.io platform from FLY_APP_NAME env var', async () => {
    process.env.FLY_APP_NAME = 'my-app';

    const profile = await discoverStack();

    expect(profile.platform.platform).toBe('fly');
    expect(profile.platform.detected).toBe(true);
  });

  // ── Platform detection via config files ──

  it('detects Vercel platform from vercel.json', async () => {
    allowFiles('vercel.json');

    const profile = await discoverStack();

    expect(profile.platform.platform).toBe('vercel');
    expect(profile.platform.detected).toBe(true);
    expect(profile.platform.signals).toContain('file:vercel.json');
  });

  it('detects Fly.io platform from fly.toml', async () => {
    allowFiles('fly.toml');

    const profile = await discoverStack();

    expect(profile.platform.platform).toBe('fly');
    expect(profile.platform.detected).toBe(true);
    expect(profile.platform.signals).toContain('file:fly.toml');
  });

  it('returns null platform when no signals found', async () => {
    const profile = await discoverStack();

    expect(profile.platform.platform).toBeNull();
    expect(profile.platform.detected).toBe(false);
    expect(profile.platform.signals).toEqual([]);
  });

  // ── Confidence scoring ──

  it('returns 0 confidence when nothing is detected', async () => {
    const profile = await discoverStack();

    expect(profile.confidence).toBe(0);
  });

  it('increases confidence with detected services', async () => {
    mockedDetectServices.mockResolvedValue([
      { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
    ]);

    const profile = await discoverStack();

    expect(profile.confidence).toBeGreaterThan(0);
  });

  it('increases confidence with language + deps + env hints + platform', async () => {
    // Max out: 3 detected services + language + deps + 2 env hints + platform
    mockedDetectServices.mockResolvedValue([
      { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
      { kind: 'redis', host: '127.0.0.1', port: 6379, detected: true },
      { kind: 'etcd', host: '127.0.0.1', port: 2379, detected: true },
    ]);
    mockedReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).includes('package.json')) {
        return makePkgJson({ pg: '^8.0.0', typescript: '^5.0.0' });
      }
      throw new Error('ENOENT');
    });
    process.env.DATABASE_URL = 'postgres://localhost/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.VERCEL = '1';
    allowFiles('vercel.json');

    const profile = await discoverStack();

    // 3 services(3/3) + language(1) + deps(1) + 2 hints(2/2) + platform(1) = 8/8 = 1.0
    expect(profile.confidence).toBe(1);
  });

  // ── Port-probed services pass through ──

  it('includes detected services from port probing', async () => {
    const services = [
      { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
      { kind: 'redis', host: '127.0.0.1', port: 6379, detected: false },
    ];
    mockedDetectServices.mockResolvedValue(services);

    const profile = await discoverStack();

    expect(profile.services).toEqual(services);
  });
});

// ── printStackProfile ──

describe('printStackProfile', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function makeProfile(overrides: Partial<StackProfile> = {}): StackProfile {
    return {
      services: [],
      appStack: {
        framework: null,
        language: null,
        hasDockerfile: false,
        hasCIConfig: false,
        dependencies: [],
      },
      envHints: [],
      platform: { platform: null, detected: false, signals: [] },
      aiProviders: [],
      confidence: 0,
      ...overrides,
    };
  }

  it('does not throw for an empty profile', () => {
    expect(() => printStackProfile(makeProfile())).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
  });

  it('prints detected services', () => {
    const profile = makeProfile({
      services: [
        { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
      ],
    });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('postgresql');
    expect(output).toContain('5432');
  });

  it('prints "none detected" when no services', () => {
    printStackProfile(makeProfile());

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('none detected');
  });

  it('prints app stack info', () => {
    const profile = makeProfile({
      appStack: {
        framework: 'express',
        language: 'typescript',
        hasDockerfile: true,
        hasCIConfig: true,
        dependencies: ['pg', 'ioredis'],
      },
    });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('typescript');
    expect(output).toContain('express');
    expect(output).toContain('Docker');
    expect(output).toContain('CI');
    expect(output).toContain('pg');
  });

  it('prints environment hints when present', () => {
    const profile = makeProfile({
      envHints: [
        { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' },
        { name: 'REDIS_URL', present: false, kind: 'redis_url', inferredService: 'redis' },
      ],
    });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('postgresql');
    // Only present hints are shown
    expect(output).not.toContain('REDIS_URL');
  });

  it('prints platform info when detected', () => {
    const profile = makeProfile({
      platform: { platform: 'vercel', detected: true, signals: ['env:VERCEL'] },
    });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('vercel');
    expect(output).toContain('env:VERCEL');
  });

  it('prints AI providers', () => {
    const profile = makeProfile({
      aiProviders: [
        { provider: 'anthropic', configured: true, envVar: 'ANTHROPIC_API_KEY' },
        { provider: 'openai', configured: false, envVar: 'OPENAI_API_KEY' },
      ],
    });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('anthropic');
    expect(output).toContain('configured');
    expect(output).toContain('openai');
    expect(output).toContain('key not set');
  });

  it('includes confidence percentage in output', () => {
    const profile = makeProfile({ confidence: 0.75 });

    printStackProfile(profile);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('75%');
  });
});
