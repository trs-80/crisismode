// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The error-recovery paths of the AI diagnosis toolkit.
 *
 * `ai-diagnosis-token-budget.test.ts` covers the budget itself (max_tokens and
 * timeoutMs large enough that a real diagnosis arrives whole). This file covers
 * what happens when a response arrives anyway malformed: the in-string control
 * character repair added alongside the budget fix, and the two `catch` blocks
 * that must turn a bad response into a clean `null` so the caller falls back to
 * its rule-based path instead of throwing mid-crisis.
 *
 * That recovery code is only ever exercised when the AI misbehaves, so nothing
 * in normal operation would notice it rotting — which is exactly why it is
 * pinned here. Every test is hermetic: the SDK is mocked and the network
 * profile is written directly, so no test touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import type { NetworkProfile } from '@crisismode/agent-sdk';
import {
  aiCallText,
  aiDiagnose,
  parseStandardDiagnosisResponse,
} from '../framework/ai-diagnosis.js';
import { resetNetworkProfile, setNetworkProfile } from '../framework/network-profile.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof AnthropicSdk>();
  return {
    ...actual,
    default: class {
      messages = { create: createMock };
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────
// In-string control character repair
// ─────────────────────────────────────────────────────────────────────────

describe('parseStandardDiagnosisResponse — control character repair', () => {
  /**
   * The repair tracks in-string state, so it has to honor backslash escapes:
   * if it treated the `\"` inside a string value as the closing quote, it would
   * be "outside a string" for the rest of the body and would then escape the
   * STRUCTURAL newlines between JSON tokens, producing `{\n` outside a string —
   * still unparseable, just failing differently. This fixture puts an escaped
   * quote and an escaped backslash before the raw newline it has to repair, so
   * a tracker that loses its place fails the test rather than silently working
   * for simpler inputs.
   */
  it('keeps its place through escaped quotes and backslashes while repairing', () => {
    const withEscapesAndRawNewline = [
      '{',
      '  "status": "identified",',
      '  "scenario": "wal_generation_spike",',
      '  "confidence": 0.7,',
      '  "root_cause": "The primary logged \\"could not fork worker\\" repeatedly.',
      'Replay is not paused.",',
      '  "findings": [',
      '    {',
      '      "source": "logs",',
      '      "observation": "Archive dir C:\\\\pgdata\\\\pg_wal is full.",',
      '      "severity": "critical",',
      '      "evidence": "df reports 100%"',
      '    }',
      '  ],',
      '  "recommendations": ["Free space on the archive volume"]',
      '}',
    ].join('\n');

    // Precondition: the raw newline really is the only defect.
    expect(() => JSON.parse(withEscapesAndRawNewline)).toThrow(/control character/i);

    const result = parseStandardDiagnosisResponse(withEscapesAndRawNewline);

    expect(result.scenario).toBe('wal_generation_spike');
    // The escaped quote survived as a real quote, not as a lost string boundary.
    expect(result.findings[0]?.data?.root_cause).toBe(
      'The primary logged "could not fork worker" repeatedly.\nReplay is not paused.',
    );
    // The escaped backslashes survived as single backslashes.
    expect(result.findings[0]?.observation).toBe('Archive dir C:\\pgdata\\pg_wal is full.');
  });

  /**
   * \n \r \t \b \f have short JSON escapes; every other C0 control character
   * has to go out as a \uXXXX sequence. Nothing maps 0x01, so this exercises
   * the fallback arm of the escape lookup.
   */
  it('escapes a control character with no short JSON escape as \\uXXXX', () => {
    const withUnitSeparator =
      '{"status":"identified","scenario":"pipe\u0001delimited","confidence":0.5,"findings":[]}';

    expect(() => JSON.parse(withUnitSeparator)).toThrow(/control character/i);

    const result = parseStandardDiagnosisResponse(withUnitSeparator);
    expect(result.scenario).toBe('pipe\u0001delimited');
  });

  /**
   * The repair must be reached only after a real parse failure. A well-formed
   * response has to be parsed on the first attempt and handed back untouched —
   * rewriting it would be a needless second pass over every AI response on the
   * happy path.
   */
  it('does not touch a response that already parses', () => {
    const valid = JSON.stringify({
      status: 'identified',
      scenario: 'replication_lag',
      confidence: 0.9,
      root_cause: 'line one\nline two with a "quote"\tand a tab',
      findings: [{ source: 'pg_stat_replication', observation: 'lagging', severity: 'warning' }],
    });

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      const result = parseStandardDiagnosisResponse(valid);

      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(result.findings[0]?.data?.root_cause).toBe(
        'line one\nline two with a "quote"\tand a tab',
      );
    } finally {
      parseSpy.mockRestore();
    }
  });

  /**
   * When there is nothing to repair the original error must propagate, not a
   * second confusing one from the repaired copy — the caller's contract is
   * "throw and I will fall back", and the message it logs should describe the
   * response it actually received.
   */
  it('rethrows the original error when the repair changes nothing', () => {
    // Truncated mid-object: no in-string control characters, so the repaired
    // copy is identical to the input and the first error is rethrown.
    const truncated = '{"status": "identified", "findings": [{"source": "pg';

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      expect(() => parseStandardDiagnosisResponse(truncated)).toThrow(SyntaxError);
      // One attempt only: the repair was a no-op, so no second parse was tried.
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  /**
   * A response that has BOTH a control character and a structural defect gets
   * two parse attempts and still throws. This is the "repair did not help"
   * case — it must fail, not return a half-read diagnosis.
   */
  it('still throws when the repair runs but does not make the response valid', () => {
    // Raw newline inside a string value AND the object is never closed.
    const irreparable = '{"status":"identified","root_cause":"first line\nsecond line", "findings"';

    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      expect(() => parseStandardDiagnosisResponse(irreparable)).toThrow(SyntaxError);
      expect(parseSpy).toHaveBeenCalledTimes(2);
    } finally {
      parseSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Field-level defaults
// ─────────────────────────────────────────────────────────────────────────

describe('parseStandardDiagnosisResponse — field defaults', () => {
  it('fills in missing finding fields rather than emitting undefined', () => {
    const result = parseStandardDiagnosisResponse('{"status":"identified","findings":[{}]}');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: 'ai_analysis',
      observation: '',
      severity: 'info',
    });
  });

  it('downgrades a severity the schema does not define to info', () => {
    const result = parseStandardDiagnosisResponse(
      '{"status":"identified","findings":[{"source":"s","observation":"o","severity":"catastrophic"}]}',
    );

    expect(result.findings[0]?.severity).toBe('info');
  });

  it('defaults confidence and scenario when the model omits them', () => {
    const result = parseStandardDiagnosisResponse('{"status":"partial","findings":[]}');

    expect(result.confidence).toBe(0.5);
    expect(result.scenario).toBeNull();
    expect(result.status).toBe('partial');
  });

  it('clamps a confidence outside 0-1', () => {
    expect(parseStandardDiagnosisResponse('{"confidence":4.2,"findings":[]}').confidence).toBe(1);
    expect(parseStandardDiagnosisResponse('{"confidence":-3,"findings":[]}').confidence).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// aiCallText / aiDiagnose failure handling
// ─────────────────────────────────────────────────────────────────────────

function offlineProfile(): NetworkProfile {
  const checkedAt = '2026-08-09T12:00:00.000Z';
  return {
    internet: { status: 'unavailable', probes: [], checkedAt },
    hub: { status: 'unknown', probes: [], checkedAt },
    targets: { status: 'available', probes: [], checkedAt },
    dns: { available: false, latencyMs: 0 },
    mode: 'private_only',
    profiledAt: checkedAt,
  };
}

describe('aiCallText / aiDiagnose failure handling', () => {
  let originalApiKey: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    createMock.mockReset();
    resetNetworkProfile();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    resetNetworkProfile();
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns null without an API key and never reaches the SDK', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(await aiCallText('sys', 'state')).toBeNull();
    expect(await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' })).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  /**
   * The offline gate: when the startup probe says there is no internet, the
   * toolkit must not spend a 60s timeout discovering that. `triage` writes the
   * same cached profile, so this is the path an air-gapped spoke takes.
   */
  it('returns null when the network profile reports no internet', async () => {
    setNetworkProfile(offlineProfile());

    expect(await aiCallText('sys', 'state')).toBeNull();
    expect(await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' })).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports an API failure and returns null instead of throwing', async () => {
    createMock.mockRejectedValue(new Error('overloaded_error'));

    expect(await aiCallText('sys', 'state')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('AI call failed:', 'overloaded_error');
  });

  /**
   * Not everything thrown is an Error — an SDK or transport layer can reject
   * with a bare value, and the handler has to log something useful rather than
   * `undefined` from reading `.message` off a string.
   */
  it('logs a non-Error rejection as-is', async () => {
    const thrown: unknown = 'socket hang up';
    createMock.mockRejectedValue(thrown);

    expect(await aiCallText('sys', 'state')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('AI call failed:', 'socket hang up');
  });

  /**
   * The end-to-end shape of the bug this PR fixed: the call succeeds, the body
   * is unparseable, and the agent must get a clean null (its cue to fall back)
   * plus a log line naming the parse failure — the signal whose absence made
   * the truncation bug look like "AI is unavailable".
   */
  it('returns null and names the parse failure when the response is not JSON', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'I could not determine the root cause.' }],
    });

    const result = await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'AI diagnosis response could not be parsed:',
      expect.stringMatching(/JSON|Unexpected/i),
    );
  });

  it('returns null when a truncated response reaches the parser', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"identified","root_cause":"The primary is ou' }],
    });

    expect(await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'AI diagnosis response could not be parsed:',
      expect.any(String),
    );
  });

  it('returns null when a caller-supplied parser throws', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'anything' }] });

    const result = await aiDiagnose({
      systemPrompt: 'sys',
      userMessage: 'state',
      parseResponse: () => {
        throw new Error('custom parser rejected the shape');
      },
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'AI diagnosis response could not be parsed:',
      'custom parser rejected the shape',
    );
  });

  it('logs a non-Error thrown by a caller-supplied parser as-is', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'anything' }] });
    const thrown: unknown = 'parser exploded';

    const result = await aiDiagnose({
      systemPrompt: 'sys',
      userMessage: 'state',
      parseResponse: () => {
        throw thrown;
      },
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'AI diagnosis response could not be parsed:',
      'parser exploded',
    );
  });

  /**
   * The repair is wired into the real call path, not just the exported parser:
   * a live response with a raw newline inside a string value has to come back
   * as a diagnosis, which is the run the demo recording lost.
   */
  it('recovers a live response whose only defect is a raw newline', async () => {
    const raw = [
      '{"status":"identified","scenario":"replication_lag_cascade","confidence":0.74,',
      '"root_cause":"The primary is outrunning the replicas.',
      'Replay is not paused.",',
      '"findings":[{"source":"pg_stat_replication","observation":"lag 342s","severity":"critical"}],',
      '"recommendations":["Check WAL generation rate"]}',
    ].join('\n');
    createMock.mockResolvedValue({ content: [{ type: 'text', text: raw }] });

    const result = await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' });

    expect(result?.scenario).toBe('replication_lag_cascade');
    expect(result?.confidence).toBeCloseTo(0.74);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('strips a code fence the model wrapped around the diagnosis', async () => {
    const fenced =
      '```json\n{"status":"identified","scenario":"slot_exhaustion","confidence":0.6,"findings":[]}\n```';
    createMock.mockResolvedValue({ content: [{ type: 'text', text: fenced }] });

    const result = await aiDiagnose({ systemPrompt: 'sys', userMessage: 'state' });

    expect(result?.scenario).toBe('slot_exhaustion');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
