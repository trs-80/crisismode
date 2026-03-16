// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode status` — quick health probe of configured or detected targets.
 */

import { detectServices } from '../detect.js';
import { printStatus, printBanner, printInfo } from '../output.js';
import { noConfig, formatError } from '../errors.js';
import { loadConfigWithDetection } from '../../config/loader.js';

export async function runStatus(): Promise<void> {
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
    return;
  }

  printInfo(`Config: ${source === 'file' ? 'crisismode.yaml' : source}`);
  console.log('');

  const results = await Promise.all(
    config.targets.map(async (target) => {
      const services = await detectServices(target.primary.host, [
        { kind: target.kind, port: target.primary.port },
      ]);
      const isUp = services[0]?.detected ?? false;
      return {
        kind: target.kind,
        host: target.primary.host,
        port: target.primary.port,
        status: isUp ? 'up' as const : 'down' as const,
      };
    }),
  );

  printStatus(results);
}
