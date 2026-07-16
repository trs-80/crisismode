// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RiskLevel } from '../../types/common.js';

export interface PlaybookTrigger {
  alert: string;
  condition?: string;
  duration?: string;
}

export interface PlaybookRequirements {
  contexts?: Array<{
    type: string;
    target: string;
  }>;
  tools?: string[];
}

export interface PlaybookBlastRadius {
  maxAffectedRows?: number;
  maxDowntimeSeconds?: number;
  requiresMaintenanceWindow?: boolean;
}

export interface PlaybookFrontmatter {
  name: string;
  version: string;
  description: string;
  agent?: string;
  provider?: string;
  severity?: RiskLevel;
  triggers?: PlaybookTrigger[];
  requires?: PlaybookRequirements;
  tags?: string[];
  author?: string;
  estimatedDuration?: string;
}

export interface PlaybookCodeBlock {
  lang: string;
  content: string;
}

export interface PlaybookStep {
  position: number;
  title: string;
  type: string;
  description?: string;
  risk?: string;
  target?: string;
  executionContext?: string;
  precondition?: string;
  success?: string;
  blastRadius?: PlaybookBlastRadius;
  /** State-capture names for statePreservation.before (required for elevated+ risk). */
  preserve?: string[];
  /** Registered capability ids this step requires (see capability-registry). */
  capabilities?: string[];
  channel?: string;
  message?: string;
  timeout?: string;
  escalation?: string;
  condition?: string;
  onSuccess?: string;
  onFailure?: string;
  template?: string;
  body: string;
  codeBlocks: PlaybookCodeBlock[];
}

export interface ParsedPlaybook {
  frontmatter: PlaybookFrontmatter;
  steps: PlaybookStep[];
  rollback?: string;
  rawMarkdown: string;
  filePath?: string;
}

export interface PlaybookValidationError {
  field: string;
  message: string;
}

export interface PlaybookValidationResult {
  valid: boolean;
  errors: PlaybookValidationError[];
}

export interface DiscoveredPlaybook {
  filePath: string;
  frontmatter: PlaybookFrontmatter;
  source: 'user' | 'project' | 'env';
}

export interface PlaybookDiscoveryResult {
  playbooks: DiscoveredPlaybook[];
  warnings: Array<{ path: string; reason: string }>;
}
