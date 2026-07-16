// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Characterization tests for status → presentation mappings across the three
 * rendering surfaces (CLI output, demo display, Slack notifications). Written
 * against the pre-consolidation behavior; the consolidation must keep every
 * assertion green byte-for-byte.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { configure, printHealthStatus } from '../cli/output.js';
import { displayHealthAssessment } from '../demo/display.js';
import { formatSlackNotification } from '../framework/notification-formatters.js';
import type { HealthAssessment, HealthStatus, HealthSignalStatus } from '../types/health.js';

const HEALTH_STATUSES: HealthStatus[] = ['healthy', 'recovering', 'unhealthy', 'unknown'];
const SIGNAL_STATUSES: HealthSignalStatus[] = ['healthy', 'warning', 'critical', 'unknown'];

function makeAssessment(status: HealthStatus, signalStatus: HealthSignalStatus): HealthAssessment {
  return {
    status,
    confidence: 0.9,
    summary: `status ${status}`,
    observedAt: '2026-07-16T00:00:00.000Z',
    signals: [
      {
        source: 'test-signal',
        status: signalStatus,
        detail: `signal ${signalStatus}`,
        observedAt: '2026-07-16T00:00:00.000Z',
      },
    ],
    recommendedActions: [],
  };
}

describe('status presentation characterization', () => {
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let savedLevel: typeof chalk.level;

  beforeEach(() => {
    savedLevel = chalk.level;
    configure({ json: false, noColor: false, mode: 'human' });
    chalk.level = 1; // force ANSI (after configure, which zeroes it off-TTY)
    lines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    chalk.level = savedLevel;
  });

  const ANSI = {
    green: '[32m',
    yellow: '[33m',
    red: '[31m',
    dim: '[2m',
  };

  const HEALTH_COLOR: Record<HealthStatus, string> = {
    healthy: ANSI.green,
    recovering: ANSI.yellow,
    unhealthy: ANSI.red,
    unknown: ANSI.dim,
  };

  const SIGNAL_COLOR: Record<HealthSignalStatus, string> = {
    healthy: ANSI.green,
    warning: ANSI.yellow,
    critical: ANSI.red,
    unknown: ANSI.dim,
  };

  describe('cli printHealthStatus (human mode)', () => {
    for (const status of HEALTH_STATUSES) {
      it(`colors health status '${status}' correctly`, () => {
        printHealthStatus(makeAssessment(status, 'healthy'));
        const statusLine = lines.find((l) => l.includes('Health: '));
        expect(statusLine).toBeDefined();
        expect(statusLine).toContain(HEALTH_COLOR[status] + status);
      });
    }

    for (const signalStatus of SIGNAL_STATUSES) {
      it(`colors signal status '${signalStatus}' correctly`, () => {
        printHealthStatus(makeAssessment('healthy', signalStatus));
        const signalLine = lines.find((l) => l.includes(`[${signalStatus.toUpperCase()}]`));
        expect(signalLine).toBeDefined();
        expect(signalLine).toContain(SIGNAL_COLOR[signalStatus]);
      });
    }
  });

  describe('demo displayHealthAssessment', () => {
    for (const status of HEALTH_STATUSES) {
      it(`colors health status '${status}' correctly`, () => {
        displayHealthAssessment(makeAssessment(status, 'healthy'));
        const statusLine = lines.find((l) => l.includes('State:'));
        expect(statusLine).toBeDefined();
        expect(statusLine).toContain(HEALTH_COLOR[status] + status);
      });
    }

    for (const signalStatus of SIGNAL_STATUSES) {
      it(`colors signal status '${signalStatus}' correctly`, () => {
        displayHealthAssessment(makeAssessment('healthy', signalStatus));
        const signalLine = lines.find((l) => l.includes(`[${signalStatus.toUpperCase()}]`));
        expect(signalLine).toBeDefined();
        expect(signalLine).toContain(SIGNAL_COLOR[signalStatus]);
      });
    }
  });

  describe('slack formatSlackNotification', () => {
    const EXPECTED: Record<HealthStatus, { emoji: string; label: string }> = {
      healthy: { emoji: ':white_check_mark:', label: 'Healthy' },
      recovering: { emoji: ':large_orange_diamond:', label: 'Recovering' },
      unhealthy: { emoji: ':red_circle:', label: 'Unhealthy' },
      unknown: { emoji: ':question:', label: 'Unknown' },
    };

    for (const status of HEALTH_STATUSES) {
      it(`uses the canonical emoji and label for '${status}'`, () => {
        const notification = formatSlackNotification({ health: makeAssessment(status, 'healthy') });
        const header = JSON.stringify(notification.blocks[0]);
        expect(header).toContain(EXPECTED[status].emoji);
        expect(header).toContain(EXPECTED[status].label);
      });
    }
  });
});
