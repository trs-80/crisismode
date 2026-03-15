// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Generates a starter crisismode.yaml template.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE = `# CrisisMode Site Configuration
# Documentation: https://github.com/trs-80/crisismode

apiVersion: crisismode/v1
kind: SiteConfig

metadata:
  name: my-site
  environment: development  # production | staging | development

# Hub connection (optional — for multi-spoke coordination)
# hub:
#   endpoint: https://hub.crisismode.ai
#   credentials:
#     type: env
#     key: HUB_BOOTSTRAP_TOKEN

# Webhook receiver settings
webhook:
  port: 3000
  # secret:
  #   type: env
  #   key: WEBHOOK_SECRET

# Default execution mode
execution:
  mode: dry-run  # dry-run | execute

# Infrastructure targets
targets:
  - name: main-postgres
    kind: postgresql
    primary:
      host: localhost
      port: 5432
      database: myapp
    replicas:
      - host: localhost
        port: 5433
    credentials:
      type: env
      username: PG_USER
      password: PG_PASSWORD

  # Uncomment to add a Redis target:
  # - name: cache-redis
  #   kind: redis
  #   primary:
  #     host: localhost
  #     port: 6379
  #   credentials:
  #     type: env
  #     password: REDIS_PASSWORD
`;

export function generateTemplate(): string {
  return TEMPLATE;
}

export function writeTemplate(outputPath?: string): string {
  const targetPath = resolve(outputPath || 'crisismode.yaml');

  if (existsSync(targetPath)) {
    throw new Error(`File already exists: ${targetPath}\nUse a different path or remove the existing file.`);
  }

  // We return the path but let the caller do the actual write
  // to avoid importing fs.writeFileSync in the template module
  return targetPath;
}
