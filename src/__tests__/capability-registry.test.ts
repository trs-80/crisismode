// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest';

import {
  listCapabilities,
  getCapability,
  isKnownCapability,
  registerExternalCapability,
  unregisterCapability,
} from '../framework/capability-registry.js';
import type { CapabilityDefinition } from '../types/plugin.js';

// Track capabilities we register so we can clean up
const registeredIds: string[] = [];

afterEach(() => {
  for (const id of registeredIds) {
    unregisterCapability(id);
  }
  registeredIds.length = 0;
});

describe('capability-registry', () => {
  it('listCapabilities returns a non-empty array', () => {
    const caps = listCapabilities();
    expect(caps.length).toBeGreaterThan(0);
  });

  it('getCapability returns the correct definition for db.query.read', () => {
    const cap = getCapability('db.query.read');
    expect(cap).toBeDefined();
    expect(cap!.id).toBe('db.query.read');
    expect(cap!.actionKind).toBe('read');
    expect(cap!.targetKinds).toContain('postgresql');
  });

  it('getCapability returns undefined for a nonexistent id', () => {
    expect(getCapability('nonexistent')).toBeUndefined();
  });

  it('isKnownCapability returns true for db.query.read', () => {
    expect(isKnownCapability('db.query.read')).toBe(true);
  });

  it('isKnownCapability returns false for a nonexistent id', () => {
    expect(isKnownCapability('nonexistent')).toBe(false);
  });

  it('registerExternalCapability adds a new capability', () => {
    const newCap: CapabilityDefinition = {
      id: 'test.custom.capability',
      actionKind: 'read',
      description: 'A test capability',
      targetKinds: ['test'],
    };
    registeredIds.push(newCap.id);

    registerExternalCapability(newCap);

    expect(isKnownCapability('test.custom.capability')).toBe(true);
    expect(getCapability('test.custom.capability')).toEqual(newCap);
    expect(listCapabilities()).toContainEqual(newCap);
  });

  it('registerExternalCapability with existing ID replaces it', () => {
    const original: CapabilityDefinition = {
      id: 'test.replace.capability',
      actionKind: 'read',
      description: 'Original',
      targetKinds: ['test'],
    };
    const replacement: CapabilityDefinition = {
      id: 'test.replace.capability',
      actionKind: 'mutate',
      description: 'Replaced',
      targetKinds: ['test', 'other'],
    };
    registeredIds.push(original.id);

    registerExternalCapability(original);
    registerExternalCapability(replacement);

    const cap = getCapability('test.replace.capability');
    expect(cap).toBeDefined();
    expect(cap!.actionKind).toBe('mutate');
    expect(cap!.description).toBe('Replaced');
  });

  it('unregisterCapability returns true and removes the capability', () => {
    const cap: CapabilityDefinition = {
      id: 'test.unregister.capability',
      actionKind: 'read',
      description: 'To be removed',
      targetKinds: ['test'],
    };
    registerExternalCapability(cap);

    const result = unregisterCapability('test.unregister.capability');
    expect(result).toBe(true);
    expect(isKnownCapability('test.unregister.capability')).toBe(false);
    expect(getCapability('test.unregister.capability')).toBeUndefined();
  });

  it('unregisterCapability returns false for a non-existent id', () => {
    expect(unregisterCapability('does.not.exist')).toBe(false);
  });
});
