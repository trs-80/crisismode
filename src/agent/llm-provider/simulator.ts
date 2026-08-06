// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * In-memory scenario simulator for the llm-provider agent. Never touches the
 * network and never reads the environment — every value below is fixture data,
 * including the fake key whose fingerprint appears in output.
 */

import type {
  KeyPresence,
  KeyValidity,
  LlmProviderBackend,
  ModelCheck,
  ProviderStatusReport,
  RateLimitHeadroom,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { fingerprintKey, getProviderSpec, type LlmProviderId } from './provider-table.js';

export type LlmProviderScenario =
  | 'healthy'
  | 'no_key'
  | 'bad_key'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'key_scope_limited'
  | 'deprecated_model'
  | 'provider_incident';

/** Fixture key — not a credential; only its last 4 characters are ever shown. */
const FIXTURE_KEY = 'sk-ant-simulator-fixture-notarealkey';

const LIVE_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-haiku-4-5',
];

export class LlmProviderSimulator implements LlmProviderBackend {
  constructor(
    private scenario: LlmProviderScenario = 'healthy',
    private readonly provider: LlmProviderId = 'anthropic',
  ) {}

  getProviderId(): LlmProviderId {
    return this.provider;
  }

  transition(to: string): void {
    this.scenario = to as LlmProviderScenario;
  }

  private get spec() {
    return getProviderSpec(this.provider)!;
  }

  async checkKeyPresence(): Promise<KeyPresence> {
    const checkedEnvVars = this.spec.envVars;
    if (this.scenario === 'no_key') {
      return { provider: this.provider, present: false, envVar: null, fingerprint: null, checkedEnvVars };
    }
    return {
      provider: this.provider,
      present: true,
      envVar: checkedEnvVars[0]!,
      fingerprint: fingerprintKey(FIXTURE_KEY),
      checkedEnvVars,
    };
  }

  async checkKeyValidity(): Promise<KeyValidity> {
    switch (this.scenario) {
      case 'no_key':
        return {
          provider: this.provider,
          outcome: 'unknown',
          httpStatus: null,
          detail: 'No API key to test — key validity cannot be determined.',
        };
      case 'bad_key':
        return {
          provider: this.provider,
          outcome: 'invalid_key',
          httpStatus: 401,
          detail: `${this.spec.label} rejected the API key (HTTP 401 authentication_error) — every AI request is failing.`,
        };
      case 'quota_exhausted':
        return {
          provider: this.provider,
          outcome: 'billing_or_quota',
          httpStatus: 429,
          detail: `${this.spec.label} reports the account is out of quota or credit (HTTP 429) — requests are failing until billing is topped up.`,
        };
      case 'rate_limited':
        return {
          provider: this.provider,
          outcome: 'rate_limited',
          httpStatus: 429,
          detail: `${this.spec.label} is rate limiting this key right now (HTTP 429 rate_limit_error) — the key itself is fine.`,
        };
      case 'key_scope_limited':
        return {
          provider: this.provider,
          outcome: 'permission',
          httpStatus: 403,
          detail: `${this.spec.label} accepted the API key but it lacks permission for this endpoint (HTTP 403 permission_error) — the key is valid and other calls may still succeed; check the key's scopes/permissions in the ${this.spec.label} console.`,
        };
      default:
        return {
          provider: this.provider,
          outcome: 'valid',
          httpStatus: 200,
          detail: `${this.spec.label} accepted the API key.`,
        };
    }
  }

  async checkRateLimitHeadroom(): Promise<RateLimitHeadroom> {
    if (!this.spec.rateLimitHeaderPrefix) {
      return {
        provider: this.provider,
        known: false,
        requestsRemainingPct: null,
        tokensRemainingPct: null,
        detail: `${this.spec.label} does not publish rate-limit response headers — headroom is unknown, not zero.`,
      };
    }
    if (this.scenario === 'no_key' || this.scenario === 'bad_key') {
      return {
        provider: this.provider,
        known: false,
        requestsRemainingPct: null,
        tokensRemainingPct: null,
        detail: 'No authenticated response to read rate-limit headers from.',
      };
    }
    if (this.scenario === 'rate_limited') {
      return {
        provider: this.provider,
        known: true,
        requestsRemainingPct: 4,
        tokensRemainingPct: 11,
        detail: `${this.spec.label} rate-limit headroom is low: 4% of requests and 11% of tokens remain — requests may start failing.`,
      };
    }
    return {
      provider: this.provider,
      known: true,
      requestsRemainingPct: 92,
      tokensRemainingPct: 88,
      detail: `${this.spec.label} rate-limit headroom: 92% of requests and 88% of tokens remain.`,
    };
  }

  async checkModel(): Promise<ModelCheck> {
    if (this.scenario === 'deprecated_model') {
      return {
        provider: this.provider,
        configuredModel: 'claude-3-sonnet-20240229',
        source: 'env',
        listKnown: true,
        presentInList: false,
        sampleModels: LIVE_MODELS,
        detail:
          "The configured model 'claude-3-sonnet-20240229' is not in the live model list — this is a config mismatch and requests naming it will fail.",
      };
    }
    if (this.scenario === 'no_key' || this.scenario === 'bad_key') {
      return {
        provider: this.provider,
        configuredModel: null,
        source: null,
        listKnown: false,
        presentInList: null,
        sampleModels: [],
        detail: 'Model list could not be read without a working API key.',
      };
    }
    return {
      provider: this.provider,
      configuredModel: LIVE_MODELS[0]!,
      source: 'env',
      listKnown: true,
      presentInList: true,
      sampleModels: LIVE_MODELS,
      detail: `The configured model '${LIVE_MODELS[0]}' is available.`,
    };
  }

  async checkProviderStatus(): Promise<ProviderStatusReport> {
    if (this.scenario === 'provider_incident') {
      return {
        provider: this.provider,
        known: true,
        ongoingIncidents: [
          {
            title: 'Elevated error rates on the Messages API',
            impact: 'major',
            url: 'https://status.anthropic.com/incidents/simulated',
          },
        ],
        detail: `${this.spec.label} reports 1 ongoing incident: Elevated error rates on the Messages API (major).`,
      };
    }
    return {
      provider: this.provider,
      known: true,
      ongoingIncidents: [],
      detail: `${this.spec.label} reports no ongoing incidents.`,
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported llm-provider simulator command type: ${command.type}`);
    }
    if (command.operation === 'llm_provider_check') {
      return {
        keyPresence: await this.checkKeyPresence(),
        keyValidity: await this.checkKeyValidity(),
        rateLimitHeadroom: await this.checkRateLimitHeadroom(),
        model: await this.checkModel(),
        providerStatus: await this.checkProviderStatus(),
      };
    }
    return { simulated: true, operation: command.operation, parameters: command.parameters };
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'llm_key_valid') {
      const validity = await this.checkKeyValidity();
      return compareCheckValue(validity.outcome === 'valid' ? 'ok' : 'fail', check.expect.operator, check.expect.value);
    }
    if (stmt === 'llm_rate_limit_remaining_pct') {
      const headroom = await this.checkRateLimitHeadroom();
      return compareCheckValue(headroom.requestsRemainingPct ?? 0, check.expect.operator, check.expect.value);
    }
    if (stmt === 'llm_provider_incidents') {
      const status = await this.checkProviderStatus();
      return compareCheckValue(status.ongoingIncidents.length, check.expect.operator, check.expect.value);
    }

    return true;
  }

  async close(): Promise<void> {}
}
