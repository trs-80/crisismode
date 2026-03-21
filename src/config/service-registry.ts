// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Centralised mapping of npm packages to infrastructure services.
 *
 * This is the single source of truth consumed by autodiscovery (package.json scanning),
 * symptom routing (dependency-based confidence boosting), and signal collection
 * (dependency-without-config warnings).
 */

export interface InfraDep {
  /** npm package name */
  pkg: string;
  /** Infrastructure service kind (matches agent registry kinds) */
  service: string;
}

/**
 * All known npm packages that imply an infrastructure dependency.
 * Ordered by service for readability.
 */
export const INFRA_DEPS: InfraDep[] = [
  // PostgreSQL
  { pkg: 'pg', service: 'postgresql' },
  { pkg: 'postgres', service: 'postgresql' },
  { pkg: '@prisma/client', service: 'postgresql' },
  { pkg: 'drizzle-orm', service: 'postgresql' },
  { pkg: 'knex', service: 'postgresql' },
  { pkg: 'typeorm', service: 'postgresql' },
  { pkg: 'sequelize', service: 'postgresql' },

  // Redis
  { pkg: 'ioredis', service: 'redis' },
  { pkg: 'redis', service: 'redis' },
  { pkg: 'bullmq', service: 'redis' },
  { pkg: 'bull', service: 'redis' },

  // Kafka
  { pkg: 'kafkajs', service: 'kafka' },
  { pkg: '@confluentinc/kafka-javascript', service: 'kafka' },

  // AMQP / RabbitMQ
  { pkg: 'amqplib', service: 'amqp' },
  { pkg: 'rhea', service: 'amqp' },

  // Kubernetes
  { pkg: '@kubernetes/client-node', service: 'kubernetes' },

  // etcd
  { pkg: 'etcd3', service: 'etcd' },

  // MongoDB
  { pkg: 'mongoose', service: 'mongodb' },
  { pkg: 'mongodb', service: 'mongodb' },

  // MySQL / MariaDB
  { pkg: 'mysql2', service: 'mysql' },
  { pkg: 'mariadb', service: 'mysql' },

  // Cassandra
  { pkg: 'cassandra-driver', service: 'cassandra' },
];

/** All known infrastructure package names (for quick membership checks). */
export const INFRA_PKG_NAMES: string[] = INFRA_DEPS.map((d) => d.pkg);

/** Map from package name to service kind. */
export const PKG_TO_SERVICE: Record<string, string> = Object.fromEntries(
  INFRA_DEPS.map((d) => [d.pkg, d.service]),
);

/** Get all package names for a given service kind. */
export function pkgsForService(service: string): string[] {
  return INFRA_DEPS.filter((d) => d.service === service).map((d) => d.pkg);
}
