// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode ask "my postgres is slow"` — natural language AI diagnosis.
 */

import { universalAiDiagnosis } from '../../framework/ai-diagnosis-universal.js';
import { printBanner, printInfo, printWarning } from '../output.js';
import { missingEnvVar } from '../errors.js';

export async function runAsk(question: string): Promise<void> {
  printBanner();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingEnvVar('ANTHROPIC_API_KEY', 'required for AI-powered diagnosis');
  }

  printInfo(`Question: ${question}`);
  console.log('');

  const result = await universalAiDiagnosis({ question });

  if (result.source === 'ai') {
    console.log(result.response);
  } else {
    printWarning('AI diagnosis unavailable. Showing basic guidance.');
    console.log(result.response);
  }
  console.log('');
}
