// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode demo` — run the simulator demo.
 */

import { runDemo } from '../../demo/runner.js';

export async function runDemoCommand(): Promise<void> {
  await runDemo();
}
