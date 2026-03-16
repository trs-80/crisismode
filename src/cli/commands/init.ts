// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode init` — generate a starter crisismode.yaml.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateTemplate } from '../../config/init.js';
import { printSuccess, printInfo } from '../output.js';

export async function runInit(outputPath?: string): Promise<void> {
  const targetPath = resolve(outputPath || 'crisismode.yaml');

  if (existsSync(targetPath)) {
    throw new Error(`File already exists: ${targetPath}\nRemove it first or specify a different path: crisismode init other.yaml`);
  }

  writeFileSync(targetPath, generateTemplate(), 'utf-8');
  printSuccess(`Created ${targetPath}`);
  console.log('');
  printInfo('Next steps:');
  printInfo('  1. Edit crisismode.yaml with your infrastructure details');
  printInfo('  2. Set environment variables for credentials');
  printInfo('  3. Run: crisismode diagnose');
}
