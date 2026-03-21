// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import { defaultReplan } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { dnsManifest } from './manifest.js';
import type { DnsBackend, ResolverProbe, ResolutionResult } from './backend.js';
import { DnsSimulator } from './simulator.js';

export class DnsRecoveryAgent implements RecoveryAgent {
  manifest = dnsManifest;
  backend: DnsBackend;

  constructor(backend?: DnsBackend) {
    this.backend = backend ?? new DnsSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const [config, probes, resolutions] = await Promise.all([
      this.backend.getResolvConf(),
      this.backend.probeResolvers('google.com'),
      this.backend.resolveHostnames(['google.com', 'cloudflare.com']),
    ]);

    const reachableCount = probes.filter((p) => p.reachable).length;
    const totalResolvers = probes.length;
    const anyUnreachable = reachableCount < totalResolvers;
    const allUnreachable = reachableCount === 0 && totalResolvers > 0;
    const noResolvers = config.nameservers.length === 0;

    const anyTimeout = probes.some((p) => p.status === 'timeout');
    const anyServfail = probes.some((p) => p.status === 'servfail');

    // Compute resolution rate per hostname (success = at least one resolver answered)
    const hostnames = [...new Set(resolutions.map((r) => r.hostname))];
    const successfulHostnames = hostnames.filter((h) =>
      resolutions.some((r) => r.hostname === h && r.answers.length > 0 && !r.servfail && !r.timedOut),
    );
    const resolutionRate = hostnames.length > 0 ? successfulHostnames.length / hostnames.length : 0;
    const anyNxdomain = resolutions.some((r) => r.nxdomain);
    const dnssecFailure = resolutions.some((r) => r.dnssecValid === false);

    const avgLatency = probes.filter((p) => p.latencyMs > 0).reduce((sum, p) => sum + p.latencyMs, 0) /
      (probes.filter((p) => p.latencyMs > 0).length || 1);
    const highLatency = avgLatency > 500;

    // Split-brain: different resolvers returning different answers for the same hostname
    const splitBrain = this.detectSplitBrain(resolutions);

    const status = noResolvers || allUnreachable || resolutionRate < 0.5
      ? 'unhealthy'
      : anyUnreachable || anyServfail || anyTimeout || highLatency || splitBrain || dnssecFailure || anyNxdomain
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'resolver_reachability',
        status: signalStatus(allUnreachable || noResolvers, anyUnreachable || anyTimeout),
        detail: `${reachableCount}/${totalResolvers} resolvers reachable. ${probes.map((p) => `${p.nameserver}: ${p.status}${p.latencyMs > 0 ? ` (${p.latencyMs}ms)` : ''}`).join('; ')}`,
        observedAt,
      },
      {
        source: 'resolution_correctness',
        status: signalStatus(resolutionRate < 0.5 || anyServfail, anyNxdomain || highLatency),
        detail: `Resolution success rate: ${(resolutionRate * 100).toFixed(0)}%. Avg latency: ${avgLatency.toFixed(0)}ms. ${anyNxdomain ? 'Unexpected NXDOMAIN detected. ' : ''}${anyServfail ? 'SERVFAIL responses detected.' : ''}`,
        observedAt,
      },
      {
        source: 'zone_consistency',
        status: signalStatus(splitBrain, dnssecFailure),
        detail: splitBrain
          ? 'Split-brain detected: resolvers returning different answers for the same hostname.'
          : dnssecFailure
            ? 'DNSSEC validation failure detected.'
            : 'Zone consistency: OK.',
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.92,
      summary: {
        healthy: 'DNS resolution is healthy. All configured resolvers are reachable and returning consistent answers.',
        recovering: 'DNS resolution is degraded. One or more resolvers are unreachable, slow, or returning errors.',
        unhealthy: 'DNS resolution is critically impaired. Resolvers are unreachable or resolution is failing for most queries.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring resolver latency and reachability.'],
        recovering: ['Run DNS diagnosis to identify failing resolvers. Consider flushing resolver cache or rotating to backup nameservers.'],
        unhealthy: ['Run the DNS recovery workflow to restore resolution. Check resolver configuration and network connectivity.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const [config, probes, resolutions] = await Promise.all([
      this.backend.getResolvConf(),
      this.backend.probeResolvers('google.com'),
      this.backend.resolveHostnames(['google.com', 'cloudflare.com']),
    ]);

