#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CrisisMode CLI — unified entry point for all commands.
 *
 * Usage:
 *   crisismode                              # zero-config health scan (default)
 *   crisismode scan                         # explicit health scan
 *   crisismode diagnose                     # health check + diagnosis (read-only)
 *   crisismode recover                      # full recovery (dry-run default)
 *   crisismode status                       # quick health probe
 *   crisismode init                         # generate crisismode.yaml
 *   crisismode demo                         # run simulator demo
 *   crisismode webhook                      # start webhook receiver
 *   crisismode ask "my postgres is slow"    # AI-powered diagnosis
 *   crisismode watch                        # continuous shadow observation
 *
 * Routing lives in run.ts; this file is the process boundary. It is the ONE
 * place the CLI turns a command's returned `ExitCode` into `process.exitCode`
 * — `process.exit()` is not used anywhere in `src/cli/**`, so buffered stdout
 * is never truncated mid-write.
 */

import { runCliSafely } from './run.js';

runCliSafely(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
