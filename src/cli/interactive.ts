// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Zero-arg interactive mode — the `npx crisismode` experience.
 * Detects services → diagnoses → offers recovery.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { detectServices, type DetectedService } from './detect.js';
import {
  printBanner, printDetection, printInfo, printSuccess,
  printWarning, printHealthStatus, printDiagnosis, printPlan,
  printOperatorSummary,
} from './output.js';
import { noConfig } from './errors.js';
import { loadConfig } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { assembleContext } from '../framework/context.js';
import { buildOperatorSummary } from '../framework/operator-summary.js';
import { validatePlan } from '../framework/validator.js';
import { explainPlan } from '../framework/ai-explainer.js';
import type { AgentContext } from '../types/agent-context.js';
import type { SiteConfig } from '../config/schema.js';

export async function runInteractive(): Promise<void> {
  printBanner();

  // Try loading config first
  let config: SiteConfig | undefined;
  try {
    const result = loadConfig();
    config = result.config;
    printInfo(`Config loaded: ${result.source === 'file' ? result.filePath : 'env-var fallback'}`);
  } catch {
    // No config — will use detection
  }

  if (!config) {
    // Detect services
    printInfo('No configuration found. Scanning localhost for services...');
    console.log('');
    const services = await detectServices();
    printDetection(services);

    const detected = services.filter((s) => s.detected);
    if (detected.length === 0) {
      throw noConfig();
    }

    // Build config from detected services
    config = buildConfigFromDetection(detected);
  }

  const registry = new AgentRegistry(config);

  // Pick target
  let targetName: string;
  if (config.targets.length === 1) {
    targetName = config.targets[0].name;
    printInfo(`Auto-selected target: ${targetName} (${config.targets[0].kind})`);
  } else {
    console.log('');
    printInfo('Available targets:');
    for (let i = 0; i < config.targets.length; i++) {
      const t = config.targets[i];
      console.log(`  ${i + 1}. ${t.name} (${t.kind}) — ${t.primary.host}:${t.primary.port}`);
    }
    console.log('');

    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question('  Select target [1]: ');
    rl.close();

    const idx = parseInt(answer || '1', 10) - 1;
    if (idx < 0 || idx >= config.targets.length) {
      throw new Error('Invalid selection');
    }
    targetName = config.targets[idx].name;
  }

  console.log('');

  const { agent, backend, target } = await registry.createForTarget(targetName);
  await AgentRegistry.discoverVersion({ agent, backend, target });

  try {
    // Build trigger
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'cli-interactive',
      payload: {
        alertname: `${target.kind}HealthCheck`,
        instance: `${target.primary.host}:${target.primary.port}`,
        severity: 'info',
      },
      receivedAt: new Date().toISOString(),
    };

    const context = assembleContext(trigger, agent.manifest);

    // Health assessment
    printInfo('Assessing health...');
    const health = await agent.assessHealth(context);
    printHealthStatus(health);

    if (health.status === 'healthy') {
      printSuccess('System is healthy! No recovery needed.');
      printOperatorSummary(buildOperatorSummary({
        health,
        mode: 'dry-run',
        healthCheckOnly: true,
      }));
      return;
    }

    // Diagnosis
    const hasAiKey = !!process.env.ANTHROPIC_API_KEY;
    printInfo(hasAiKey ? 'Running AI-powered diagnosis...' : 'Running rule-based diagnosis...');
    const diagnosis = await agent.diagnose(context);
    printDiagnosis(diagnosis);

    // Plan
    printInfo('Generating recovery plan...');
    const plan = await agent.plan(context, diagnosis);
    printPlan(plan);

    // AI explanation
    const explanation = await explainPlan(plan, diagnosis);
    if (explanation.summary) {
      console.log(`  ${explanation.summary}`);
      console.log('');
    }

    // Validate
    const validation = validatePlan(plan, agent.manifest, {
      backend,
      executionMode: 'dry-run',
    });

    if (!validation.valid) {
      printWarning('Plan validation failed. Manual intervention may be needed.');
      printOperatorSummary(buildOperatorSummary({
        health,
        mode: 'dry-run',
        currentValidation: validation,
      }));
      return;
    }

    // Offer next steps
    console.log('  Next steps:');
    console.log('    crisismode recover                    # dry-run recovery');
    console.log('    crisismode recover --execute           # execute recovery');
    console.log('    crisismode diagnose --target <name>    # re-check specific target');
    console.log('');
  } finally {
    await backend.close();
  }
}

function buildConfigFromDetection(detected: DetectedService[]): SiteConfig {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'SiteConfig',
    metadata: { name: 'auto-detected', environment: 'development' },
    targets: detected.map((s) => ({
      name: `detected-${s.kind}`,
      kind: s.kind,
      primary: { host: s.host, port: s.port },
      replicas: [],
      credentials: { type: 'value' as const, username: '', password: '' },
    })),
  };
}