    const timeoutProbes = probes.filter((p) => p.status === 'timeout');
    const servfailProbes = probes.filter((p) => p.status === 'servfail');
    const unreachableProbes = probes.filter((p) => !p.reachable);
    const nxdomainResults = resolutions.filter((r) => r.nxdomain);
    const splitBrain = this.detectSplitBrain(resolutions);
    const dnssecFailure = resolutions.some((r) => r.dnssecValid === false);
    const slowProbes = probes.filter((p) => p.latencyMs > 500);

    // Scenario classification — first match wins
    let scenario: string;
    let confidence: number;

    if (unreachableProbes.length > 0 && unreachableProbes.length === probes.length) {
      scenario = 'resolver_timeout';
      confidence = 0.95;
    } else if (splitBrain) {
      scenario = 'split_brain_dns';
      confidence = 0.93;
    } else if (nxdomainResults.length > 0 && nxdomainResults.length >= resolutions.length * 0.3) {
      scenario = 'nxdomain_storm';
      confidence = 0.90;
    } else if (servfailProbes.length > 0) {
      scenario = 'servfail_responses';
      confidence = 0.92;
    } else if (dnssecFailure) {
      scenario = 'dnssec_validation_failure';
      confidence = 0.88;
    } else if (unreachableProbes.length > 0) {
      scenario = 'resolver_timeout';
      confidence = 0.85;
    } else if (timeoutProbes.length > 0 || slowProbes.length > 0) {
      scenario = timeoutProbes.length > 0 ? 'resolver_timeout' : 'stale_resolvers';
      confidence = 0.85;
    } else {
      scenario = 'stale_resolvers';
      confidence = 0.70;
    }

    return {
      status: 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'resolver_probes',
          observation: `Probed ${probes.length} resolvers: ${probes.map((p) => `${p.nameserver} ${p.status}${p.latencyMs > 0 ? ` (${p.latencyMs}ms)` : ''}`).join(', ')}.`,
          severity: timeoutProbes.length > 0 || servfailProbes.length > 0 ? 'critical' : slowProbes.length > 0 ? 'warning' : 'info',
          data: { probes },
        },
        {
          source: 'resolution_results',
          observation: `Resolved ${resolutions.length} hostname queries. ${nxdomainResults.length > 0 ? `${nxdomainResults.length} returned NXDOMAIN. ` : ''}${resolutions.filter((r) => r.servfail).length > 0 ? `${resolutions.filter((r) => r.servfail).length} returned SERVFAIL. ` : ''}${splitBrain ? 'Split-brain detected across resolvers. ' : ''}`,
          severity: nxdomainResults.length > 0 || splitBrain ? 'critical' : 'info',
          data: { resolutions },
        },
        {
          source: 'resolver_config',
          observation: `${config.nameservers.length} nameserver(s) configured (${config.source}): ${config.nameservers.join(', ')}. Search domains: ${config.searchDomains.length > 0 ? config.searchDomains.join(', ') : 'none'}.`,
          severity: config.nameservers.length === 0 ? 'critical' : 'info',
          data: { config },
        },
        {
          source: 'scenario_evidence',
          observation: `Classified as ${scenario} with ${(confidence * 100).toFixed(0)}% confidence.`,
          severity: 'info',
          data: { scenario, confidence, timeoutCount: timeoutProbes.length, servfailCount: servfailProbes.length, nxdomainCount: nxdomainResults.length, splitBrain, dnssecFailure },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'dns-resolver');
    const scenario = diagnosis.scenario ?? 'stale_resolvers';

    // Find healthy resolvers from diagnosis data for the conditional step
    const probeData = diagnosis.findings.find((f) => f.source === 'resolver_probes')?.data as { probes: ResolverProbe[] } | undefined;
    const healthyResolvers = probeData?.probes.filter((p) => p.reachable && p.status === 'ok') ?? [];
    const failingResolvers = probeData?.probes.filter((p) => !p.reachable || p.status !== 'ok') ?? [];

