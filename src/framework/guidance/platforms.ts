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

/** Fallback only — matched against the target name for the bare 'llm-provider' kind, which no real caller emits. */
const LLM_PROVIDER_PLATFORMS: Array<{ match: RegExp; platform: string }> = [
  { match: /anthropic|claude/i, platform: 'anthropic-console' },
  { match: /openai|gpt/i, platform: 'openai-platform' },
];

/** The kind suffix's provider -> platform. Per src/config/schema.ts:88-93, `llm-provider.<provider>` is the authoritative provider carrier; unlisted providers (google, openrouter, …) have no guides yet. */
const LLM_PROVIDER_KIND_PLATFORM: Record<string, string> = {
  anthropic: 'anthropic-console',
  openai: 'openai-platform',
};

export function platformsForTarget(kind: string, targetName: string): readonly string[] | undefined {
  // autodiscovery.ts never emits a bare 'llm-provider' kind — every derived
  // target's kind is `llm-provider.<provider>` (e.g. 'llm-provider.anthropic')
  // — so match on the dotted family, not an exact string. Comparing the
  // first '.'-segment (rather than a plain startsWith) avoids accidentally
  // matching an unrelated kind that merely shares the prefix.
  const [family, provider] = kind.split('.', 2);
  if (family === 'llm-provider') {
    // Dotted kind: the suffix is authoritative — TargetConfig.name is
    // free-form user input (LlmTargetOptions) that can name-collide with a
    // different vendor (e.g. an openrouter target named 'claude-router').
    // Never fall back to the name regex here, or a misleading name leaks a
    // competitor's console guide or silently suppresses a known provider's.
    if (provider !== undefined) {
      const platform = LLM_PROVIDER_KIND_PLATFORM[provider];
      return platform !== undefined ? [platform] : [];
    }
    // Bare 'llm-provider' kind: no kind suffix to trust, so fall back to the
    // name-regex as a defensive best effort.
    for (const entry of LLM_PROVIDER_PLATFORMS) {
      if (entry.match.test(targetName)) return [entry.platform];
    }
    return [];
  }
  if (kind === 'vector-store') return [];
  if (kind === 'aws-rds') return ['aws-rds'];
  // Everything else (a plain postgresql target, disk, dns, …) genuinely does
  // not name a platform: show every guide the finding type matches.
  return undefined;
}
