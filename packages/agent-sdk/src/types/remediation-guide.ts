// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * A structured, human-performed remediation path — the "open this URL, click
 * this, expect that" instructions for fixes CrisisMode can see but must not
 * execute (dashboard actions on managed platforms). Static data: guides are
 * authored in the main package, keyed to finding types, and rendered
 * identically across every output mode.
 */
export interface RemediationGuide {
  /** Unique across the registry, e.g. 'anthropic-rotate-key'. */
  id: string;
  /** Platform the steps are for, e.g. 'anthropic-console', 'supabase', 'aws-rds'. */
  platform: string;
  /** Imperative one-liner, e.g. "Rotate your Anthropic API key". */
  title: string;
  /**
   * Finding/signal types this guide answers: readiness rule ids
   * (e.g. 'serverless-pooling') or agent checkIds (e.g. 'llm-provider.key_valid').
   */
  applicableFindingTypes: string[];
  /** Stable console entry URL — no account-specific deep links. */
  url?: string | undefined;
  /** Ordered human steps, e.g. "Settings → API keys → Create Key". */
  consoleSteps: string[];
  /** Optional single-line equivalent for users comfortable with a terminal. */
  cliEquivalent?: string | undefined;
  /** What the user should observe when it worked. */
  expectedAfter: string;
  /** Risk note, when a step is destructive-adjacent (e.g. the old key stops working). */
  caution?: string | undefined;
  /** ISO date (YYYY-MM-DD) the path was last human-verified. */
  verifiedOn: string;
}
