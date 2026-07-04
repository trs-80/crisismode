// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Central Claude model selection for all AI-powered paths.
 *
 * A single hardcoded model ID previously rotted in seven call sites: when
 * claude-sonnet-4-20250514 was retired (2026-06-15), every AI diagnosis
 * silently degraded to heuristics/abstention for weeks — the diagnosis eval
 * caught it. One module, one env override, one place to migrate.
 */

const FALLBACK_MODEL = 'claude-sonnet-5';

/** Model used for diagnosis, summaries, and routing. Override with CRISISMODE_AI_MODEL. */
export function defaultAiModel(): string {
  return process.env.CRISISMODE_AI_MODEL ?? FALLBACK_MODEL;
}
