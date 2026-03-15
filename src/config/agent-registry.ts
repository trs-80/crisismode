// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Agent registry — resolves targets to agents using registered AgentRegistrations.
 *
 * Supports multiple agents per kind (e.g. pg-replication-recovery and
 * pg-vacuum-recovery both handling kind 'postgresql'). Agents are loaded
 * lazily via async factories so only the drivers you need get imported.
 *
 * Version-aware: filters agents by their manifest versionConstraint using
 * semver. If a target specifies a version, only compatible agents are selected.
 */

import semver from 'semver';
import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { SiteConfig, ResolvedTarget } from './schema.js';
import { resolveTargets } from './resolve.js';
import { builtinAgents } from './builtin-agents.js';

// Re-export for callers that import AgentInstance from here
export type { AgentInstance } from './agent-registration.js';

export class AgentRegistry {
  private targets: ResolvedTarget[];

  /** kind → registrations (one-to-many) */
  private byKind = new Map<string, AgentRegistration[]>();

  /** agentName → registration (unique) */
  private byName = new Map<string, AgentRegistration>();

  constructor(config: SiteConfig, registrations?: AgentRegistration[]) {
    this.targets = resolveTargets(config);

    // Register built-in agents, then any extras passed in
    for (const reg of builtinAgents) {
      this.register(reg);
    }
    if (registrations) {
      for (const reg of registrations) {
        this.register(reg);
      }
    }
  }

  /**
   * Register an agent. Can be called after construction for plugins.
   */
  register(registration: AgentRegistration): void {
    this.byName.set(registration.name, registration);

    const existing = this.byKind.get(registration.kind);
    if (existing) {
      // Avoid duplicates by name
      if (!existing.some((r) => r.name === registration.name)) {
        existing.push(registration);
      }
    } else {
      this.byKind.set(registration.kind, [registration]);
    }
  }

  /**
   * List all registered target kinds.
   */
  supportedKinds(): string[] {
    return [...this.byKind.keys()];
  }

