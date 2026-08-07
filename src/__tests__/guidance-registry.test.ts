// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import type { RemediationGuide } from '../types/remediation-guide.js';

describe('RemediationGuide type', () => {
  it('accepts a guide with every field populated', () => {
    const guide: RemediationGuide = {
      id: 'example-guide',
      platform: 'example-console',
      title: 'Do the thing',
      applicableFindingTypes: ['example.check'],
      url: 'https://example.com/console',
      consoleSteps: ['Open the console.', 'Click the button.'],
      cliEquivalent: 'example-cli do-the-thing',
      expectedAfter: 'The thing is done.',
      caution: 'The thing cannot be undone.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.consoleSteps).toHaveLength(2);
  });

  it('accepts a guide with only the required fields', () => {
    const guide: RemediationGuide = {
      id: 'minimal-guide',
      platform: 'example-console',
      title: 'Minimal',
      applicableFindingTypes: ['example.check'],
      consoleSteps: ['Open the console.'],
      expectedAfter: 'Something observable happened.',
      verifiedOn: '2026-08-05',
    };
    expect(guide.url).toBeUndefined();
  });
});
