// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { CheckExpression, Command } from '../../types/common.js';
import { compareCheckValue } from '../../framework/check-helpers.js';
import { verdictDetail } from '../../framework/service-status/checker.js';
import type {
  ProbeOutcome, ServiceStatusReport, ServiceVerdict, StatusAssessment, StatusIncident,
} from '../../framework/service-status/types.js';
import type { ServiceStatusBackend } from './backend.js';
import { isUnreachableVerdict, worstVerdict } from './verdict-rank.js';

export type SimulatorState = 'healthy' | 'incident' | 'degraded' | 'down_for_you' | 'status_unavailable';

const SCENARIOS: SimulatorState[] = ['healthy', 'incident', 'degraded', 'down_for_you', 'status_unavailable'];

/** Simulated label, per the spec — never mistaken for a real live-checked report. */
const LABEL = 'Stripe (simulated)';

interface Fixture {
  statusAssessment: StatusAssessment;
  incidents: StatusIncident[];
  probe: ProbeOutcome;
  verdict: ServiceVerdict;
}

/**
 * One fixed report per scenario, following the Task 3 verdict table:
 * (status page fact, reachability fact) -> combined verdict. `down_for_you`
 * and `status_unavailable` both fail the probe — the two facts they combine
 * differ (operational-but-unreachable vs. status-unknown-and-unreachable),
 * matching the checker's honesty distinction between "they say it's fine but
 * we can't reach them" and "we can't tell whose problem this is".
 */
const FIXTURES: Record<SimulatorState, Fixture> = {
  healthy: {
    statusAssessment: 'operational',
    incidents: [],
    probe: 'reachable',
    verdict: 'healthy',
  },
  incident: {
    statusAssessment: 'incident_reported',
    incidents: [{ title: 'Elevated error rates on the payments API', impact: 'major' }],
    probe: 'reachable',
    verdict: 'confirmed_incident',
  },
  degraded: {
    // parser-consistent: degraded never carries unresolved incidents.
    // `parseStatuspageSummary` (statuspage.ts) returns 'degraded_reported'
    // only when `incidents.length === 0` — any unresolved incident
    // short-circuits to 'incident_reported' instead. This fixture used to
    // carry a populated `incidents` array, a shape the real checker can
    // never produce; that unrepresentable fixture made the degraded+
    // unreachable wording bug (verdictDetail claiming a "confirmed
    // incident" that doesn't exist) look defensible in demo output and is
    // the reason it survived ten task reviews.
    statusAssessment: 'degraded_reported',
    incidents: [],
    probe: 'reachable',
    verdict: 'degraded_upstream',
  },
  down_for_you: {
    statusAssessment: 'operational',
    incidents: [],
    probe: 'connect_failed',
    verdict: 'down_for_you',
  },
  status_unavailable: {
    statusAssessment: 'status_unavailable',
    incidents: [],
    probe: 'connect_failed',
    verdict: 'unreachable_unverified',
  },
};

export class ServiceStatusSimulator implements ServiceStatusBackend {
  private scenario: SimulatorState = 'healthy';

  getScenario(): SimulatorState {
    return this.scenario;
  }

  /**
   * `to: string` is the ExecutionBackend signature, so the value is validated
   * rather than cast — copies the vector-store simulator's guard so a typo'd
   * scenario throws instead of silently passing a test for the wrong reason.
   */
  transition(to: string): void {
    if (!SCENARIOS.includes(to as SimulatorState)) {
      throw new Error(
        `Invalid service-status simulator scenario: ${to} (expected one of ${SCENARIOS.join(', ')})`,
      );
    }
    this.scenario = to as SimulatorState;
  }

  async queryServices(): Promise<ServiceStatusReport[]> {
    const fixture = FIXTURES[this.scenario];
    const source = 'catalog' as const;
    const report: ServiceStatusReport = {
      id: 'stripe',
      label: LABEL,
      source,
      host: 'api.stripe.com',
      port: 443,
      statusAssessment: fixture.statusAssessment,
      incidents: fixture.incidents,
      probe: fixture.probe,
      verdict: fixture.verdict,
      detail: verdictDetail({
        verdict: fixture.verdict,
        label: LABEL,
        incidents: fixture.incidents,
        source,
        statusAssessment: fixture.statusAssessment,
      }),
      checkedAt: new Date().toISOString(),
      durationMs: 1,
    };
    return [report];
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'structured_command') {
      throw new Error(`Unsupported service-status simulator command type: ${command.type}`);
    }
    if (command.operation === 'query_services') {
      return { reports: await this.queryServices() };
    }
    // Matches ServiceStatusLiveClient.executeCommand: a success-shaped
    // fallback here would let a simulated plan pass an operation that
    // throws under live execution — this agent only ever issues
    // query_services (agent.ts's plan()), so there is no legitimate op this
    // branch needs to accept permissively.
    throw new Error(`Unsupported service-status operation: ${command.operation}`);
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const statement = check.statement ?? '';
    const reports = await this.queryServices();

    if (statement === 'service_verdict') {
      return compareCheckValue(worstVerdict(reports), check.expect.operator, check.expect.value);
    }
    if (statement === 'unreachable_service_count') {
      const count = reports.filter((r) => isUnreachableVerdict(r.verdict)).length;
      return compareCheckValue(count, check.expect.operator, check.expect.value);
    }
    // Fail closed, matching the live client: a precondition/success-criteria
    // check on an unrecognized statement is a plan-authoring bug, and this
    // backend must not let it pass silently. Throwing was considered instead,
    // but the graph engine's node functions (src/framework/graph-nodes.ts)
    // call evaluateCheck without a surrounding try/catch — an exception here
    // would propagate out of LangGraph's stream() uncaught rather than
    // surface as a failed step, so `false` is the only semantic both
    // execution engines handle safely.
    return false;
  }

  async close(): Promise<void> {}
}
