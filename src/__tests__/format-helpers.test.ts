// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration } from '../framework/format-helpers.js';

describe('formatBytes', () => {
  it('formats gigabytes', () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5GB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0GB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe('512.0MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5MB');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(100 * 1024)).toBe('100.0KB');
    expect(formatBytes(1024)).toBe('1.0KB');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(1)).toBe('1B');
  });

  it('uses correct threshold boundaries', () => {
    // Just under 1KB → bytes
    expect(formatBytes(1023)).toBe('1023B');
    // Exactly 1KB → KB
    expect(formatBytes(1024)).toBe('1.0KB');
    // Just under 1MB → KB
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0KB');
    // Exactly 1MB → MB
    expect(formatBytes(1024 * 1024)).toBe('1.0MB');
  });
});

describe('formatDuration', () => {
  it('formats days', () => {
    expect(formatDuration(86400)).toBe('1.0d');
    expect(formatDuration(5 * 86400)).toBe('5.0d');
    expect(formatDuration(2.5 * 86400)).toBe('2.5d');
  });

  it('formats hours', () => {
    expect(formatDuration(3600)).toBe('1.0h');
    expect(formatDuration(4.5 * 3600)).toBe('4.5h');
  });

  it('formats minutes', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(90)).toBe('2m'); // rounds to nearest integer
  });

  it('formats seconds', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('rounds seconds to integers', () => {
    expect(formatDuration(1.7)).toBe('2s');
    expect(formatDuration(0.3)).toBe('0s');
  });

  it('uses correct threshold boundaries', () => {
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3599)).toBe('60m');
    expect(formatDuration(3600)).toBe('1.0h');
    expect(formatDuration(86399)).toBe('24.0h');
    expect(formatDuration(86400)).toBe('1.0d');
  });
});
