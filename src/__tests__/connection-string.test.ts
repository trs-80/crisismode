// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseConnectionString,
  buildTargetsFromEnvHints,
  readVercelProjectConfig,
} from '../cli/autodiscovery.js';
import type { EnvHint } from '../cli/autodiscovery.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── parseConnectionString ──

describe('parseConnectionString', () => {
  it('parses a PostgreSQL URL with all fields', () => {
    const result = parseConnectionString('postgres://admin:secret@db.example.com:5433/mydb');
    expect(result).toEqual({
      kind: 'postgresql',
      host: 'db.example.com',
      port: 5433,
      username: 'admin',
      password: 'secret',
      database: 'mydb',
    });
  });

  it('parses postgresql:// protocol', () => {
    const result = parseConnectionString('postgresql://user:pass@host:5432/db');
    expect(result).toEqual({
      kind: 'postgresql',
      host: 'host',
      port: 5432,
      username: 'user',
      password: 'pass',
      database: 'db',
    });
  });

  it('uses default port 5432 for PostgreSQL when port is omitted', () => {
    const result = parseConnectionString('postgres://user:pass@db.example.com/mydb');
    expect(result).not.toBeNull();
    expect(result!.port).toBe(5432);
  });

  it('parses a Redis URL with default port', () => {
    const result = parseConnectionString('redis://default:redispass@cache.example.com/0');
    expect(result).toEqual({
      kind: 'redis',
      host: 'cache.example.com',
      port: 6379,
      username: 'default',
      password: 'redispass',
      database: '0',
    });
  });

  it('parses rediss:// protocol (TLS)', () => {
    const result = parseConnectionString('rediss://:token@redis.cloud:6380');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('redis');
    expect(result!.port).toBe(6380);
  });

  it('parses a MongoDB URL', () => {
    const result = parseConnectionString('mongodb://user:pass@mongo.example.com:27018/appdb');
    expect(result).toEqual({
      kind: 'mongodb',
      host: 'mongo.example.com',
      port: 27018,
      username: 'user',
      password: 'pass',
      database: 'appdb',
    });
  });

  it('parses mongodb+srv:// protocol with default port', () => {
    const result = parseConnectionString('mongodb+srv://user:pass@cluster.example.com/mydb');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('mongodb');
    expect(result!.port).toBe(27017);
  });

  it('parses a MySQL URL', () => {
    const result = parseConnectionString('mysql://root:pass@mysql.local:3307/shop');
    expect(result).toEqual({
      kind: 'mysql',
      host: 'mysql.local',
      port: 3307,
      username: 'root',
      password: 'pass',
      database: 'shop',
    });
  });

  it('uses default port 3306 for MySQL when port is omitted', () => {
    const result = parseConnectionString('mysql://root:pass@mysql.local/shop');
    expect(result).not.toBeNull();
    expect(result!.port).toBe(3306);
  });

  it('parses a RabbitMQ AMQP URL', () => {
    const result = parseConnectionString('amqp://guest:guest@rabbit.local:5673/vhost');
    expect(result).toEqual({
      kind: 'rabbitmq',
      host: 'rabbit.local',
      port: 5673,
      username: 'guest',
      password: 'guest',
      database: 'vhost',
    });
  });

  it('parses amqps:// protocol with default port', () => {
    const result = parseConnectionString('amqps://user:pass@rabbit.cloud');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('rabbitmq');
    expect(result!.port).toBe(5672);
  });

  it('decodes URL-encoded special characters in passwords', () => {
    const result = parseConnectionString('postgres://admin:p%40ss%23word@host:5432/db');
    expect(result).not.toBeNull();
    expect(result!.password).toBe('p@ss#word');
  });

  it('returns null for malformed URLs', () => {
    expect(parseConnectionString('not-a-url')).toBeNull();
    expect(parseConnectionString('')).toBeNull();
    expect(parseConnectionString('://missing-protocol')).toBeNull();
  });

  it('returns null for unsupported protocols', () => {
    expect(parseConnectionString('http://example.com')).toBeNull();
    expect(parseConnectionString('ftp://files.example.com')).toBeNull();
  });

  it('handles URLs without credentials', () => {
    const result = parseConnectionString('postgres://db.example.com:5432/mydb');
    expect(result).not.toBeNull();
    expect(result!.username).toBeUndefined();
    expect(result!.password).toBeUndefined();
    expect(result!.host).toBe('db.example.com');
    expect(result!.database).toBe('mydb');
  });

  it('handles URLs without a database path', () => {
    const result = parseConnectionString('redis://cache.local:6379');
    expect(result).not.toBeNull();
    expect(result!.database).toBeUndefined();
  });
});

