// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult, DiagnosisFinding } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal, HealthSignalStatus, HealthStatus } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import { defaultReplan } from '../interface.js';
import { buildLlmProviderManifest } from './manifest.js';
import { getProviderSpec } from './provider-table.js';
import { LLM_PROVIDER_CHECK_IDS } from './check-ids.js';
import type {
  KeyPresence,
  KeyValidity,
  LlmProviderBackend,
  ModelCheck,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';
import type { AgentManifest } from '../../types/manifest.js';
import { LlmProviderSimulator } from './simulator.js';
import { defaultOfflineGate, type ObserverOffline, type OfflineGate } from './offline-gate.js';

/** Below this much remaining request headroom the provider layer is degraded. */
const HEADROOM_WARN_PCT = 20;

interface CheckBundle {
  presence: KeyPresence;
  /** Non-null when triage says the observer, not the provider, is the problem. */
  offline: ObserverOffline | null;
  validity: KeyValidity | null;
  headroom: RateLimitHeadroom | null;
  model: ModelCheck | null;
  status: ProviderStatusReport | null;
}

/**
 * One class, four registrations. `manifest` is built from the backend's own
 * `getProviderId()` rather than imported as a shared constant — each
 * provider's registration (Task 9) supplies a backend already bound to its
 * provider, so the manifest — and with it the per-provider maturity claim —
 * always matches the registration that constructed this instance.
 */
export class LlmProviderDiagnosisAgent implements RecoveryAgent {
  manifest: AgentManifest;
  backend: LlmProviderBackend;

  private readonly offlineGate: OfflineGate;

  constructor(backend?: LlmProviderBackend, offlineGate: OfflineGate = defaultOfflineGate) {
    this.backend = backend ?? new LlmProviderSimulator();
    this.manifest = buildLlmProviderManifest(this.backend.getProviderId());
    this.offlineGate = offlineGate;
  }

  private get label(): string {
    const provider = this.backend.getProviderId();
    return getProviderSpec(provider)?.label ?? provider;
  }

  /**
   * Run the checks that are worth running.
   *
   * key_present is always real — it reads the environment and works offline.
   * The five network checks are skipped when triage has localised the failure
   * to this machine, and the key-dependent ones are skipped when there is no
   * key to test. Provider status needs no key, so it still runs in that case.
   */
  private async runChecks(): Promise<CheckBundle> {
    const presence = await this.backend.checkKeyPresence();
    const offline = await this.offlineGate();

    if (offline) {
      return { presence, offline, validity: null, headroom: null, model: null, status: null };
    }

    if (!presence.present) {
      const status = await this.backend.checkProviderStatus();
      return { presence, offline: null, validity: null, headroom: null, model: null, status };
    }

    const [validity, headroom, model, status] = await Promise.all([
      this.backend.checkKeyValidity(),
      this.backend.checkRateLimitHeadroom(),
      this.backend.checkModel(),
      this.backend.checkProviderStatus(),
    ]);
    return { presence, offline: null, validity, headroom, model, status };
  }

  private buildSignals(bundle: CheckBundle, observedAt: string): HealthSignal[] {
    const { presence, offline } = bundle;
    const label = this.label;

    const skipDetail = offline
      ? `Skipped — ${offline.explanation}. CrisisMode cannot tell whether ${label} is healthy from a machine that is offline, so it is not guessing.`
      : `Skipped — no ${label} API key in this environment, so there is nothing to test.`;

    const signal = (
      source: string,
      checkId: string,
      status: HealthSignalStatus,
      detail: string,
    ): HealthSignal => ({ source, status, detail, observedAt, checkId });

    const signals: HealthSignal[] = [
      presence.present
        ? signal(
            'llm_key_present',
            LLM_PROVIDER_CHECK_IDS.keyPresent,
            'healthy',
            `${label} API key found in ${presence.envVar} (${presence.fingerprint}).`,
          )
        : signal(
            'llm_key_present',
            LLM_PROVIDER_CHECK_IDS.keyPresent,
            'critical',
            `No ${label} API key in this process's environment (checked ${presence.checkedEnvVars.join(', ')}). CrisisMode reads process.env only — it never parses .env files, so a key that lives in .env is invisible here.`,
          ),
    ];

    // key_valid
    if (bundle.validity === null) {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'unknown', skipDetail));
    } else if (bundle.validity.outcome === 'invalid_key' || bundle.validity.outcome === 'permission') {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'critical', bundle.validity.detail));
    } else if (bundle.validity.outcome === 'unknown' || bundle.validity.outcome === 'other') {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'unknown', bundle.validity.detail));
    } else {
      signals.push(signal('llm_key_valid', LLM_PROVIDER_CHECK_IDS.keyValid, 'healthy', bundle.validity.detail));
    }

    // quota_billing — same probe, different question.
    if (bundle.validity === null) {
      signals.push(signal('llm_quota_billing', LLM_PROVIDER_CHECK_IDS.quotaBilling, 'unknown', skipDetail));
    } else if (bundle.validity.outcome === 'billing_or_quota') {
      signals.push(signal('llm_quota_billing', LLM_PROVIDER_CHECK_IDS.quotaBilling, 'critical', bundle.validity.detail));
    } else if (bundle.validity.outcome === 'valid' || bundle.validity.outcome === 'rate_limited') {
      signals.push(
        signal(
          'llm_quota_billing',
          LLM_PROVIDER_CHECK_IDS.quotaBilling,
          'healthy',
          `${label} returned no billing or quota error on the probe request.`,
        ),
      );
    } else {
      signals.push(
        signal(
          'llm_quota_billing',
          LLM_PROVIDER_CHECK_IDS.quotaBilling,
          'unknown',
          `Quota and billing state could not be determined: ${bundle.validity.detail}`,
        ),
      );
    }

    // rate_limit_headroom
    if (bundle.headroom === null) {
      signals.push(signal('llm_rate_limit_headroom', LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom, 'unknown', skipDetail));
    } else if (!bundle.headroom.known) {
      signals.push(signal('llm_rate_limit_headroom', LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom, 'unknown', bundle.headroom.detail));
    } else {
      const low = (bundle.headroom.requestsRemainingPct ?? 100) < HEADROOM_WARN_PCT
        || (bundle.headroom.tokensRemainingPct ?? 100) < HEADROOM_WARN_PCT;
      signals.push(
        signal(
          'llm_rate_limit_headroom',
          LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
          low ? 'warning' : 'healthy',
          bundle.headroom.detail,
        ),
      );
    }

    // model_deprecated
    if (bundle.model === null) {
      signals.push(signal('llm_model_deprecated', LLM_PROVIDER_CHECK_IDS.modelDeprecated, 'unknown', skipDetail));
    } else if (!bundle.model.listKnown || bundle.model.configuredModel === null) {
      signals.push(signal('llm_model_deprecated', LLM_PROVIDER_CHECK_IDS.modelDeprecated, 'unknown', bundle.model.detail));
    } else {
      signals.push(
        signal(
          'llm_model_deprecated',
          LLM_PROVIDER_CHECK_IDS.modelDeprecated,
          bundle.model.presentInList === false ? 'warning' : 'healthy',
          bundle.model.detail,
        ),
      );
    }

    // provider_status
    if (bundle.status === null) {
      signals.push(signal('llm_provider_status', LLM_PROVIDER_CHECK_IDS.providerStatus, 'unknown', skipDetail));
    } else if (!bundle.status.known) {
      signals.push(signal('llm_provider_status', LLM_PROVIDER_CHECK_IDS.providerStatus, 'unknown', bundle.status.detail));
    } else {
      signals.push(
        signal(
          'llm_provider_status',
          LLM_PROVIDER_CHECK_IDS.providerStatus,
          bundle.status.ongoingIncidents.length > 0 ? 'warning' : 'healthy',
          bundle.status.detail,
        ),
      );
    }

    return signals;
  }

  private overallStatus(signals: HealthSignal[]): HealthStatus {
    if (signals.some((s) => s.status === 'critical')) return 'unhealthy';
    if (signals.some((s) => s.status === 'warning')) return 'recovering';
    // Every network check unknown means we learned nothing about the provider.
    const networkChecks = signals.filter((s) => s.checkId !== LLM_PROVIDER_CHECK_IDS.keyPresent);
    if (networkChecks.every((s) => s.status === 'unknown')) return 'unknown';
    return 'healthy';
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const bundle = await this.runChecks();
    const signals = this.buildSignals(bundle, observedAt);
    const status = this.overallStatus(signals);
    const label = this.label;

    if (bundle.offline) {
      return {
        status,
        confidence: 0.3,
        summary: `${label} checks were skipped: ${bundle.offline.explanation}. Fix this machine's connectivity first — nothing here says ${label} is unhealthy.`,
        observedAt,
        signals,
        recommendedActions: [
          'Run `crisismode triage` for the full localisation detail and next step.',
          `Re-run this check once this machine is back online to learn the real ${label} state.`,
        ],
      };
    }

    const summary =
      status === 'unhealthy'
        ? `${label} is not usable from this environment: ${signals.find((s) => s.status === 'critical')!.detail}`
        : status === 'recovering'
          ? `${label} is reachable but degraded: ${signals.find((s) => s.status === 'warning')!.detail}`
          : status === 'unknown'
            ? `${label} state could not be determined — every live check returned an honest unknown.`
            : `${label} is healthy: the API key works, quota and rate-limit headroom are fine, the configured model exists, and the provider reports no incidents.`;

    const recommendedActions =
      status === 'unhealthy'
        ? [
            `Open the ${label} console and confirm the API key and billing state.`,
            'After fixing it, re-run `crisismode scan` to confirm the check turns green.',
          ]
        : status === 'recovering'
          ? [
              `Review the ${label} usage dashboard — the app is close to a limit or the provider is mid-incident.`,
              'Retry-with-backoff on the client side keeps requests alive through short rate-limit and incident windows.',
            ]
          : status === 'unknown'
            ? ['Re-run the check when the provider endpoints are reachable — no conclusion should be drawn from this result.']
            : ['No action required. Continue monitoring.'];

    return { status, confidence: status === 'unknown' ? 0.3 : 0.95, summary, observedAt, signals, recommendedActions };
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const bundle = await this.runChecks();
    const label = this.label;

    if (bundle.offline) {
      return {
        status: 'unable',
        scenario: null,
        confidence: 0,
        findings: [
          {
            source: 'llm_provider_status',
            checkId: LLM_PROVIDER_CHECK_IDS.providerStatus,
            observation: `${label} could not be diagnosed from this machine: ${bundle.offline.explanation}.`,
            severity: 'info',
            data: { offline: bundle.offline, keyPresence: bundle.presence },
          },
        ],
        diagnosticPlanNeeded: false,
      };
    }

    const headroomLow =
      bundle.headroom?.known === true &&
      ((bundle.headroom.requestsRemainingPct ?? 100) < HEADROOM_WARN_PCT ||
        (bundle.headroom.tokensRemainingPct ?? 100) < HEADROOM_WARN_PCT);

    let scenario: string | null;
    let confidence: number;

    if (!bundle.presence.present) {
      scenario = 'api_key_missing';
      confidence = 0.99;
    } else if (bundle.validity?.outcome === 'invalid_key' || bundle.validity?.outcome === 'permission') {
      scenario = 'api_key_invalid';
      confidence = 0.98;
    } else if (bundle.validity?.outcome === 'billing_or_quota') {
      scenario = 'quota_or_billing_exhausted';
      confidence = 0.97;
    } else if (bundle.model?.presentInList === false) {
      scenario = 'configured_model_unavailable';
      confidence = 0.9;
    } else if (headroomLow) {
      scenario = 'rate_limit_headroom_low';
      confidence = 0.9;
    } else if ((bundle.status?.ongoingIncidents.length ?? 0) > 0) {
      scenario = 'provider_incident';
      confidence = 0.85;
    } else {
      scenario = null;
      confidence = 1.0;
    }

    // Every finding carries its checkId: the guidance registry keys diagnose-path
    // advice on this field alone, so an untagged finding silently gets none.
    const findings: DiagnosisFinding[] = [
      {
        source: 'llm_key_present',
        checkId: LLM_PROVIDER_CHECK_IDS.keyPresent,
        observation: bundle.presence.present
          ? `${label} API key found in ${bundle.presence.envVar} (${bundle.presence.fingerprint}).`
          : `No ${label} API key in this process's environment (checked ${bundle.presence.checkedEnvVars.join(', ')}). CrisisMode reads process.env only and never parses .env files.`,
        severity: bundle.presence.present ? 'info' : 'critical',
        data: { presence: bundle.presence },
      },
      {
        source: 'llm_key_valid',
        checkId: LLM_PROVIDER_CHECK_IDS.keyValid,
        observation: bundle.validity?.detail ?? 'Key validity was not tested.',
        severity:
          bundle.validity?.outcome === 'invalid_key' || bundle.validity?.outcome === 'permission' ? 'critical' : 'info',
        data: { validity: bundle.validity },
      },
      {
        source: 'llm_quota_billing',
        checkId: LLM_PROVIDER_CHECK_IDS.quotaBilling,
        observation:
          bundle.validity?.outcome === 'billing_or_quota'
            ? bundle.validity.detail
            : `No billing or quota error observed for ${label}.`,
        severity: bundle.validity?.outcome === 'billing_or_quota' ? 'critical' : 'info',
        data: { validity: bundle.validity },
      },
      {
        source: 'llm_rate_limit_headroom',
        checkId: LLM_PROVIDER_CHECK_IDS.rateLimitHeadroom,
        observation: bundle.headroom?.detail ?? 'Rate-limit headroom was not read.',
        severity: headroomLow ? 'warning' : 'info',
        data: { headroom: bundle.headroom },
      },
      {
        source: 'llm_model_deprecated',
        checkId: LLM_PROVIDER_CHECK_IDS.modelDeprecated,
        observation: bundle.model?.detail ?? 'The configured model was not verified.',
        severity: bundle.model?.presentInList === false ? 'warning' : 'info',
        data: { model: bundle.model },
      },
      {
        source: 'llm_provider_status',
        checkId: LLM_PROVIDER_CHECK_IDS.providerStatus,
        observation: bundle.status?.detail ?? 'Provider status was not read.',
        severity: (bundle.status?.ongoingIncidents.length ?? 0) > 0 ? 'warning' : 'info',
        data: { providerStatus: bundle.status },
      },
    ];

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings,
      diagnosticPlanNeeded: false,
    };
  }

  async plan(_context: AgentContext, _diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    throw new Error('not implemented — Task 6');
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return defaultReplan();
  }
}
