// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import { LLM_PROVIDER_CHECK_IDS as ReExported } from '../agent/llm-provider/backend.js';
import type { HealthSignal } from '../types/health.js';
import type { DiagnosisFinding } from '../types/diagnosis-result.js';

describe('llm-provider check ids', () => {
  it('pins the six stable check ids consumed by the guidance registry', () => {
    expect(LLM_PROVIDER_CHECK_IDS).toEqual({
      keyPresent: 'llm-provider.key_present',
      keyValid: 'llm-provider.key_valid',
      quotaBilling: 'llm-provider.quota_billing',
      rateLimitHeadroom: 'llm-provider.rate_limit_headroom',
      modelDeprecated: 'llm-provider.model_deprecated',
      providerStatus: 'llm-provider.provider_status',
    });
  });

  it('namespaces every id under llm-provider.', () => {
    for (const id of Object.values(LLM_PROVIDER_CHECK_IDS)) {
      expect(id.startsWith('llm-provider.')).toBe(true);
    }
  });

  it('enumerates cleanly for the guidance registry, and backend.ts re-exports the same object', () => {
    // PR 5 imports from check-ids.js and enumerates with Object.values.
    expect(Object.values(LLM_PROVIDER_CHECK_IDS)).toHaveLength(6);
    expect(new Set(Object.values(LLM_PROVIDER_CHECK_IDS)).size).toBe(6);
    expect(ReExported).toBe(LLM_PROVIDER_CHECK_IDS);
  });

  it('lets a HealthSignal carry an optional checkId', () => {
    const signal: HealthSignal = {
      source: 'llm_key_valid',
      status: 'critical',
      detail: 'key rejected',
      observedAt: new Date().toISOString(),
      checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
    };
    expect(signal.checkId).toBe('llm-provider.key_valid');
  });

  it('lets a DiagnosisFinding carry an optional checkId', () => {
    const finding: DiagnosisFinding = {
      source: 'llm_key_valid',
      observation: 'key rejected',
      severity: 'critical',
      checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
    };
    expect(finding.checkId).toBe('llm-provider.key_valid');
  });
});