// ── buildTargetsFromEnvHints ──

describe('buildTargetsFromEnvHints', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds targets from present env hints with connection strings', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@neon.tech:5432/mydb';

    const hints: EnvHint[] = [
      { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' },
      { name: 'REDIS_URL', present: false, kind: 'redis_url', inferredService: 'redis' },
    ];

    const targets = buildTargetsFromEnvHints(hints);
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('env-database-url');
    expect(targets[0].kind).toBe('postgresql');
    expect(targets[0].primary).toEqual({ host: 'neon.tech', port: 5432, database: 'mydb' });
    expect(targets[0].credentials).toEqual({ type: 'value', username: 'user', password: 'pass' });
  });

  it('deduplicates targets by kind+host+port', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@db.host:5432/db1';
    process.env['POSTGRES_URL'] = 'postgres://user:pass@db.host:5432/db2';

    const hints: EnvHint[] = [
      { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' },
      { name: 'POSTGRES_URL', present: true, kind: 'database_url', inferredService: 'postgresql' },
    ];

    const targets = buildTargetsFromEnvHints(hints);
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('env-database-url');
  });

  it('skips hints without inferredService', () => {
    process.env['AWS_REGION'] = 'us-east-1';

    const hints: EnvHint[] = [
      { name: 'AWS_REGION', present: true, kind: 'aws_region' },
    ];

    const targets = buildTargetsFromEnvHints(hints);
    expect(targets).toHaveLength(0);
  });

  it('skips hints where env value is not a parseable connection string', () => {
    process.env['PGHOST'] = 'just-a-hostname';

    const hints: EnvHint[] = [
      { name: 'PGHOST', present: true, kind: 'database_url', inferredService: 'postgresql' },
    ];

    const targets = buildTargetsFromEnvHints(hints);
    expect(targets).toHaveLength(0);
  });

  it('omits credentials when URL has no username/password', () => {
    process.env['DATABASE_URL'] = 'postgres://db.host:5432/mydb';

    const hints: EnvHint[] = [
      { name: 'DATABASE_URL', present: true, kind: 'database_url', inferredService: 'postgresql' },
    ];

    const targets = buildTargetsFromEnvHints(hints);
    expect(targets).toHaveLength(1);
    expect(targets[0].credentials).toBeUndefined();
  });
});

// ── readVercelProjectConfig ──

describe('readVercelProjectConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `crisismode-vercel-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reads projectId and orgId from .vercel/project.json', () => {
    const vercelDir = join(testDir, '.vercel');
    mkdirSync(vercelDir, { recursive: true });
    writeFileSync(join(vercelDir, 'project.json'), JSON.stringify({
      projectId: 'prj_abc123',
      orgId: 'team_xyz789',
    }));

    const result = readVercelProjectConfig(testDir);
    expect(result).toEqual({ projectId: 'prj_abc123', orgId: 'team_xyz789' });
  });

  it('returns null when .vercel/project.json does not exist', () => {
    const result = readVercelProjectConfig(testDir);
    expect(result).toBeNull();
  });

  it('returns null when project.json is missing required fields', () => {
    const vercelDir = join(testDir, '.vercel');
    mkdirSync(vercelDir, { recursive: true });
    writeFileSync(join(vercelDir, 'project.json'), JSON.stringify({
      projectId: 'prj_abc123',
      // orgId missing
    }));

    const result = readVercelProjectConfig(testDir);
    expect(result).toBeNull();
  });

  it('returns null when project.json contains invalid JSON', () => {
    const vercelDir = join(testDir, '.vercel');
    mkdirSync(vercelDir, { recursive: true });
    writeFileSync(join(vercelDir, 'project.json'), 'not valid json');

    const result = readVercelProjectConfig(testDir);
    expect(result).toBeNull();
  });
});