  /**
   * List all registered agent names.
   */
  registeredAgents(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Create an agent instance for a named target.
   *
   * If the target specifies an `agent` name, that exact agent is used.
   * Otherwise the first registration matching the target's kind is used,
   * filtered by version compatibility when the target declares a version.
   */
  async createForTarget(targetName: string): Promise<AgentInstance> {
    const target = this.targets.find((t) => t.name === targetName);
    if (!target) {
      throw new Error(
        `Target "${targetName}" not found in config. Available: ${this.targets.map((t) => t.name).join(', ')}`,
      );
    }

    return this.instantiate(target);
  }

  /**
   * Create agent instances for all targets of a given kind.
   */
  async createForKind(kind: string): Promise<AgentInstance[]> {
    const kindTargets = this.targets.filter((t) => t.kind === kind);
    if (!this.byKind.has(kind)) {
      throw new Error(`No agent registered for kind "${kind}". Supported: ${this.supportedKinds().join(', ')}`);
    }
    return Promise.all(kindTargets.map((t) => this.instantiate(t)));
  }

  /**
   * Create the first available agent (useful when there's only one target).
   */
  async createFirst(): Promise<AgentInstance> {
    if (this.targets.length === 0) {
      throw new Error('No targets configured');
    }
    return this.createForTarget(this.targets[0].name);
  }

  /**
   * Dispatch an alert to the matching agent based on manifest matchLabels.
   * Returns the agent instance for the best-matching target, or undefined.
   */
  async dispatchAlert(alertLabels: Record<string, string>): Promise<AgentInstance | undefined> {
    for (const target of this.targets) {
      const registration = this.findRegistrationForAlert(target, alertLabels);
      if (!registration) continue;

      // Instance disambiguation: if alert has an instance label, match host:port
      const instanceLabel = alertLabels.instance;
      if (instanceLabel) {
        const targetAddr = `${target.primary.host}:${target.primary.port}`;
        const sameKindTargets = this.targets.filter((t) => t.kind === target.kind);
        if (instanceLabel !== targetAddr && sameKindTargets.length > 1) {
          continue;
        }
      }

      return registration.createAgent(target);
    }

    return undefined;
  }

  private async instantiate(target: ResolvedTarget): Promise<AgentInstance> {
    // If the target specifies an agent name, use that exact registration
    if (target.agent) {
      const reg = this.byName.get(target.agent);
      if (!reg) {
        throw new Error(
          `Agent "${target.agent}" not found. Registered: ${this.registeredAgents().join(', ')}`,
        );
      }
      if (reg.kind !== target.kind) {
        throw new Error(
          `Agent "${target.agent}" handles kind "${reg.kind}" but target "${target.name}" is kind "${target.kind}"`,
        );
      }
      return reg.createAgent(target);
    }

    // Find registrations for this kind, filtered by version compatibility
    const registrations = this.byKind.get(target.kind);
    if (!registrations || registrations.length === 0) {
      throw new Error(
        `No agent registered for kind "${target.kind}". Supported: ${this.supportedKinds().join(', ')}`,
      );
    }

    const compatible = this.filterByVersion(registrations, target);
    if (compatible.length === 0) {
      const available = registrations.map((r) => {
        const constraints = r.manifest.spec.targetSystems
          .filter((ts) => ts.technology === target.kind)
          .map((ts) => ts.versionConstraint);
        return `${r.name} (${constraints.join(', ')})`;
      });
      throw new Error(
        `No agent supports ${target.kind} ${target.version}. Available: ${available.join(', ')}`,
      );
    }

    return compatible[0].createAgent(target);
  }

  /**
   * Filter registrations by version compatibility.
   * If the target has no version, all registrations match (backward-compatible).
   */
  private filterByVersion(registrations: AgentRegistration[], target: ResolvedTarget): AgentRegistration[] {
    if (!target.version) {
      return registrations;
    }

    // Coerce the version to a valid semver if it isn't already
    const coerced = semver.coerce(target.version);
    if (!coerced) {
      // Can't parse version — fall back to matching all
      return registrations;
    }

    return registrations.filter((reg) => {
      const targetSystem = reg.manifest.spec.targetSystems
        .find((ts) => ts.technology === target.kind);
      if (!targetSystem || !targetSystem.versionConstraint) {
        // No version constraint declared — matches all versions
        return true;
      }
      return semver.satisfies(coerced, targetSystem.versionConstraint);
    });
  }

  /**
   * Attempt to discover the target version from the backend.
   * Best-effort: if the backend doesn't support discovery or the call fails,
   * the target is unchanged. Uses a 3s timeout to avoid blocking.
   *
   * Call this after createForTarget/createFirst when running against live
   * infrastructure. Not needed in tests or when version is in config.
   */
  static async discoverVersion(instance: AgentInstance): Promise<void> {
    if (instance.target.version) return;
    if (typeof instance.backend.discoverVersion !== 'function') return;

    try {
      const discovered = await Promise.race([
        instance.backend.discoverVersion(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Version discovery timed out')), 3000),
        ),
      ]);
      if (discovered) {
        instance.target.version = discovered;
      }
    } catch {
      // Version discovery is best-effort — don't fail the recovery flow
    }
  }

  private findRegistrationForAlert(
    target: ResolvedTarget,
    alertLabels: Record<string, string>,
  ): AgentRegistration | undefined {
    const registrations = this.byKind.get(target.kind);
    if (!registrations) return undefined;

    // Filter by version first, then match alerts
    const compatible = this.filterByVersion(registrations, target);

    for (const reg of compatible) {
      const matches = reg.manifest.spec.triggerConditions.some((trigger) => {
        if (trigger.type !== 'alert' || !trigger.matchLabels) return false;
        return Object.entries(trigger.matchLabels).every(
          ([key, value]) => alertLabels[key] === value,
        );
      });
      if (matches) return reg;
    }

    return undefined;
  }
}
