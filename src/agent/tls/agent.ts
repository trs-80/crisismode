// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { defaultReplan } from '../interface.js';
import { tlsManifest } from './manifest.js';
import type { TlsBackend, EndpointInspection, ChainValidation } from './backend.js';
import { TlsSimulator } from './simulator.js';

const EXPIRY_WARNING_DAYS = 30;
const WEAK_KEY_SIZE = 2048;

export class TlsCertificateAgent implements RecoveryAgent {
  manifest = tlsManifest;
  backend: TlsBackend;

  constructor(backend?: TlsBackend) {
    this.backend = backend ?? new TlsSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const endpoints = await this.backend.getEndpointConfig();

    const [inspections, validations] = await Promise.all([
      Promise.all(endpoints.map((ep) => this.backend.inspectEndpoint(ep.host, ep.port))),
      Promise.all(endpoints.map((ep) => this.backend.checkChainValidity(ep.host, ep.port))),
    ]);

    const anyExpired = inspections.some((i) => i.certificate && i.certificate.daysUntilExpiry < 0);
    const anyExpiringSoon = inspections.some((i) => i.certificate && i.certificate.daysUntilExpiry >= 0 && i.certificate.daysUntilExpiry <= EXPIRY_WARNING_DAYS);
    const anyChainInvalid = validations.some((v) => !v.valid);
    const anyHostnameMismatch = validations.some((v) => !v.hostnameMatch);
    const anyConnectFailure = inspections.some((i) => i.error !== null && i.certificate === null);
    const anyWeakKey = inspections.some((i) => i.certificate && i.certificate.keySize > 0 && i.certificate.keySize < WEAK_KEY_SIZE);
    const anyWeakProtocol = inspections.some((i) => i.tlsVersion !== null && !i.tlsVersion.includes('1.3') && !i.tlsVersion.includes('1.2'));

    const status = anyExpired || anyChainInvalid || anyHostnameMismatch
      ? 'unhealthy'
      : anyExpiringSoon || anyConnectFailure || anyWeakKey || anyWeakProtocol
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'certificate_expiry',
        status: signalStatus(anyExpired, anyExpiringSoon),
        detail: inspections
          .filter((i) => i.certificate)
          .map((i) => `${i.host}:${i.port}: ${i.certificate!.daysUntilExpiry}d until expiry (${i.certificate!.subject.CN})`)
          .join('; ') || 'No certificates inspected.',
        observedAt,
      },
      {
        source: 'chain_validation',
        status: signalStatus(anyChainInvalid || anyHostnameMismatch, false),
        detail: validations
          .map((v) => `${v.host}:${v.port}: ${v.valid ? 'valid' : `INVALID (${v.errorCode ?? v.error})`}${!v.hostnameMatch ? ' [hostname mismatch]' : ''}`)
          .join('; '),
        observedAt,
      },
      {
        source: 'crypto_strength',
        status: signalStatus(false, anyWeakKey || anyWeakProtocol),
        detail: inspections
          .filter((i) => i.certificate)
          .map((i) => `${i.host}:${i.port}: ${i.tlsVersion ?? 'unknown'}, ${i.certificate!.keyAlgorithm} ${i.certificate!.keySize}-bit`)
          .join('; '),
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.95,
      summary: {
        healthy: 'TLS certificate health is good. All certificates are valid, chains verify, and cryptographic configurations are strong.',
        recovering: 'TLS certificate health is degraded. One or more certificates are expiring soon or have weak cryptographic configurations.',
        unhealthy: 'TLS certificate health is critical. Expired certificates, chain validation failures, or hostname mismatches detected.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring certificate expiry dates.'],
        recovering: ['Renew expiring certificates. Upgrade weak keys or TLS protocol versions.'],
        unhealthy: ['Immediately renew expired certificates and fix chain/hostname issues.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const endpoints = await this.backend.getEndpointConfig();

    const [inspections, validations] = await Promise.all([
      Promise.all(endpoints.map((ep) => this.backend.inspectEndpoint(ep.host, ep.port))),
      Promise.all(endpoints.map((ep) => this.backend.checkChainValidity(ep.host, ep.port))),
    ]);

    const expiredCerts = inspections.filter((i) => i.certificate && i.certificate.daysUntilExpiry < 0);
    const expiringCerts = inspections.filter((i) => i.certificate && i.certificate.daysUntilExpiry >= 0 && i.certificate.daysUntilExpiry <= EXPIRY_WARNING_DAYS);
    const chainFailures = validations.filter((v) => !v.valid);
    const hostnameMismatches = validations.filter((v) => !v.hostnameMatch);
    const weakCerts = inspections.filter((i) => i.certificate && i.certificate.keySize > 0 && i.certificate.keySize < WEAK_KEY_SIZE);
    const weakProtocols = inspections.filter((i) => i.tlsVersion !== null && !i.tlsVersion.includes('1.3') && !i.tlsVersion.includes('1.2'));

    // Scenario classification — first match wins
    let scenario: string | null;
    let confidence: number;

    if (expiredCerts.length > 0) {
      scenario = 'certificate_expired';
      confidence = 0.98;
    } else if (hostnameMismatches.length > 0) {
      scenario = 'certificate_hostname_mismatch';
      confidence = 0.95;
    } else if (chainFailures.length > 0) {
      scenario = 'certificate_chain_invalid';
      confidence = 0.93;
    } else if (expiringCerts.length > 0) {
      scenario = 'certificate_expiring_soon';
      confidence = 0.95;
    } else if (weakCerts.length > 0 || weakProtocols.length > 0) {
      scenario = 'weak_key_or_protocol';
      confidence = 0.90;
    } else {
      scenario = null;
      confidence = 1.0;
    }

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'certificate_expiry',
          observation: expiredCerts.length > 0
            ? `${expiredCerts.length} certificate(s) EXPIRED: ${expiredCerts.map((i) => `${i.host}:${i.port} (expired ${Math.abs(i.certificate!.daysUntilExpiry)}d ago)`).join(', ')}.`
            : expiringCerts.length > 0
              ? `${expiringCerts.length} certificate(s) expiring soon: ${expiringCerts.map((i) => `${i.host}:${i.port} (${i.certificate!.daysUntilExpiry}d remaining)`).join(', ')}.`
              : 'All certificates have sufficient validity remaining.',
          severity: expiredCerts.length > 0 ? 'critical' : expiringCerts.length > 0 ? 'warning' : 'info',
          data: { expiredCerts, expiringCerts, inspections },
        },
        {
          source: 'chain_validation',
          observation: chainFailures.length > 0
            ? `${chainFailures.length} chain validation failure(s): ${chainFailures.map((v) => `${v.host}:${v.port} (${v.errorCode ?? v.error})`).join(', ')}.`
            : 'All certificate chains validate against system CA store.',
          severity: chainFailures.length > 0 ? 'critical' : 'info',
          data: { validations },
        },
        {
          source: 'hostname_match',
          observation: hostnameMismatches.length > 0
            ? `${hostnameMismatches.length} hostname mismatch(es): ${hostnameMismatches.map((v) => `${v.host}:${v.port}`).join(', ')}.`
            : 'All certificates match their endpoint hostnames.',
          severity: hostnameMismatches.length > 0 ? 'critical' : 'info',
          data: { hostnameMismatches },
        },
        {
          source: 'crypto_strength',
          observation: weakCerts.length > 0 || weakProtocols.length > 0
            ? `Weak cryptography: ${[...weakCerts.map((i) => `${i.host}:${i.port} (${i.certificate!.keySize}-bit key)`), ...weakProtocols.map((i) => `${i.host}:${i.port} (${i.tlsVersion})`)].join(', ')}.`
            : 'All endpoints use strong cryptographic configurations.',
          severity: weakCerts.length > 0 || weakProtocols.length > 0 ? 'warning' : 'info',
          data: { weakCerts, weakProtocols },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'tls-endpoints');
    const scenario = diagnosis.scenario ?? 'certificate_expiring_soon';

    // Extract affected endpoints from diagnosis
    const expiryData = diagnosis.findings.find((f) => f.source === 'certificate_expiry')?.data as {
      expiredCerts: EndpointInspection[];
      expiringCerts: EndpointInspection[];
      inspections: EndpointInspection[];
    } | undefined;

    const affectedEndpoints = [
      ...(expiryData?.expiredCerts ?? []),
      ...(expiryData?.expiringCerts ?? []),
    ];

    const chainData = diagnosis.findings.find((f) => f.source === 'chain_validation')?.data as {
      validations: ChainValidation[];
    } | undefined;

    const chainFailures = chainData?.validations.filter((v) => !v.valid) ?? [];

    // Determine primary target endpoint — prefer affected, fall back to chain failures, then target string
    const primaryEndpoint = affectedEndpoints[0] ?? chainFailures[0] ?? { host: target, port: 443 };

    const steps: RecoveryStep[] = [
      // Step 1: Full certificate inspection across all endpoints
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture full certificate status across all endpoints',
        executionContext: 'tls_read',
        target,
        command: {
          type: 'api_call',
          operation: 'inspect_endpoint',
          parameters: { host: primaryEndpoint.host, port: primaryEndpoint.port },
        },
        outputCapture: {
          name: 'tls_baseline',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Alert on-call about certificate issues
      {
        stepId: 'step-002',
        type: 'human_notification',
        name: 'Notify on-call of TLS certificate issue',
        recipients: [
          { role: 'on_call_engineer', urgency: scenario === 'certificate_expired' ? 'critical' : 'high' },
          { role: 'security_engineer', urgency: 'high' },
        ],
        message: {
          summary: `TLS certificate issue detected — ${scenario.replace(/_/g, ' ')} on ${target}`,
          detail: this.buildNotificationDetail(scenario, affectedEndpoints, chainFailures),
          contextReferences: ['tls_baseline'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      // Step 3: Checkpoint — record current certificate state
      {
        stepId: 'step-003',
        type: 'checkpoint',
        name: 'Record current certificate state',
        description: 'Capture detailed certificate information for audit trail and post-incident review.',
        stateCaptures: [
          {
            name: 'cert_state_snapshot',
            captureType: 'command_output',
            statement: 'check_config',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 4: Chain validation verification
      {
        stepId: 'step-004',
        type: 'diagnosis_action',
        name: 'Validate certificate chain integrity',
        executionContext: 'tls_read',
        target,
        command: {
          type: 'api_call',
          operation: 'validate_chain',
          parameters: { host: primaryEndpoint.host, port: primaryEndpoint.port },
        },
        outputCapture: {
          name: 'chain_validation_result',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 5: Conditional — different notification based on severity
      {
        stepId: 'step-005',
        type: 'conditional',
        name: 'Route based on certificate validity',
        condition: {
          description: 'At least one certificate validates successfully',
          check: {
            type: 'api_call',
            statement: 'cert_valid',
            expect: { operator: 'gte', value: 1 },
          },
        },
        thenStep: {
          stepId: 'step-005a',
          type: 'human_notification',
          name: 'Certificate renewal guidance',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `Certificate renewal needed for ${target}`,
            detail: this.buildRenewalGuidance(scenario, affectedEndpoints),
            contextReferences: ['tls_baseline', 'chain_validation_result'],
            actionRequired: true,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-005b',
          type: 'human_notification',
          name: 'URGENT: All certificates invalid',
          recipients: [
            { role: 'on_call_engineer', urgency: 'critical' },
            { role: 'security_engineer', urgency: 'critical' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `CRITICAL: No valid certificates — ${target} is serving invalid TLS`,
            detail: `All monitored endpoints have certificate validation failures. Users will see browser security warnings. Immediate certificate renewal or replacement is required.`,
            contextReferences: ['tls_baseline', 'chain_validation_result'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 6: Replanning checkpoint
      {
        stepId: 'step-006',
        type: 'replanning_checkpoint',
        name: 'Assess certificate status after notification',
        description: 'Check if certificates have been renewed since notification was sent.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_notification_cert_state',
            captureType: 'command_output',
            statement: 'inspect_endpoint',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 7: Final summary notification
      {
        stepId: 'step-007',
        type: 'human_notification',
        name: 'TLS certificate recovery summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'low' },
        ],
        message: {
          summary: `TLS certificate assessment complete for ${target}`,
          detail: `Scenario: ${scenario.replace(/_/g, ' ')}. Certificate status has been captured, chain validated, and responsible teams notified. Follow up on renewal actions.`,
          contextReferences: ['post_notification_cert_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'tls',
        agentName: 'tls-certificate-recovery',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT3M',
        summary: `Assess and alert on TLS certificate ${scenario.replace(/_/g, ' ')} for ${target}: inspect certificates, validate chains, and notify responsible teams.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'tls',
            role: 'endpoint',
            impactType: 'certificate_assessment_and_notification',
          },
        ],
        affectedServices: affectedEndpoints.map((ep) => `${ep.host}:${ep.port}`),
        estimatedUserImpact: scenario === 'certificate_expired'
          ? 'Users may see certificate warnings or connection failures. Immediate renewal required.'
          : 'No immediate user impact. Proactive renewal prevents future outage.',
        dataLossRisk: 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'This plan is read-only and notification-based. No system mutations to roll back.',
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

  private buildNotificationDetail(
    scenario: string,
    affectedEndpoints: EndpointInspection[],
    chainFailures: ChainValidation[],
  ): string {
    const parts: string[] = [];

    if (scenario === 'certificate_expired') {
      parts.push(`EXPIRED certificates: ${affectedEndpoints.map((ep) => `${ep.host}:${ep.port} (expired ${Math.abs(ep.certificate!.daysUntilExpiry)}d ago)`).join(', ')}.`);
    } else if (scenario === 'certificate_expiring_soon') {
      parts.push(`Expiring certificates: ${affectedEndpoints.map((ep) => `${ep.host}:${ep.port} (${ep.certificate!.daysUntilExpiry}d remaining)`).join(', ')}.`);
    }

    if (chainFailures.length > 0) {
      parts.push(`Chain failures: ${chainFailures.map((v) => `${v.host}:${v.port} (${v.errorCode ?? v.error})`).join(', ')}.`);
    }

    if (scenario === 'certificate_hostname_mismatch') {
      parts.push('Hostname mismatch detected — certificate Subject Alternative Names do not include the endpoint hostname.');
    }

    if (scenario === 'weak_key_or_protocol') {
      parts.push('Weak cryptographic configuration detected. Upgrade key size to >=2048-bit RSA or use ECDSA. Ensure TLS 1.2+ is required.');
    }

    return parts.join(' ') || `TLS issue: ${scenario.replace(/_/g, ' ')}.`;
  }

  private buildRenewalGuidance(scenario: string, affectedEndpoints: EndpointInspection[]): string {
    const hosts = affectedEndpoints.map((ep) => `${ep.host}:${ep.port}`).join(', ') || 'configured endpoints';

    switch (scenario) {
      case 'certificate_expired':
        return `Immediate renewal required for: ${hosts}. If using ACME/Let's Encrypt, run certbot renew. For internal CAs, generate new certificates and redeploy.`;
      case 'certificate_expiring_soon':
        return `Proactive renewal recommended for: ${hosts}. Certificates expire within ${EXPIRY_WARNING_DAYS} days. Schedule renewal before expiry to avoid outage.`;
      case 'certificate_chain_invalid':
        return `Certificate chain validation failed for: ${hosts}. Verify intermediate certificates are correctly bundled. Check if the CA certificate has been revoked or rotated.`;
      case 'certificate_hostname_mismatch':
        return `Certificate hostname mismatch for: ${hosts}. Regenerate certificates with correct Subject Alternative Names matching the endpoint hostname.`;
      case 'weak_key_or_protocol':
        return `Weak cryptography detected for: ${hosts}. Generate new certificates with >=2048-bit RSA or ECDSA P-256+ keys. Configure endpoints to require TLS 1.2 or higher.`;
      default:
        return `Certificate issue detected for: ${hosts}. Review certificate configuration and renew as needed.`;
    }
  }
}
