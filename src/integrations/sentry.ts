// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Sentry integration stub.
 *
 * Implements ErrorTrackingIntegration for Sentry error tracking.
 * Currently a stub — methods throw with a helpful message indicating
 * they are not yet functional.
 *
 * To use: set the SENTRY_DSN environment variable or pass a DSN
 * to the constructor.
 */

import type { ErrorTrackingIntegration, ErrorEvent, ErrorSpikeInfo } from './index.js';

export class SentryIntegration implements ErrorTrackingIntegration {
  name = 'sentry';
  connected = false;

  private dsn: string | undefined;

  constructor(options?: { dsn?: string }) {
    this.dsn = options?.dsn ?? process.env.SENTRY_DSN;
  }

  async connect(): Promise<void> {
    if (!this.dsn) {
      throw new Error(
        'SENTRY_DSN required. Set the SENTRY_DSN environment variable or pass a DSN to the constructor.',
      );
    }
    // In the future: validate the DSN and authenticate with the Sentry API
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getRecentErrors(_since: string, _limit: number): Promise<ErrorEvent[]> {
    this.assertConnected();
    throw new Error(
      'SentryIntegration.getRecentErrors() is not yet implemented. ' +
      'This will query the Sentry API for recent error events.',
    );
  }

  async getErrorSpike(): Promise<ErrorSpikeInfo | null> {
    this.assertConnected();
    throw new Error(
      'SentryIntegration.getErrorSpike() is not yet implemented. ' +
      'This will analyze error rates from Sentry to detect spikes.',
    );
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('SentryIntegration is not connected. Call connect() first.');
    }
  }
}