    const steps: RecoveryStep[] = [
      // Step 1: Capture DNS probe baseline
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture DNS resolver baseline',
        executionContext: 'dns_read',
        target,
        command: {
          type: 'api_call',
          operation: 'probe_resolvers',
          parameters: { testHostname: 'google.com' },
        },
        outputCapture: {
          name: 'dns_baseline',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Notify on-call
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of DNS degradation',
        recipients: [{ role: 'on_call_engineer', urgency: 'high' }],
        message: {
          summary: `DNS resolution degradation detected — ${scenario} on ${target}`,
          detail: `Scenario: ${scenario}. ${failingResolvers.length} resolver(s) failing: ${failingResolvers.map((p) => `${p.nameserver} (${p.status})`).join(', ')}. ${healthyResolvers.length} healthy resolver(s) available.`,
          contextReferences: ['dns_baseline'],
          actionRequired: false,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint — capture resolv.conf before mutations
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Pre-remediation DNS configuration snapshot',
        description: 'Capture current resolver configuration before any mutations.',
        stateCaptures: [
          {
            name: 'resolv_conf_snapshot',
            captureType: 'command_output',
            statement: 'check_resolv_conf',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Flush DNS resolver cache
      {
        stepId: 'step-004',
        type: 'system_action',
        name: 'Flush system DNS resolver cache',
        description: 'Clear the local DNS cache to force re-resolution from upstream nameservers.',
        executionContext: 'dns_write',
        target,
        riskLevel: 'routine',
        requiredCapabilities: ['dns.cache.flush'],
        command: {
          type: 'api_call',
          operation: 'flush_cache',
          parameters: {},
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'DNS cache flushed successfully',
          check: {
            type: 'api_call',
            statement: 'resolver_reachable',
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Cache flush is a safe, non-destructive operation. No rollback needed.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['dns-cache'],
          maxImpact: 'brief_resolution_latency_increase',
          cascadeRisk: 'low',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 1, retryable: true },
      },
      // Step 5: Human approval for resolver reconfiguration
      {
        stepId: 'step-005',
        type: 'human_approval',
        name: 'Approve resolver rotation',
        description: `Approve rotating primary resolver from failing nameserver(s) to healthy alternatives. ${scenario === 'split_brain_dns' || scenario === 'dnssec_validation_failure' ? 'Manual investigation recommended for this scenario.' : ''}`,
        approvers: [{ role: 'on_call_engineer', required: true }],
        requiredApprovals: 1,
        presentation: {
          summary: `DNS ${scenario.replace(/_/g, ' ')} detected on ${target}`,
          detail: `${failingResolvers.length} resolver(s) failing. Proposed action: rotate to healthy nameservers (${healthyResolvers.map((r) => r.nameserver).join(', ') || '8.8.8.8, 1.1.1.1'}).`,
          contextReferences: ['dns_baseline', 'resolv_conf_snapshot'],
          proposedActions: ['Flush DNS resolver cache', 'Rotate to healthy resolver as primary'],
          riskSummary: 'Elevated risk — modifies /etc/resolv.conf. Rollback available via pre-mutation snapshot.',
          alternatives: [
            { action: 'skip', description: 'Skip resolver rotation and continue monitoring' },
            { action: 'manual', description: 'Manually update resolver configuration' },
          ],
        },
        timeout: 'PT15M',
        timeoutAction: 'escalate',
        escalateTo: { role: 'network_engineer', message: 'DNS recovery approval timed out — escalating to network engineer.' },
      },
      // Step 6: Rotate to healthy resolver (elevated risk — modifies system config)
      {
        stepId: 'step-006',
        type: 'system_action',
        name: 'Rotate to healthy resolver as primary',
        description: 'Update resolver configuration to prioritize healthy nameservers.',
        executionContext: 'dns_write',
        target,
        riskLevel: 'elevated',
        requiredCapabilities: ['dns.resolv_conf.write'],
        command: {
          type: 'api_call',
          operation: 'update_resolv_conf',
          parameters: {
            nameservers: healthyResolvers.length > 0
              ? healthyResolvers.map((r) => r.nameserver)
              : ['8.8.8.8', '1.1.1.1'],
          },
        },
        preConditions: [
          {
            description: 'At least one resolver is currently reachable',
            check: {
              type: 'api_call',
              statement: 'resolver_reachable',
              expect: { operator: 'gte', value: 1 },
            },
          },
        ],
        statePreservation: {
          before: [
            {
              name: 'resolv_conf_before_rotation',
              captureType: 'command_output',
              statement: 'check_resolv_conf',
              captureCost: 'negligible',
              capturePolicy: 'required',
              retention: 'P30D',
            },
          ],
          after: [
            {
              name: 'resolv_conf_after_rotation',
              captureType: 'command_output',
              statement: 'check_resolv_conf',
              captureCost: 'negligible',
              capturePolicy: 'best_effort',
              retention: 'P30D',
            },
          ],
        },
        successCriteria: {
          description: 'Resolution working through rotated resolver',
          check: {
            type: 'api_call',
            statement: 'resolution_healthy',
            expect: { operator: 'gte', value: 1 },
          },
        },
        rollback: {
          type: 'manual',
          description: 'Restore the pre-rotation resolv.conf from the resolv_conf_before_rotation capture.',
        },
        blastRadius: {
          directComponents: [target],
          indirectComponents: ['all-dns-dependent-services'],
          maxImpact: 'resolver_configuration_changed',
          cascadeRisk: 'medium',
        },
        timeout: 'PT30S',
        retryPolicy: { maxRetries: 0, retryable: false },
      },
      // Step 7: Replanning checkpoint — assess post-remediation state
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Assess DNS health after remediation',
        description: 'Check if resolver rotation resolved the issue or if further action is needed.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_remediation_dns_state',
            captureType: 'command_output',
            statement: 'verify_resolution',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 8: Conditional — verify resolution or escalate
      {
        stepId: 'step-008',
        type: 'conditional',
        name: 'Verify resolution restored or notify if not',
        condition: {
          description: 'DNS resolution is healthy through at least one resolver',
          check: {
            type: 'api_call',
            statement: 'resolution_healthy',
            expect: { operator: 'gte', value: 1 },
          },
        },
        thenStep: {
          stepId: 'step-008a',
          type: 'human_notification',
          name: 'DNS recovery completed successfully',
          recipients: [
            { role: 'on_call_engineer', urgency: 'medium' },
            { role: 'incident_commander', urgency: 'medium' },
          ],
          message: {
            summary: `DNS recovery completed on ${target}`,
            detail: `Resolver cache flushed and configuration rotated to healthy nameservers. Resolution is restored. Monitor for recurrence.`,
            contextReferences: ['post_remediation_dns_state'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-008b',
          type: 'human_notification',
          name: 'DNS recovery requires manual intervention',
          recipients: [
            { role: 'on_call_engineer', urgency: 'critical' },
            { role: 'network_engineer', urgency: 'high' },
          ],
          message: {
            summary: `DNS recovery incomplete on ${target} — manual intervention required`,
            detail: `Automated remediation (cache flush + resolver rotation) did not fully restore resolution. Manual investigation needed. Scenario: ${scenario}.`,
            contextReferences: ['post_remediation_dns_state', 'dns_baseline'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'dns',
        agentName: 'dns-recovery',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT5M',
        summary: `Recover from DNS ${scenario.replace(/_/g, ' ')} on ${target}: flush resolver cache, rotate to healthy nameservers, verify resolution.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'dns',
            role: 'resolver',
            impactType: 'resolver_configuration_rotated',
          },
        ],
        affectedServices: ['all-dns-dependent-services'],
        estimatedUserImpact: 'Brief increase in resolution latency during cache flush and resolver rotation. No data loss.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'Restore the original resolv.conf from the pre-remediation snapshot. Cache flush is non-destructive and does not require rollback.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return defaultReplan();
  }

  private detectSplitBrain(resolutions: ResolutionResult[]): boolean {
    const byHostname = new Map<string, Set<string>>();

    for (const r of resolutions) {
      if (r.answers.length === 0) continue;
      const key = r.hostname;
      if (!byHostname.has(key)) byHostname.set(key, new Set());
      const answerKey = [...r.answers].sort().join(',');
      byHostname.get(key)!.add(answerKey);
    }

    for (const answerSets of byHostname.values()) {
      if (answerSets.size > 1) return true;
    }

    return false;
  }
}
