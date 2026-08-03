// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Deep autodiscovery — goes beyond port probing to build a complete
 * picture of the local application stack.
 *
 * Inspects package.json, Dockerfiles, CI configs, environment variables,
 * and deployment platform signals. All detection is best-effort and
 * non-blocking. Secret values are never logged or stored.
 */

import { readFile, access, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { detectServices } from './detect.js';
import type { DetectedService } from './detect.js';
import { parseRdsEndpoint } from './aws-endpoint.js';
import { INFRA_PKG_NAMES } from '../config/service-registry.js';
import type { TargetConfig } from '../config/schema.js';
import { AI_ENV_VARS } from '../agent/ai-provider/provider-table.js';
import { findEnvExample } from '../agent/config-drift/env-example.js';
import { discoverStateSource, parseTfState, WATCHABLE_TF_TYPES } from '../agent/iac-drift/state-parser.js';

// ── Types ──

export interface ParsedConnection {
  kind: string;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  database?: string | undefined;
}

export interface StackProfile {
  /** Services detected via port probing */
  services: DetectedService[];
  /** App framework and dependencies from package.json/Dockerfile */
  appStack: AppStackInfo;
  /** Environment variable hints (DATABASE_URL, REDIS_URL, etc.) */
  envHints: EnvHint[];
  /** Deployment platform signals */
  platform: PlatformInfo;
  /** AI provider configuration */
  aiProviders: AiProviderInfo[];
  /** Targets derived from connection string env vars */
  derivedTargets: TargetConfig[];
  /** Human-readable source note per derived target name (for onboarding output). */
  derivedNotes: Record<string, string>;
  /** Vercel project config from .vercel/project.json */
  vercelProject?: { projectId: string; orgId: string };
  /** AWS RDS endpoint detection seen in connection-string env vars */
  awsDetection?: {
    /** Aurora cluster/proxy endpoints seen (not diagnosable this arc) */
    unsupportedEndpoints: Array<{ host: string; type: 'cluster' | 'proxy' }>;
    /** RDS instance endpoints seen while no AWS credentials were detected */
    uncredentialedHosts: string[];
  };
  /** Terraform state detection for the iac-drift agent */
  iacDetection?: IacDetection;
  /** Overall confidence in the profile */
  confidence: number;
}

export interface IacDetection {
  stateSource: 'local' | 's3-backend' | 'unsupported-backend' | 'none';
  /** Backend type name, only set when stateSource is 'unsupported-backend'. */
  backendType?: string;
  /** Managed types in local state with no CrisisMode agent, with counts. */
  unwatchableTypes: Record<string, number>;
}

/** Sub-resource types that describe an aspect of a watchable bucket rather
 *  than a distinct unwatched resource. */
const TF_SUBRESOURCE_TYPES = new Set(['aws_s3_bucket_versioning', 'aws_s3_bucket_lifecycle_configuration']);

/**
 * Derive an iac-drift target from Terraform state or config files in the
 * project directory. Stays fast and offline: S3-backend state is never
 * fetched here (the agent fetches it at check time) — only local state is
 * read to compute unwatchable-type counts.
 *
 * Missing AWS credentials do NOT suppress the derived target (unlike
 * deriveAwsRdsTargets) — local Terraform state is still readable without them.
 */
export async function deriveIacDetection(
  cwd: string,
): Promise<{ target: TargetConfig | null; note: string | null; iacDetection: IacDetection | null }> {
  const stateSource = await discoverStateSource(cwd);

  if (stateSource.kind === 'none') {
    const hasTfFiles = await readdir(cwd).then(
      (entries) => entries.some((f) => f.endsWith('.tf')),
      () => false,
    );
    if (!hasTfFiles) {
      return { target: null, note: null, iacDetection: null };
    }
  }

  const unwatchableTypes: Record<string, number> = {};
  if (stateSource.kind === 'local') {
    const raw = await readFile(stateSource.path, 'utf-8').catch(() => undefined);
    if (raw !== undefined) {
      const parsed = parseTfState(raw);
      if (parsed.ok) {
        for (const [type, count] of Object.entries(parsed.summary.resourceCounts)) {
          if (TF_SUBRESOURCE_TYPES.has(type) || type in WATCHABLE_TF_TYPES) continue;
          unwatchableTypes[type] = count;
        }
      }
    }
  }

  const iacDetection: IacDetection = {
    stateSource: stateSource.kind,
    ...(stateSource.kind === 'unsupported-backend' ? { backendType: stateSource.backendType } : {}),
    unwatchableTypes,
  };

  const target: TargetConfig = {
    name: 'derived-iac-drift',
    kind: 'iac-drift',
    primary: { host: 'auto', port: 0 },
    iac: { dir: cwd },
  };

  return { target, note: 'from Terraform files in this project', iacDetection };
}

export interface AppStackInfo {
  framework: string | null;
  language: string | null;
  hasDockerfile: boolean;
  hasCIConfig: boolean;
  dependencies: string[];
}

export interface EnvHint {
  name: string;
  present: boolean;
  kind: string;
  inferredService?: string | undefined;
}

export interface PlatformInfo {
  platform: string | null;
  detected: boolean;
  signals: string[];
}

export interface AiProviderInfo {
  provider: string;
  configured: boolean;
  envVar: string;
}

// ── Constants ──

/** Framework detection: dep name → framework label */
const FRAMEWORK_DEPS: Record<string, string> = {
  next: 'next',
  express: 'express',
  fastify: 'fastify',
  '@remix-run/node': 'remix',
  '@remix-run/react': 'remix',
  hono: 'hono',
  koa: 'koa',
  'nest': 'nest',
  '@nestjs/core': 'nest',
  nuxt: 'nuxt',
  'astro': 'astro',
  'svelte': 'svelte',
  '@sveltejs/kit': 'sveltekit',
};

/** Infrastructure dependencies we care about (from centralised registry) */
const INFRA_DEPS: string[] = INFRA_PKG_NAMES;

/** AI provider SDKs */
const AI_PROVIDER_DEPS: Record<string, string> = {
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  'cohere-ai': 'cohere',
  '@google/generative-ai': 'google',
  '@mistralai/mistralai': 'mistral',
  '@huggingface/inference': 'huggingface',
  'replicate': 'replicate',
};

/** Environment variables that hint at services */
const ENV_HINTS: Array<{ name: string; kind: string; inferredService?: string }> = [
  { name: 'DATABASE_URL', kind: 'database_url', inferredService: 'postgresql' },
  { name: 'POSTGRES_URL', kind: 'database_url', inferredService: 'postgresql' },
  { name: 'PG_CONNECTION_STRING', kind: 'database_url', inferredService: 'postgresql' },
  { name: 'PGHOST', kind: 'database_url', inferredService: 'postgresql' },
  { name: 'REDIS_URL', kind: 'redis_url', inferredService: 'redis' },
  { name: 'REDIS_TLS_URL', kind: 'redis_url', inferredService: 'redis' },
  { name: 'KAFKA_BROKERS', kind: 'kafka_url', inferredService: 'kafka' },
  { name: 'KAFKA_BOOTSTRAP_SERVERS', kind: 'kafka_url', inferredService: 'kafka' },
  { name: 'ETCD_ENDPOINTS', kind: 'etcd_url', inferredService: 'etcd' },
  { name: 'MONGODB_URI', kind: 'database_url', inferredService: 'mongodb' },
  { name: 'MONGO_URL', kind: 'database_url', inferredService: 'mongodb' },
  { name: 'MYSQL_URL', kind: 'database_url', inferredService: 'mysql' },
  { name: 'AMQP_URL', kind: 'queue_url', inferredService: 'rabbitmq' },
  { name: 'AWS_REGION', kind: 'aws_region' },
  { name: 'AWS_DEFAULT_REGION', kind: 'aws_region' },
  { name: 'AWS_PROFILE', kind: 'aws_profile' },
  { name: 'AWS_ACCESS_KEY_ID', kind: 'aws_credentials' },
];

/** Platform detection from env vars and config files */
const PLATFORM_ENV: Array<{ envVar: string; platform: string }> = [
  { envVar: 'VERCEL', platform: 'vercel' },
  { envVar: 'VERCEL_ENV', platform: 'vercel' },
  { envVar: 'FLY_APP_NAME', platform: 'fly' },
  { envVar: 'FLY_REGION', platform: 'fly' },
  { envVar: 'RENDER', platform: 'render' },
  { envVar: 'RENDER_SERVICE_NAME', platform: 'render' },
  { envVar: 'CF_PAGES', platform: 'cloudflare' },
  { envVar: 'RAILWAY_ENVIRONMENT', platform: 'railway' },
  { envVar: 'RAILWAY_SERVICE_NAME', platform: 'railway' },
  { envVar: 'HEROKU_APP_NAME', platform: 'heroku' },
  { envVar: 'DYNO', platform: 'heroku' },
  { envVar: 'AWS_LAMBDA_FUNCTION_NAME', platform: 'aws-lambda' },
  { envVar: 'AWS_EXECUTION_ENV', platform: 'aws' },
  { envVar: 'GOOGLE_CLOUD_PROJECT', platform: 'gcp' },
  { envVar: 'K_SERVICE', platform: 'cloud-run' },
];

const PLATFORM_FILES: Array<{ file: string; platform: string }> = [
  { file: '.vercel/project.json', platform: 'vercel' },
  { file: 'vercel.json', platform: 'vercel' },
  { file: 'fly.toml', platform: 'fly' },
  { file: 'render.yaml', platform: 'render' },
  { file: 'railway.json', platform: 'railway' },
  { file: 'Procfile', platform: 'heroku' },
  { file: 'app.yaml', platform: 'gcp' },
  { file: 'wrangler.toml', platform: 'cloudflare' },
  { file: 'serverless.yml', platform: 'serverless' },
  { file: 'serverless.yaml', platform: 'serverless' },
  { file: 'sam.yaml', platform: 'aws-sam' },
  { file: 'template.yaml', platform: 'aws-sam' },
];

// ── Connection string parsing ──

const PROTOCOL_MAP: Record<string, { kind: string; defaultPort: number }> = {
  'postgres:': { kind: 'postgresql', defaultPort: 5432 },
  'postgresql:': { kind: 'postgresql', defaultPort: 5432 },
  'redis:': { kind: 'redis', defaultPort: 6379 },
  'rediss:': { kind: 'redis', defaultPort: 6379 },
  'mongodb:': { kind: 'mongodb', defaultPort: 27017 },
  'mongodb+srv:': { kind: 'mongodb', defaultPort: 27017 },
  'mysql:': { kind: 'mysql', defaultPort: 3306 },
  'amqp:': { kind: 'rabbitmq', defaultPort: 5672 },
  'amqps:': { kind: 'rabbitmq', defaultPort: 5672 },
};

/**
 * Parse a connection string URL into structured connection info.
 * Returns null for malformed or unrecognised URLs.
 */
export function parseConnectionString(url: string): ParsedConnection | null {
  try {
    const parsed = new URL(url);
    const mapping = PROTOCOL_MAP[parsed.protocol];
    if (!mapping) return null;

    const host = parsed.hostname;
    if (!host) return null;

    const port = parsed.port ? Number(parsed.port) : mapping.defaultPort;
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const database = parsed.pathname.replace(/^\//, '') || undefined;

    return { kind: mapping.kind, host, port, username, password, database };
  } catch {
    return null;
  }
}

/**
 * Build TargetConfig entries from environment variable hints that contain
 * parseable connection strings. Deduplicates by kind+host+port.
 *
 * SECURITY: Never logs connection string values or credentials.
 */
export function buildTargetsFromEnvHints(hints: EnvHint[]): TargetConfig[] {
  const targets: TargetConfig[] = [];
  const seen = new Set<string>();

  for (const hint of hints) {
    if (!hint.present || !hint.inferredService) continue;

    const value = process.env[hint.name];
    if (!value) continue;

    const parsed = parseConnectionString(value);
    if (!parsed) continue;

    const dedupeKey = `${parsed.kind}:${parsed.host}:${parsed.port}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const target: TargetConfig = {
      name: `env-${hint.name.toLowerCase().replace(/_/g, '-')}`,
      kind: parsed.kind,
      primary: { host: parsed.host, port: parsed.port, ...(parsed.database !== undefined ? { database: parsed.database } : {}) },
    };

    if (parsed.username || parsed.password) {
      target.credentials = {
        type: 'value' as const,
        ...(parsed.username !== undefined ? { username: parsed.username } : {}),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      };
    }

    targets.push(target);
  }

  return targets;
}

/**
 * Derive targets for agents that need both a connection signal AND a matching
 * app dependency/file (gated derivation — keeps scans quiet on unrelated repos).
 *
 * SECURITY: notes contain env var NAMES and package names only, never values.
 */
export async function deriveGatedTargets(
  appStack: AppStackInfo,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ targets: TargetConfig[]; notes: Record<string, string> }> {
  const targets: TargetConfig[] = [];
  const notes: Record<string, string> = {};
  const deps = new Set(appStack.dependencies);

  // managed-database: parseable PG URL + a migration tool
  const pgEnvName = ['DATABASE_URL', 'POSTGRES_URL', 'PG_CONNECTION_STRING'].find((n) => env[n]);
  const migrationDep = ['prisma', '@prisma/client', 'drizzle-orm'].find((d) => deps.has(d));
  if (pgEnvName && migrationDep) {
    const parsed = parseConnectionString(env[pgEnvName]!);
    if (parsed && parsed.kind === 'postgresql') {
      const target: TargetConfig = {
        name: 'derived-managed-database',
        kind: 'managed-database',
        primary: { host: parsed.host, port: parsed.port, ...(parsed.database !== undefined ? { database: parsed.database } : {}) },
      };
      if (parsed.username || parsed.password) {
        target.credentials = { type: 'value' as const, ...(parsed.username !== undefined ? { username: parsed.username } : {}), ...(parsed.password !== undefined ? { password: parsed.password } : {}) };
      }
      targets.push(target);
      notes[target.name] = `from ${pgEnvName} + ${migrationDep}`;
    }
  }

  // message-queue: parseable redis URL + bullmq/bull
  const redisEnvName = ['REDIS_URL', 'REDIS_TLS_URL'].find((n) => env[n]);
  const queueDep = ['bullmq', 'bull'].find((d) => deps.has(d));
  if (redisEnvName && queueDep) {
    const raw = env[redisEnvName]!;
    const parsed = parseConnectionString(raw);
    if (parsed && parsed.kind === 'redis') {
      const target: TargetConfig = {
        name: 'derived-message-queue',
        kind: 'message-queue',
        primary: { host: parsed.host, port: parsed.port },
        queue: { tls: raw.startsWith('rediss:') },
      };
      if (parsed.username || parsed.password) {
        target.credentials = { type: 'value' as const, ...(parsed.username !== undefined ? { username: parsed.username } : {}), ...(parsed.password !== undefined ? { password: parsed.password } : {}) };
      }
      targets.push(target);
      notes[target.name] = `from ${redisEnvName} + ${queueDep}`;
    }
  }

  // ai-provider: an API key present OR an AI SDK dependency
  const aiKeyName = AI_ENV_VARS.find((v) => env[v.envVar] !== undefined)?.envVar;
  const aiDep = appStack.dependencies.find((d) => d in AI_PROVIDER_DEPS);
  if (aiKeyName || aiDep) {
    const target: TargetConfig = {
      name: 'derived-ai-provider',
      kind: 'ai-provider',
      primary: { host: 'auto', port: 0 },
    };
    targets.push(target);
    notes[target.name] = aiKeyName ? `from ${aiKeyName}` : `from ${aiDep} dependency`;
  }

  // application-config: an env template file exists
  const envExample = await findEnvExample(cwd);
  if (envExample) {
    const target: TargetConfig = {
      name: 'derived-application-config',
      kind: 'application-config',
      primary: { host: 'auto', port: 0 },
    };
    targets.push(target);
    notes[target.name] = `from ${envExample.split('/').pop()}`;
  }

  return { targets, notes };
}

/**
 * Derive aws-rds control-plane targets from RDS endpoints found in
 * connection-string env vars. Aurora/proxy endpoints and endpoints seen
 * without AWS credentials are recorded for visibility instead of targeted.
 * SECURITY: never logs connection-string values.
 */
export function deriveAwsRdsTargets(
  hints: EnvHint[],
  env: NodeJS.ProcessEnv,
  hasAwsCredentials: boolean,
): { targets: TargetConfig[]; notes: Record<string, string>; awsDetection: NonNullable<StackProfile['awsDetection']> } {
  const targets: TargetConfig[] = [];
  const notes: Record<string, string> = {};
  const awsDetection: NonNullable<StackProfile['awsDetection']> = {
    unsupportedEndpoints: [],
    uncredentialedHosts: [],
  };
  const seen = new Set<string>();

  for (const hint of hints) {
    if (!hint.present || hint.kind !== 'database_url') continue;
    const value = env[hint.name];
    if (!value) continue;
    const conn = parseConnectionString(value);
    if (!conn) continue;
    const endpoint = parseRdsEndpoint(conn.host);
    if (!endpoint || seen.has(endpoint.host)) continue;
    seen.add(endpoint.host);

    if (endpoint.type !== 'instance') {
      awsDetection.unsupportedEndpoints.push({ host: endpoint.host, type: endpoint.type });
      continue;
    }
    if (!hasAwsCredentials) {
      awsDetection.uncredentialedHosts.push(endpoint.host);
      continue;
    }
    // RDS instance identifiers are only unique within a region — region-scope
    // the target name so AgentRegistry (which resolves targets by name)
    // never collides two same-named instances from different regions.
    const name = `rds-${endpoint.region}-${endpoint.instanceId}`;
    targets.push({
      name,
      kind: 'aws-rds',
      aws: { region: endpoint.region, instanceId: endpoint.instanceId! },
    });
    notes[name] = `from ${hint.name} endpoint`;
  }
  return { targets, notes, awsDetection };
}

/**
 * Read .vercel/project.json and extract projectId + orgId.
 * Returns null if the file is missing or malformed.
 */
export function readVercelProjectConfig(cwd: string): { projectId: string; orgId: string } | null {
  try {
    const raw = readFileSync(join(cwd, '.vercel', 'project.json'), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const projectId = data.projectId;
    const orgId = data.orgId;
    if (typeof projectId !== 'string' || typeof orgId !== 'string') return null;
    return { projectId, orgId };
  } catch {
    return null;
  }
}

// ── Discovery ──

/**
 * Build a complete stack profile by combining port probing, package.json
 * inspection, environment variable scanning, and platform detection.
 *
 * All inspections run in parallel and are individually fault-tolerant.
 */
export async function discoverStack(): Promise<StackProfile> {
  const cwd = process.cwd();

  const [services, appStack, platform] = await Promise.all([
    detectServices(),
    inspectAppStack(cwd),
    detectPlatform(cwd),
  ]);

  const envHints = scanEnvHints();
  const aiProviders = detectAiProviders(appStack);
  const gated = await deriveGatedTargets(appStack, cwd);
  const hasAwsCreds = envHints.some((h) => h.present && (h.kind === 'aws_credentials' || h.kind === 'aws_profile'));
  const rds = deriveAwsRdsTargets(envHints, process.env, hasAwsCreds);
  const iac = await deriveIacDetection(cwd);
  const derivedTargets = [...buildTargetsFromEnvHints(envHints), ...gated.targets, ...rds.targets, ...(iac.target ? [iac.target] : [])];
  const derivedNotes = { ...gated.notes, ...rds.notes, ...(iac.target && iac.note ? { [iac.target.name]: iac.note } : {}) };
  const vercelProject = readVercelProjectConfig(cwd);

  const confidence = computeConfidence(services, appStack, envHints, platform);

  return {
    services,
    appStack,
    envHints,
    platform,
    aiProviders,
    derivedTargets,
    derivedNotes,
    ...(vercelProject ? { vercelProject } : {}),
    awsDetection: rds.awsDetection,
    ...(iac.iacDetection ? { iacDetection: iac.iacDetection } : {}),
    confidence,
  };
}

// ── Package.json inspection ──

async function inspectAppStack(cwd: string): Promise<AppStackInfo> {
  const result: AppStackInfo = {
    framework: null,
    language: null,
    hasDockerfile: false,
    hasCIConfig: false,
    dependencies: [],
  };

  // Check for Dockerfile
  result.hasDockerfile = await fileExists(join(cwd, 'Dockerfile'));

  // Check for CI config
  result.hasCIConfig = await fileExists(join(cwd, '.github', 'workflows'));

  // Read package.json
  const pkgJson = await readJsonSafe(join(cwd, 'package.json'));
  if (!pkgJson) {
    // Try detecting other languages
    if (await fileExists(join(cwd, 'requirements.txt')) || await fileExists(join(cwd, 'pyproject.toml'))) {
      result.language = 'python';
    } else if (await fileExists(join(cwd, 'go.mod'))) {
      result.language = 'go';
    } else if (await fileExists(join(cwd, 'Cargo.toml'))) {
      result.language = 'rust';
    }
    return result;
  }

  // Determine language
  const allDeps = {
    ...asRecord(pkgJson.dependencies),
    ...asRecord(pkgJson.devDependencies),
  };

  result.language = allDeps.typescript || allDeps['ts-node'] ? 'typescript' : 'javascript';

  // Detect framework
  for (const [dep, framework] of Object.entries(FRAMEWORK_DEPS)) {
    if (dep in allDeps) {
      result.framework = framework;
      break;
    }
  }

  // Collect infra dependencies
  for (const dep of INFRA_DEPS) {
    if (dep in allDeps) {
      result.dependencies.push(dep);
    }
  }

  // Collect AI SDK dependencies
  for (const dep of Object.keys(AI_PROVIDER_DEPS)) {
    if (dep in allDeps) {
      result.dependencies.push(dep);
    }
  }

  return result;
}

// ── Environment variable scanning ──

function scanEnvHints(): EnvHint[] {
  return ENV_HINTS.map((hint) => ({
    name: hint.name,
    present: process.env[hint.name] !== undefined,
    kind: hint.kind,
    inferredService: hint.inferredService,
  }));
}

// ── AI provider detection ──

function detectAiProviders(appStack: AppStackInfo): AiProviderInfo[] {
  const providers: AiProviderInfo[] = [];

  for (const { envVar, provider } of AI_ENV_VARS) {
    const fromDep = appStack.dependencies.some((d) => AI_PROVIDER_DEPS[d] === provider);
    const fromEnv = process.env[envVar] !== undefined;

    if (fromDep || fromEnv) {
      providers.push({
        provider,
        configured: fromEnv,
        envVar,
      });
    }
  }

  return providers;
}

// ── Platform detection ──

async function detectPlatform(cwd: string): Promise<PlatformInfo> {
  const signals: string[] = [];
  let platform: string | null = null;

  // Check environment variables
  for (const { envVar, platform: p } of PLATFORM_ENV) {
    if (process.env[envVar] !== undefined) {
      signals.push(`env:${envVar}`);
      if (!platform) platform = p;
    }
  }

  // Check config files
  const fileChecks = await Promise.all(
    PLATFORM_FILES.map(async ({ file, platform: p }) => ({
      file,
      platform: p,
      exists: await fileExists(join(cwd, file)),
    })),
  );

  for (const check of fileChecks) {
    if (check.exists) {
      signals.push(`file:${check.file}`);
      if (!platform) platform = check.platform;
    }
  }

  return {
    platform,
    detected: platform !== null,
    signals,
  };
}

// ── Confidence scoring ──

function computeConfidence(
  services: DetectedService[],
  appStack: AppStackInfo,
  envHints: EnvHint[],
  platform: PlatformInfo,
): number {
  let score = 0;
  let maxScore = 0;

  // Port probing: each detected service adds confidence
  const detectedServices = services.filter((s) => s.detected);
  maxScore += 3;
  score += Math.min(detectedServices.length, 3);

  // Package.json found and has deps
  maxScore += 2;
  if (appStack.language) score += 1;
  if (appStack.dependencies.length > 0) score += 1;

  // Env hints present
  const presentHints = envHints.filter((h) => h.present);
  maxScore += 2;
  score += Math.min(presentHints.length, 2);

  // Platform detected
  maxScore += 1;
  if (platform.detected) score += 1;

  return maxScore > 0 ? Math.round((score / maxScore) * 100) / 100 : 0;
}

// ── Pretty printing ──

/**
 * Pretty-print a stack profile to the terminal.
 */
export function printStackProfile(profile: StackProfile): void {
  console.log('');
  console.log(chalk.bold('  Stack Profile') + chalk.dim(` (${(profile.confidence * 100).toFixed(0)}% confidence)`));
  console.log('');

  // Services
  const detected = profile.services.filter((s) => s.detected);
  if (detected.length > 0) {
    console.log(chalk.bold('  Services:'));
    for (const s of detected) {
      console.log(chalk.green(`    + ${s.kind}`) + chalk.dim(` at ${s.host}:${s.port}`));
    }
  } else {
    console.log(chalk.dim('  Services: none detected via port probing'));
  }

  // App stack
  console.log('');
  console.log(chalk.bold('  App Stack:'));
  if (profile.appStack.language) {
    console.log(chalk.dim(`    Language:   ${profile.appStack.language}`));
  }
  if (profile.appStack.framework) {
    console.log(chalk.dim(`    Framework:  ${profile.appStack.framework}`));
  }
  if (profile.appStack.hasDockerfile) {
    console.log(chalk.dim('    Docker:     yes'));
  }
  if (profile.appStack.hasCIConfig) {
    console.log(chalk.dim('    CI:         yes'));
  }
  if (profile.appStack.dependencies.length > 0) {
    console.log(chalk.dim(`    Deps:       ${profile.appStack.dependencies.join(', ')}`));
  }

  // Environment hints
  const presentHints = profile.envHints.filter((h) => h.present);
  if (presentHints.length > 0) {
    console.log('');
    console.log(chalk.bold('  Environment Hints:'));
    for (const hint of presentHints) {
      const service = hint.inferredService ? chalk.cyan(` -> ${hint.inferredService}`) : '';
      console.log(chalk.dim(`    ${hint.name}`) + service);
    }
  }

  // Platform
  if (profile.platform.detected) {
    console.log('');
    console.log(chalk.bold('  Platform: ') + chalk.cyan(profile.platform.platform!));
    if (profile.platform.signals.length > 0) {
      console.log(chalk.dim(`    Signals: ${profile.platform.signals.join(', ')}`));
    }
  }

  // AI providers
  if (profile.aiProviders.length > 0) {
    console.log('');
    console.log(chalk.bold('  AI Providers:'));
    for (const p of profile.aiProviders) {
      const status = p.configured
        ? chalk.green('configured')
        : chalk.yellow('SDK found, key not set');
      console.log(chalk.dim(`    ${p.provider}: `) + status);
    }
  }

  console.log('');
}

/**
 * Print a first-run onboarding message when no config file exists
 * and services were detected. Only prints in human output mode.
 */
export function printOnboardingMessage(profile: StackProfile, _configSource: string): void {
  // Only show when there's something meaningful to report
  const detected = profile.services.filter((s) => s.detected);
  if (detected.length === 0 && profile.derivedTargets.length === 0) return;

  // Only in TTY / human mode
  if (!process.stdout.isTTY) return;

  console.log('');
  console.log(chalk.bold('  Welcome to CrisisMode!'));
  console.log('');
  console.log(chalk.bold('  Detected:'));

  for (const target of profile.derivedTargets) {
    const note = profile.derivedNotes[target.name];
    if (note) {
      console.log(chalk.green(`    + ${target.kind}`) + chalk.dim(` (${note})`));
      continue;
    }
    const envName = target.name.replace(/^env-/, '').replace(/-/g, '_').toUpperCase();
    const host = target.primary ? `${target.primary.host}:${target.primary.port}` : 'unknown';
    console.log(chalk.green(`    + ${target.kind}`) + chalk.dim(` at ${host} (from ${envName})`));
  }

  for (const s of detected) {
    // Skip services already covered by derived targets
    const coveredByEnv = profile.derivedTargets.some((t) => t.kind === s.kind);
    if (!coveredByEnv) {
      console.log(chalk.green(`    + ${s.kind}`) + chalk.dim(` at ${s.host}:${s.port}`));
    }
  }

  if (profile.platform.detected) {
    const vercelInfo = profile.vercelProject ? ` (project: ${profile.vercelProject.projectId})` : '';
    console.log(chalk.green(`    + Platform: ${profile.platform.platform}`) + chalk.dim(vercelInfo));
  }

  console.log('');
  console.log(chalk.dim('  Running health checks now. Save config: crisismode init'));
  console.log('');
}

// ── Helpers ──

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
