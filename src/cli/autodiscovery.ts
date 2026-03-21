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

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { detectServices } from './detect.js';
import type { DetectedService } from './detect.js';
import { INFRA_PKG_NAMES } from '../config/service-registry.js';

// ── Types ──

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
  /** Overall confidence in the profile */
  confidence: number;
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
  inferredService?: string;
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
];

/** AI provider env vars */
const AI_ENV_VARS: Array<{ envVar: string; provider: string }> = [
  { envVar: 'OPENAI_API_KEY', provider: 'openai' },
  { envVar: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { envVar: 'COHERE_API_KEY', provider: 'cohere' },
  { envVar: 'GOOGLE_AI_API_KEY', provider: 'google' },
  { envVar: 'MISTRAL_API_KEY', provider: 'mistral' },
  { envVar: 'REPLICATE_API_TOKEN', provider: 'replicate' },
  { envVar: 'HUGGINGFACE_API_KEY', provider: 'huggingface' },
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

  const confidence = computeConfidence(services, appStack, envHints, platform);

  return {
    services,
    appStack,
    envHints,
    platform,
    aiProviders,
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
