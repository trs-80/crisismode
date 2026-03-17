// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Actionable CLI error messages — wraps common failure modes with
 * context and suggestions so users know exactly what to do next.
 */

export class CrisisModeError extends Error {
  readonly suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = 'CrisisModeError';
    this.suggestion = suggestion;
  }
}

const SUPPORTED_KINDS = [
  'postgresql', 'redis', 'etcd', 'kafka', 'kubernetes', 'ceph', 'flink',
  'application', 'ai-provider', 'managed-database', 'message-queue', 'application-config',
];

export function connectionRefused(kind: string, host: string, port: number): CrisisModeError {
  const hints: Record<string, string> = {
    postgresql: `Is PostgreSQL running? Try: docker run -d -p ${port}:5432 -e POSTGRES_PASSWORD=secret postgres:16`,
    redis: `Is Redis running? Try: docker run -d -p ${port}:6379 redis:7`,
    etcd: `Is etcd running? Try: docker run -d -p ${port}:2379 quay.io/coreos/etcd:v3.5.0`,
    kafka: `Is Kafka running? Try: docker run -d -p ${port}:9092 apache/kafka:3.7.0`,
  };

  return new CrisisModeError(
    `Connection refused: ${host}:${port} (${kind})`,
    hints[kind] ?? `Ensure ${kind} is running on ${host}:${port}`,
  );
}

export function noConfig(): CrisisModeError {
  return new CrisisModeError(
    'No configuration found and no services detected on localhost',
    'Run `crisismode init` to generate crisismode.yaml, or start a database first.',
  );
}

export function missingEnvVar(name: string, purpose: string): CrisisModeError {
  return new CrisisModeError(
    `Missing environment variable: ${name}`,
    `Set ${name}: export ${name}=<value>  (${purpose})`,
  );
}

export function agentNotFound(kind: string): CrisisModeError {
  return new CrisisModeError(
    `No agent handles "${kind}"`,
    `Supported systems: ${SUPPORTED_KINDS.join(', ')}`,
  );
}

export function formatError(err: unknown): string {
  if (err instanceof CrisisModeError) {
    return `Error: ${err.message}\n  Suggestion: ${err.suggestion}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
