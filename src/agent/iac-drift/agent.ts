// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { defaultReplan } from '../interface.js';
import type { RecoveryAgent } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { HealthAssessment } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import { iacDriftManifest } from './manifest.js';
import type { IacDriftBackend } from './backend.js';

export class IacDriftRecoveryAgent implements RecoveryAgent {
  manifest = iacDriftManifest;
  backend: IacDriftBackend;

  constructor(backend: IacDriftBackend) {
    this.backend = backend;
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    throw new Error('implemented in the next task');
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    throw new Error('implemented in the next task');
  }

  async plan(_context: AgentContext, _diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    throw new Error('implemented in the next task');
  }

  replan = defaultReplan;
}
