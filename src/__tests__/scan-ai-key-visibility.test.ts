// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { aiKeyBlockedEntries } from '../cli/commands/scan.js';

describe('aiKeyBlockedEntries', () => {
  it('reports a detected provider whose key is not in this environment', () => {
    const entries = aiKeyBlockedEntries({
      aiProviders: [{ provider: 'anthropic', configured: false, envVar: 'ANTHROPIC_API_KEY' }],
    });

    expect(entries).toHaveLength(1);
    // Matches the kind-as-label format the watching rows use (Task 12) —
    // 'llm-provider.anthropic', not a parenthesised family name — so watching
    // and blocked rows for the same provider read as the same thing.
    expect(entries[0]!.label).toBe('llm-provider.anthropic');
    expect(entries[0]!.detail).toContain('ANTHROPIC_API_KEY');
    expect(entries[0]!.hint).toContain('.env');
  });

  it('says nothing about a provider whose key is present — that one is watched', () => {
    expect(aiKeyBlockedEntries({
      aiProviders: [{ provider: 'openai', configured: true, envVar: 'OPENAI_API_KEY' }],
    })).toEqual([]);
  });

  it('returns nothing when no AI provider was detected at all', () => {
    expect(aiKeyBlockedEntries({ aiProviders: [] })).toEqual([]);
  });

  it('never includes key material — it only ever sees names', () => {
    const entries = aiKeyBlockedEntries({
      aiProviders: [{ provider: 'google', configured: false, envVar: 'GOOGLE_AI_API_KEY' }],
    });
    expect(JSON.stringify(entries)).not.toMatch(/sk-|AIza/);
  });
});
