// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ExecutionBackend } from './backend.js';
import { getCapability } from './capability-registry.js';
import type { AgentManifest, ExecutionContextDeclaration } from '../types/manifest.js';
import type { SystemActionStep } from '../types/step-types.js';
import type {
  CapabilityProviderDescriptor,
  CapabilityProviderResolution,
  ProviderExecutionMode,
} from '../types/plugin.js';

export interface StepProviderResolution {
  stepId: string;
  resolved: boolean;
  providers: string[];
  capabilities: CapabilityProviderResolution[];
  summary: string;
}

export interface ProviderCapabilityReference {
  stepId: string;
  capability: string;
  resolved: boolean;
  providerId?: string;
  reason?: string;
}

export function resolveStepProviders(
  step: SystemActionStep,
  manifest: AgentManifest,
  backend: ExecutionBackend,
  mode: ProviderExecutionMode,
): StepProviderResolution {
  const executionContext = manifest.spec.executionContexts.find(
    (context) => context.name === step.executionContext,
  );
  const providers = backend.listCapabilityProviders?.() ?? [];
  const capabilities = step.requiredCapabilities.map((capability) =>
    resolveCapabilityProvider(capability, step, executionContext, providers, mode),
  );

  return {
    stepId: step.stepId,
    resolved: capabilities.every((result) => result.resolved),
    providers: [...new Set(capabilities.flatMap((result) => (result.providerId ? [result.providerId] : [])))],
    capabilities,
    summary: describeCapabilityResolutions(step.stepId, capabilities),
  };
}

function resolveCapabilityProvider(
  capabilityId: string,
  step: SystemActionStep,
  executionContext: ExecutionContextDeclaration | undefined,
  providers: CapabilityProviderDescriptor[],
  mode: ProviderExecutionMode,
): CapabilityProviderResolution {
  if (!executionContext) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `execution context '${step.executionContext}' is not declared`,
    };
  }

  const capability = getCapability(capabilityId);
  if (!capability) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `capability '${capabilityId}' is not registered`,
    };
  }

  if (!(executionContext.capabilities ?? []).includes(capabilityId)) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `capability '${capabilityId}' is not declared on execution context '${executionContext.name}'`,
    };
  }

  if (!capability.targetKinds.includes(executionContext.target)) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `capability '${capabilityId}' is not compatible with target kind '${executionContext.target}'`,
    };
  }

  const supportingProviders = providers.filter((provider) => provider.capabilities.includes(capabilityId));
  if (supportingProviders.length === 0) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `no provider is registered for capability '${capabilityId}'`,
    };
  }

  const modeCompatibleProviders = supportingProviders.filter((provider) =>
    mode === 'execute' ? provider.supportsExecute : provider.supportsDryRun,
  );
  if (modeCompatibleProviders.length === 0) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `registered providers for '${capabilityId}' do not support ${mode} mode`,
    };
  }

  const contextCompatibleProviders = modeCompatibleProviders.filter((provider) =>
    provider.executionContexts.includes(step.executionContext),
  );
  if (contextCompatibleProviders.length === 0) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `no ${mode} provider for '${capabilityId}' supports execution context '${step.executionContext}'`,
    };
  }

  const commandCompatibleProviders = contextCompatibleProviders.filter((provider) =>
    provider.commandTypes.includes(step.command.type),
  );
  if (commandCompatibleProviders.length === 0) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `no ${mode} provider for '${capabilityId}' supports command type '${step.command.type}'`,
    };
  }

  const targetCompatibleProviders = commandCompatibleProviders.filter((provider) =>
    provider.targetKinds.includes(executionContext.target),
  );
  if (targetCompatibleProviders.length === 0) {
    return {
      capability: capabilityId,
      resolved: false,
      reason: `no ${mode} provider for '${capabilityId}' supports target kind '${executionContext.target}'`,
    };
  }

  return {
    capability: capabilityId,
    resolved: true,
    providerId: targetCompatibleProviders[0].id,
  };
}

export function describeCapabilityResolutions(
  stepId: string,
  capabilities: CapabilityProviderResolution[],
): string {
  return capabilities
    .map((resolution) =>
      resolution.resolved
        ? `${stepId}:${resolution.capability} -> ${resolution.providerId}`
        : `${stepId}:${resolution.capability} blocked: ${resolution.reason}`,
    )
    .join('; ');
}

export function flattenProviderResolutions(
  resolutions: StepProviderResolution[],
): ProviderCapabilityReference[] {
  return resolutions.flatMap((resolution) =>
    resolution.capabilities.map((capability) => ({
      stepId: resolution.stepId,
      capability: capability.capability,
      resolved: capability.resolved,
      providerId: capability.providerId,
      reason: capability.reason,
    })),
  );
}

export function summarizeLiveProviderReadiness(
  resolutions: StepProviderResolution[],
): string {
  const flattened = flattenProviderResolutions(resolutions);
  const blocked = flattened.filter((capability) => !capability.resolved);
  const supported = flattened.filter((capability) => capability.resolved);

  if (blocked.length === 0) {
    return supported.length === 0
      ? 'No system actions require live provider resolution.'
      : `All ${supported.length} live capability requirement(s) resolved successfully.`;
  }

  const blockedList = blocked
    .map((capability) => `${capability.capability} (${capability.stepId})`)
    .join(', ');
  const supportedClause = supported.length > 0
    ? ` Supported in this plan: ${supported.map((capability) => `${capability.capability} (${capability.stepId})`).join(', ')}.`
    : '';

  return `Missing live providers for ${blockedList}.${supportedClause}`;
}
