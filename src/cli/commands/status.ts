// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode status` — quick health probe of configured or detected targets.
 */

import { detectServices } from '../detect.js';
import { printStatus, printBanner, printInfo } from '../output.js';
import { noConfig } from '../errors.js';
import { loadConfigWithDetection } from '../../config/loader.js';
import { severityExitCode } from '../status-presentation.js';
import { ExitCode } from '../exit-codes.js';
import type { HealthStatus } from '../../types/health.js';

/**
 * A probe result -> the HealthStatus the exit code is derived from, so
 * `status` speaks the same status vocabulary as `scan`/`diagnose` instead of
 * inventing a second up/down exit table. Raw detection (no config) can only
 * report what it found, so an undetected service there is `unknown`
 * ("nothing listening that we know to look for"), not `unhealthy`.
 */
function probeStatus(isUp: boolean): HealthStatus {
  return isUp ? 'healthy' : 'unhealthy';
}

export async function runStatus(): Promise<ExitCode> {
  printBanner();

  const { config, source } = loadConfigWithDetection();

  if (!config) {
    // Fall back to raw detection
    const services = await detectServices();
    const detected = services.filter((s) => s.detected);

    if (detected.length === 0) {
      throw noConfig();
    }

    printStatus(detected.map((s) => ({
      kind: s.kind,
      host: s.host,
      port: s.port,
      status: 'up' as const,
    })));
    return ExitCode.OK;
  }

  printInfo(`Config: ${source === 'file' ? 'crisismode.yaml' : source}`);
  console.log('');

  const results = await Promise.all(
    config.targets.filter((t) => t.primary).map(async (target) => {
      const services = await detectServices(target.primary!.host, [
        { kind: target.kind, port: target.primary!.port },
      ]);
      const isUp = services[0]?.detected ?? false;
      return {
        kind: target.kind,
        host: target.primary!.host,
        port: target.primary!.port,
        status: isUp ? 'up' as const : 'down' as const,
      };
    }),
  );

  printStatus(results);

  // C8a: `status` is documented as a "quick health probe" and never set an
  // exit code, so `crisismode status && deploy` deployed onto a dead
  // database. A configured target that is not listening is unhealthy.
  return severityExitCode(results.map((r) => probeStatus(r.status === 'up')));
}
