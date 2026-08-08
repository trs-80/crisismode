// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aaron Johnson

import { describe, it, expect } from 'vitest';
import {
  SERVICE_CATALOG,
  resolveCatalogEntry,
} from '../framework/service-status/catalog.js';

describe('service-status catalog', () => {
  it('resolves ids case-insensitively and via aliases', () => {
    expect(resolveCatalogEntry('github')?.id).toBe('github');
    expect(resolveCatalogEntry('GitHub')?.id).toBe('github');
    expect(resolveCatalogEntry('flyio')?.id).toBe('fly');
    expect(resolveCatalogEntry('pscale')?.id).toBe('planetscale');
    expect(resolveCatalogEntry('api.myvendor.com')).toBeUndefined();
  });

  it('every entry is statuspage_v2 with an https status URL and port 443', () => {
    for (const e of SERVICE_CATALOG) {
      expect(e.statusFormat).toBe('statuspage_v2');
      expect(e.statusUrl).toMatch(/^https:\/\/.+\/api\/v2\/summary\.json$/);
      expect(e.probePort).toBe(443);
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('ids are unique and anthropic/openai are NOT in the catalog (llm-provider owns them)', () => {
    const ids = SERVICE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(resolveCatalogEntry('anthropic')).toBeUndefined();
    expect(resolveCatalogEntry('openai')).toBeUndefined();
  });
});
