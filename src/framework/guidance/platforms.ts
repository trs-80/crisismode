// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Which guide platforms a target may show.
 *
 * A checkId like 'llm-provider.key_valid' is provider-agnostic — both the
 * Anthropic and the OpenAI rotate-key guides answer it — so an unfiltered
 * lookup would tell an Anthropic user to rotate an OpenAI key. PR 3 derives
 * one target per detected provider, so the target itself is what disambiguates.
 *
 * Returning `undefined` (unknown platform) and `[]` (known platform, no
 * guides) are different answers on purpose: see GuidanceScope in registry.ts.
 */

/** Matched against the target name, most specific first. */
const LLM_PROVIDER_PLATFORMS: Array<{ match: RegExp; platform: string }> = [
  { match: /anthropic|claude/i, platform: 'anthropic-console' },
  { match: /openai|gpt/i, platform: 'openai-platform' },
];

export function platformsForTarget(kind: string, targetName: string): readonly string[] | undefined {
  // autodiscovery.ts never emits a bare 'llm-provider' kind — every derived
  // target's kind is `llm-provider.<provider>` (e.g. 'llm-provider.anthropic')
  // — so match on the dotted family, not an exact string. Comparing the
  // first '.'-segment (rather than a plain startsWith) avoids accidentally
  // matching an unrelated kind that merely shares the prefix.
  if (kind.split('.', 1)[0] === 'llm-provider') {
    for (const entry of LLM_PROVIDER_PLATFORMS) {
      if (entry.match.test(targetName)) return [entry.platform];
    }
    // Google and OpenRouter have no guides yet — show none, never a competitor's.
    return [];
  }
  if (kind === 'vector-store') return [];
  if (kind === 'aws-rds') return ['aws-rds'];
  // Everything else (a plain postgresql target, disk, dns, …) genuinely does
  // not name a platform: show every guide the finding type matches.
  return undefined;
}
