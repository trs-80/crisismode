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
import { ExitCode } from './exit-codes.js';

runCliSafely(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  // `runCliSafely` already classifies everything `runCli` throws, but its own
  // catch block has to report the error, and reporting can fail: stderr may
  // be closed (`crisismode scan | head` is a normal thing an operator does,
  // and yields EPIPE). Without this handler that rejection is unhandled,
  // Node prints its own trace, and `process.exitCode` is never assigned — so
  // a genuine failure could exit 0. The boundary has to be total.
  .catch(() => {
    process.exitCode = ExitCode.INTERNAL;
  });
