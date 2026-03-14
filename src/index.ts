// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { runDemo } from './demo/runner.js';

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
