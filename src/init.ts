// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Entry point for `pnpm run init` — generates a starter crisismode.yaml.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateTemplate } from './config/init.js';

const outputPath = process.argv[2] || 'crisismode.yaml';
const targetPath = resolve(outputPath);

if (existsSync(targetPath)) {
  console.error(`❌ File already exists: ${targetPath}`);
  console.error('   Remove it first or specify a different path: pnpm run init -- other.yaml');
  process.exit(1);
}

writeFileSync(targetPath, generateTemplate(), 'utf-8');
console.log(`✅ Created ${targetPath}`);
console.log('');
console.log('Next steps:');
console.log('  1. Edit crisismode.yaml with your infrastructure details');
console.log('  2. Set environment variables for credentials (PG_USER, PG_PASSWORD, etc.)');
console.log('  3. Run: pnpm run live');
