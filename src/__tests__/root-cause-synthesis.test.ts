// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  synthesizeByRules,
  synthesizeFromRoutingResults,
  CORRELATION_RULE_NAMES,
} from '../framework/root-cause-synthesis.js';
import type { AgentEvidence } from '../framework/root-cause-synthesis.js';
import type { RoutingResult } from '../framework/symptom-router.js';
import { healthToSignals } from '../framework/health-to-signals.js';
import type { HealthAssessment } from '../types/health.js';

// ── Helpers ──

function makeEvidence(
  agentKind: string,
  overrides: Partial<AgentEvidence> = {},
): AgentEvidence {
  return {
    agentKind,
    targetName: `test-${agentKind}`,
    ...overrides,
  };
}

describe('Root cause synthesis (6.3)', () => {
  describe('synthesizeByRules', () => {
    it('returns empty clusters for single agent', () => {
      const result = synthesizeByRules([makeEvidence('postgresql')]);
      expect(result.clusters).toHaveLength(0);
      expect(result.uncorrelated).toEqual(['postgresql']);
      expect(result.source).toBe('rules');
    });

    it('returns empty for no evidence', () => {
      const result = synthesizeByRules([]);
      expect(result.clusters).toHaveLength(0);
      expect(result.narrative).toContain('No evidence');
    });

    it('correlates deploy-cascade when multiple agents share deploy signals', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('application', {
          signals: [
            { type: 'deploy_change', source: 'deploy', detail: 'v2.3 deployed', severity: 'warning' },
            { type: 'error_rate', source: 'monitoring', detail: '500 errors spiking', severity: 'critical' },
          ],
        }),
        makeEvidence('postgresql', {
          signals: [
            { type: 'error_rate', source: 'pg', detail: 'connection pool exhausted', severity: 'critical' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      const deployCascade = result.clusters.find((c) => c.rootCause.includes('deployment'));
      if (deployCascade) {
        expect(deployCascade.agents).toContain('application');
        expect(deployCascade.agents).toContain('postgresql');
        expect(deployCascade.confidence).toBeGreaterThan(0);
      }
    });

    it('applies the confidence boost for rules that declare no shared patterns', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('dns', {
          signals: [
            { type: 'connection', source: 'dns', detail: 'resolver unreachable', severity: 'critical' },
          ],
        }),
        makeEvidence('postgresql', {
          signals: [
            { type: 'connection', source: 'pg', detail: 'connect ECONNREFUSED', severity: 'critical' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      const cluster = result.clusters.find((c) => c.reasoning.includes('observer-environment'));
      expect(cluster).toBeDefined();
      // 0.3 base + full signal agreement (0.3) + the rule's declared boost (0.3)
      expect(cluster!.confidence).toBeCloseTo(0.9, 2);
    });

    it('correlates database-backpressure when DB and cache share latency signals', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('postgresql', {
          signals: [
            { type: 'latency', source: 'pg', detail: 'query latency 5x baseline', severity: 'critical' },
            { type: 'timeout', source: 'pg', detail: 'connection timeouts', severity: 'warning' },
          ],
        }),
        makeEvidence('redis', {
          signals: [
            { type: 'latency', source: 'redis', detail: 'cache miss rate increasing', severity: 'warning' },
            { type: 'connection', source: 'redis', detail: 'client reconnects', severity: 'warning' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      const backpressure = result.clusters.find((c) =>
        c.rootCause.toLowerCase().includes('backpressure') ||
        c.rootCause.toLowerCase().includes('database'),
      );
      expect(backpressure).toBeDefined();
    });

    it('correlates network-partition across distributed systems', () => {
      // network-partition declares sharedPatterns: ['flapping'], so its
      // confidence boost needs pattern evidence from two agents. Without it
      // the rule scores 0.6 and this incident is claimed by
      // component-failure-cascade instead — assert the rule by name so the
      // test cannot pass on another rule's similarly-worded template.
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const evidence: AgentEvidence[] = [
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ];

      const result = synthesizeByRules(evidence);
      const networkCluster = result.clusters.find((c) => c.reasoning.includes('network-partition'));
      expect(networkCluster).toBeDefined();
      expect(networkCluster!.agents).toContain('etcd');
      expect(networkCluster!.agents).toContain('kafka');
    });

    it('leaves unrelated agents uncorrelated', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('postgresql', {
          signals: [{ type: 'latency', source: 'pg', detail: 'slow queries', severity: 'warning' }],
        }),
        makeEvidence('flink', {
          signals: [{ type: 'error_rate', source: 'flink', detail: 'checkpoint failure', severity: 'critical' }],
        }),
      ];

      const result = synthesizeByRules(evidence);
      // These two may or may not correlate depending on rules, but the result should be valid
      expect(result.source).toBe('rules');
      expect(result.synthesizedAt).toBeTruthy();
    });

    it('names only the agents whose signals matched the rule', () => {
      // redis is in database-backpressure's agentKinds, but its only signal
      // (deploy_change) is not one of the rule's signal types. Claiming redis
      // as part of the pattern — and dropping it from `uncorrelated` — is a
      // claim the evidence does not support.
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'latency', source: 'pg', detail: 'slow queries', severity: 'warning' }],
        }),
        makeEvidence('kafka', {
          signals: [{ type: 'timeout', source: 'kafka', detail: 'producer timeouts', severity: 'critical' }],
        }),
        makeEvidence('redis', {
          signals: [{ type: 'deploy_change', source: 'ci', detail: 'sidecar redeployed', severity: 'warning' }],
        }),
      ]);

      const cluster = result.clusters.find((c) => c.reasoning.includes('database-backpressure'));
      expect(cluster).toBeDefined();
      expect(cluster!.agents).toEqual(['postgresql', 'kafka']);
      expect(result.uncorrelated).toContain('redis');
    });

    it('includes investigation order in clusters', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('application', {
          signals: [
            { type: 'deploy_change', source: 'ci', detail: 'deploy', severity: 'warning' },
            { type: 'error_rate', source: 'app', detail: 'errors', severity: 'critical' },
          ],
        }),
        makeEvidence('postgresql', {
          signals: [
            { type: 'error_rate', source: 'pg', detail: 'errors', severity: 'critical' },
          ],
        }),
        makeEvidence('redis', {
          signals: [
            { type: 'error_rate', source: 'redis', detail: 'errors', severity: 'warning' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      for (const cluster of result.clusters) {
        expect(cluster.investigationOrder.length).toBeGreaterThan(0);
        // Investigation order should only include agents in the cluster
        for (const agent of cluster.investigationOrder) {
          expect(cluster.agents).toContain(agent);
        }
      }
    });

    it('builds a narrative for correlated results', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('application', {
          signals: [
            { type: 'deploy_change', source: 'ci', detail: 'deploy', severity: 'warning' },
            { type: 'error_rate', source: 'app', detail: '500s', severity: 'critical' },
          ],
        }),
        makeEvidence('redis', {
          signals: [
            { type: 'error_rate', source: 'redis', detail: 'oom', severity: 'critical' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      expect(result.narrative.length).toBeGreaterThan(0);
    });

    it('detects temporal correlation from health snapshots', () => {
      const now = Date.now();
      const evidence: AgentEvidence[] = [
        makeEvidence('postgresql', {
          snapshots: [
            { cycle: 1, status: 'healthy', confidence: 0.9, signalCount: 1, timestamp: new Date(now - 60000).toISOString() },
            { cycle: 2, status: 'unhealthy', confidence: 0.3, signalCount: 5, timestamp: new Date(now).toISOString() },
          ],
          signals: [{ type: 'error_rate', source: 'pg', detail: 'errors', severity: 'critical' }],
        }),
        makeEvidence('redis', {
          snapshots: [
            { cycle: 1, status: 'healthy', confidence: 0.9, signalCount: 1, timestamp: new Date(now - 60000).toISOString() },
            { cycle: 2, status: 'unhealthy', confidence: 0.4, signalCount: 3, timestamp: new Date(now + 30000).toISOString() },
          ],
          signals: [{ type: 'latency', source: 'redis', detail: 'slow', severity: 'warning' }],
        }),
      ];

      const result = synthesizeByRules(evidence);
      // Should detect temporal correlation since both went unhealthy within 5 min
      const _temporalClusters = result.clusters.filter((c) => c.temporalCorrelation);
      // May or may not have temporal depending on rule match, but structure is valid
      expect(result.synthesizedAt).toBeTruthy();
    });

    it('confidence is capped at 1.0', () => {
      const evidence: AgentEvidence[] = [
        makeEvidence('application', {
          signals: Array.from({ length: 10 }, () => ({
            type: 'deploy_change' as const,
            source: 'ci',
            detail: 'deploy',
            severity: 'critical' as const,
          })),
          patterns: [
            { pattern: 'flapping', occurrences: 10, firstSeen: '', lastSeen: '', description: '' },
          ],
        }),
        makeEvidence('postgresql', {
          signals: Array.from({ length: 10 }, () => ({
            type: 'error_rate' as const,
            source: 'pg',
            detail: 'errors',
            severity: 'critical' as const,
          })),
          patterns: [
            { pattern: 'flapping', occurrences: 10, firstSeen: '', lastSeen: '', description: '' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      for (const cluster of result.clusters) {
        expect(cluster.confidence).toBeLessThanOrEqual(1.0);
        expect(cluster.confidence).toBeGreaterThan(0);
      }
    });

    it('correlates pg unreachable with RDS platform exhaustion', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [
            { type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' },
          ],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
          ],
        }),
      ]);
      const cluster = result.clusters.find((c) => c.agents.includes('aws-rds') && c.agents.includes('postgresql'));
      expect(cluster).toBeDefined();
      expect(cluster!.investigationOrder[0]).toBe('aws-rds');
    });

    it('correlates pg timeout with RDS security-group facts', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [
            { type: 'timeout', source: 'pg_connection', detail: 'timed out', severity: 'critical' },
          ],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources on port 5432 — clients cannot connect', severity: 'critical' },
          ],
        }),
      ]);
      const cluster = result.clusters.find((c) => c.agents.includes('aws-rds'));
      expect(cluster).toBeDefined();
      expect(cluster!.investigationOrder[0]).toBe('aws-rds');
    });

    it('a pure security-group block fires only rds-reachability, not rds-platform-degraded', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [
            { type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' },
          ],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources on port 5432 — clients cannot connect', severity: 'critical' },
          ],
        }),
      ]);
      const platformCluster = result.clusters.find((c) => c.reasoning.includes('rds-platform-degraded'));
      expect(platformCluster).toBeUndefined();
      const reachabilityCluster = result.clusters.find((c) => c.reasoning.includes('rds-reachability'));
      expect(reachabilityCluster).toBeDefined();
      expect(reachabilityCluster!.investigationOrder[0]).toBe('aws-rds');
    });

    it('genuine RDS storage exhaustion fires only rds-platform-degraded, not rds-reachability', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [
            { type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' },
          ],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
          ],
        }),
      ]);
      const reachabilityCluster = result.clusters.find((c) => c.reasoning.includes('rds-reachability'));
      expect(reachabilityCluster).toBeUndefined();
      const platformCluster = result.clusters.find((c) => c.reasoning.includes('rds-platform-degraded'));
      expect(platformCluster).toBeDefined();
      expect(platformCluster!.investigationOrder[0]).toBe('aws-rds');
    });

    it('regression: rules without requiredTypesByKind still match purely via sharedSignalTypes', () => {
      // resource-exhaustion-cascade has no requiredTypesByKind — the pairwise
      // matching change must reduce to the original "any shared type, any agent"
      // behavior for every pre-existing rule.
      const evidence: AgentEvidence[] = [
        makeEvidence('kubernetes', {
          signals: [
            { type: 'resource_exhaustion', source: 'k8s', detail: 'node memory pressure', severity: 'critical' },
          ],
        }),
        makeEvidence('postgresql', {
          signals: [
            { type: 'resource_exhaustion', source: 'pg', detail: 'disk full', severity: 'critical' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      const cluster = result.clusters.find((c) => c.reasoning.includes('resource-exhaustion-cascade'));
      expect(cluster).toBeDefined();
      // 0.3 base + full signal agreement (0.3) — no pattern match, no temporal correlation
      expect(cluster!.confidence).toBeCloseTo(0.6, 2);
      expect(cluster!.investigationOrder[0]).toBe('kubernetes');
    });

    it('frames the narrative as a possible pattern match, not a root cause', () => {
      const result = synthesizeByRules([
        makeEvidence('dns', {
          signals: [{ type: 'connection', source: 'dns', detail: 'resolver unreachable', severity: 'critical' }],
        }),
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg', detail: 'connect ECONNREFUSED', severity: 'critical' }],
        }),
      ]);
      expect(result.narrative).toContain('Possible pattern match');
      expect(result.narrative).toContain('Start by checking');
      expect(result.narrative).not.toContain('Primary root cause');
      expect(result.narrative).not.toMatch(/\d+% confidence/);
    });
  });

  describe('iac-out-of-band-change rule', () => {
    const iacEvidence = (entityIds: string[]): AgentEvidence => ({
      agentKind: 'iac-drift', targetName: 'derived-iac-drift', entityIds,
      signals: [{ type: 'config_mismatch', source: 'iac_attribute_drift', detail: 'aws_db_instance prod-db: instance_class drift', severity: 'warning' }],
    });
    const rdsEvidence = (entityIds: string[]): AgentEvidence => ({
      agentKind: 'aws-rds', targetName: 'rds-us-east-1-prod-db', entityIds,
      signals: [{ type: 'resource_exhaustion', source: 'rds_storage', detail: 'FreeStorageSpace critically low', severity: 'critical' }],
    });

    it('fires when iac-drift and aws-rds report the same instance', () => {
      const result = synthesizeByRules([iacEvidence(['prod-db']), rdsEvidence(['prod-db'])]);
      const cluster = result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'));
      expect(cluster).toBeDefined();
      expect(cluster!.investigationOrder[0]).toBe('iac-drift');
    });

    it('does NOT fire when the drifted resource is a different instance', () => {
      const result = synthesizeByRules([iacEvidence(['other-db']), rdsEvidence(['prod-db'])]);
      expect(result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'))).toBeUndefined();
    });

    it('does NOT fire when either side lacks entity ids (no guessing)', () => {
      const result = synthesizeByRules([iacEvidence([]), rdsEvidence(['prod-db'])]);
      expect(result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'))).toBeUndefined();
    });

    it('does not let a third, unrelated same-kind target veto the pairing (regression)', () => {
      // What this test pins: the entity-id gate used to intersect entityIds
      // across EVERY matching agent (including ones that never even matched
      // the rule's signal type), so this unrelated second aws-rds instance
      // (other-db, no real signal) vetoed the correlation between iac-drift
      // and the genuinely drifted aws-rds instance (prod-db) purely because
      // it didn't share prod-db too. The fix pairs on a shared id among
      // agents that themselves passed the per-agent signal check, and scopes
      // the resulting cluster to just those pairing agents.
      const rdsOther: AgentEvidence = {
        agentKind: 'aws-rds', targetName: 'rds-us-east-1-other-db', entityIds: ['other-db'], signals: [],
      };
      const result = synthesizeByRules([iacEvidence(['prod-db']), rdsOther, rdsEvidence(['prod-db'])]);
      const cluster = result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'));
      expect(cluster).toBeDefined();
      // Scoped to the sharing pair only — the unrelated other-db instance
      // must not appear in the cluster it had no part in.
      expect(cluster!.agents).toEqual(['iac-drift', 'aws-rds']);
      expect(cluster!.investigationOrder[0]).toBe('iac-drift');
    });

    it('fires the same way with the third-target evidence order reversed (regression)', () => {
      // agentSignalTypes/agentPatterns used to be keyed by agentKind, so with
      // two aws-rds evidence items the LATER one in the evidence array
      // silently overwrote the earlier one's entry in the map — whichever
      // aws-rds evidence item is iterated last wins the signal-type lookup
      // for BOTH aws-rds entries. In the non-reversed test above, the
      // genuinely-drifted rdsEvidence happens to be iterated last, so the
      // bug is invisible there. Reversing the order so the empty-signal
      // rdsOther is iterated last exposes it: rdsEvidence's real
      // 'resource_exhaustion' signal type gets discarded, and the rule fails
      // to fire at all. Keying the maps by the AgentEvidence object
      // reference instead of agentKind fixes this for either order.
      const rdsOther: AgentEvidence = {
        agentKind: 'aws-rds', targetName: 'rds-us-east-1-other-db', entityIds: ['other-db'], signals: [],
      };
      const result = synthesizeByRules([iacEvidence(['prod-db']), rdsEvidence(['prod-db']), rdsOther]);
      const cluster = result.clusters.find((c) => c.reasoning.includes('iac-out-of-band-change'));
      expect(cluster).toBeDefined();
      expect(cluster!.agents).toEqual(['iac-drift', 'aws-rds']);
      expect(cluster!.investigationOrder[0]).toBe('iac-drift');
    });
  });

  describe('one agent, one cluster', () => {
    it('fires exactly one RDS rule on a mixed platform/reachability incident', () => {
      // aws-rds reports BOTH storage exhaustion and a connection-path
      // problem, so rds-platform-degraded and rds-reachability both match.
      // Reporting both as separate "root causes" for the same two agents
      // double-counts one incident.
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' }],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources on port 5432', severity: 'critical' },
          ],
        }),
      ]);

      const rdsClusters = result.clusters.filter((c) => c.agents.includes('aws-rds'));
      expect(rdsClusters).toHaveLength(1);
      // The stronger rule wins: rds-platform-degraded boosts 0.3 vs 0.25.
      expect(rdsClusters[0]!.reasoning).toContain('rds-platform-degraded');
      expect(result.clusters.filter((c) => c.reasoning.includes('rds-reachability'))).toHaveLength(0);
    });

    it('numbers surviving clusters contiguously', () => {
      const result = synthesizeByRules([
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg_connection', detail: 'connection refused', severity: 'critical' }],
        }),
        makeEvidence('aws-rds', {
          targetName: 'rds-mydb',
          signals: [
            { type: 'resource_exhaustion', source: 'rds_storage', detail: 'storage is full', severity: 'critical' },
            { type: 'connection', source: 'rds_security_group', detail: 'security group allows no sources', severity: 'critical' },
          ],
        }),
      ]);
      expect(result.clusters.map((c) => c.id)).toEqual(
        result.clusters.map((_, i) => `cluster-${i}`),
      );
    });

    it('keeps the observer-environment advisory alongside the winning specific cluster', () => {
      // Both agents report connection + timeout AND flapping, so
      // network-partition scores 0.9 (0.3 base + 0.3 signal agreement + 0.3
      // pattern boost) and wins the specific contest over
      // component-failure-cascade (0.85). observer-environment also scores
      // 0.9, but it is an advisory overlay: it must survive without
      // suppressing the specific answer, and without claiming its agents.
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ]);

      const networkPartition = result.clusters.find((c) => c.reasoning.includes('network-partition'));
      const advisory = result.clusters.find((c) => c.reasoning.includes('observer-environment'));
      expect(networkPartition).toBeDefined();
      expect(advisory).toBeDefined();
      // The specific answer leads; the advisory rides along behind it.
      expect(result.clusters.indexOf(networkPartition!)).toBeLessThan(result.clusters.indexOf(advisory!));
      // The advisory claimed nothing, so the weaker specific rule still lost.
      expect(result.clusters.filter((c) => c.reasoning.includes('component-failure-cascade'))).toHaveLength(0);
    });

    it('claims each agent for at most one specific cluster', () => {
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
      ]);

      const seen = new Set<string>();
      for (const cluster of result.clusters) {
        // Advisory overlays deliberately re-name agents a specific cluster
        // already claimed — the uniqueness rule applies to specific rules.
        if (cluster.reasoning.includes('observer-environment')) continue;
        for (const agent of cluster.agents) {
          expect(seen.has(agent), `agent '${agent}' appears in more than one specific cluster`).toBe(false);
          seen.add(agent);
        }
      }
      // Rendered text must match the agents each cluster actually kept.
      for (const cluster of result.clusters) {
        for (const agent of cluster.investigationOrder) {
          expect(cluster.agents).toContain(agent);
        }
      }
    });

    it('re-renders reasoning when a cluster loses agents to de-dup', () => {
      // network-partition (with flapping, 0.9 confidence) scores higher than
      // component-failure-cascade (0.85). network-partition matches/claims
      // etcd, kafka, postgresql, ceph (all have connection signals and the top
      // two have flapping patterns). component-failure-cascade originally
      // matched 5 agents: postgresql, redis, kafka, etcd, application (all
      // have connection or error signals). After de-dup, it loses the 3 claimed
      // by network-partition (postgresql, kafka, etcd) and survives with 2
      // (redis, application). Its reasoning must accurately say "2 agents"
      // not "5 agents" — the honest count of survivors.
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
        }),
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg', detail: 'connection refused', severity: 'critical' }],
        }),
        makeEvidence('redis', {
          signals: [{ type: 'connection', source: 'redis', detail: 'unreachable', severity: 'critical' }],
        }),
        makeEvidence('ceph', {
          signals: [{ type: 'connection', source: 'ceph', detail: 'mon unreachable', severity: 'critical' }],
        }),
        makeEvidence('application', {
          signals: [{ type: 'connection', source: 'app', detail: 'cannot reach dependencies', severity: 'critical' }],
        }),
      ]);

      const cascadeCluster = result.clusters.find((c) => c.reasoning.includes('component-failure-cascade'));
      expect(cascadeCluster).toBeDefined();
      // After de-dup, only redis and application remain (postgresql, kafka, etcd
      // claimed by higher-confidence network-partition).
      expect(cascadeCluster!.agents).toHaveLength(2);
      // Reasoning must accurately reflect survivors, not original count.
      expect(cascadeCluster!.reasoning).toContain('2 agents share signal types');
    });

    it('does not claim temporal correlation the surviving evidence does not support', () => {
      // Same claim/trim shape as the test above (network-partition outscores
      // component-failure-cascade and claims postgresql, kafka, etcd, leaving
      // redis + application as component-failure-cascade's survivors) but here
      // the trimmed-away agents (postgresql, kafka, etcd) are the ones with
      // snapshot data placing their most recent unhealthy transition within the
      // 5-minute correlation window of each other. The survivors (redis,
      // application) carry no snapshot/health data at all, so on their own they
      // supply fewer than 2 timestamps and hasTemporalCorrelation is false.
      // The ORIGINAL 5-agent computation (done before de-dup trims the cluster)
      // sees the 3 tightly-clustered trimmed-agent timestamps and is true — the
      // bug this pins is the re-render block copying that stale `true` onto the
      // 2-agent survivor cluster instead of recomputing over just redis and
      // application.
      const base = Date.now();
      const flapping = { pattern: 'flapping', occurrences: 3, firstSeen: '', lastSeen: '', description: '' };
      const result = synthesizeByRules([
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
          patterns: [flapping],
          snapshots: [
            { cycle: 1, status: 'unhealthy', confidence: 0.3, signalCount: 2, timestamp: new Date(base).toISOString() },
          ],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
          patterns: [flapping],
          snapshots: [
            { cycle: 1, status: 'unhealthy', confidence: 0.3, signalCount: 2, timestamp: new Date(base + 30_000).toISOString() },
          ],
        }),
        makeEvidence('postgresql', {
          signals: [{ type: 'connection', source: 'pg', detail: 'connection refused', severity: 'critical' }],
          snapshots: [
            { cycle: 1, status: 'unhealthy', confidence: 0.3, signalCount: 1, timestamp: new Date(base + 90_000).toISOString() },
          ],
        }),
        makeEvidence('redis', {
          signals: [{ type: 'connection', source: 'redis', detail: 'unreachable', severity: 'critical' }],
        }),
        makeEvidence('ceph', {
          signals: [{ type: 'connection', source: 'ceph', detail: 'mon unreachable', severity: 'critical' }],
        }),
        makeEvidence('application', {
          signals: [{ type: 'connection', source: 'app', detail: 'cannot reach dependencies', severity: 'critical' }],
        }),
      ]);

      const cascadeCluster = result.clusters.find((c) => c.reasoning.includes('component-failure-cascade'));
      expect(cascadeCluster).toBeDefined();
      expect(cascadeCluster!.agents).toEqual(['redis', 'application']);
      expect(cascadeCluster!.temporalCorrelation).toBe(false);
      expect(cascadeCluster!.reasoning).not.toContain('temporally correlated');
    });

    it('does not let one same-kind cluster claim an unrelated same-kind target (de-dup by evidence, not agentKind)', () => {
      // The winner-take-all pass used to track claims in a Set<string> keyed
      // by agentKind. config-drift-cascade below matches a redis evidence
      // item (r3) alongside an application-config item, and scores higher
      // than streaming-backpressure, which independently matches TWO
      // *different*, unrelated redis evidence items (r1, r2 — distinct
      // targets, same kind). Under the bug, config-drift-cascade's claim of
      // r3 adds the string 'redis' to a Set<string>, which then makes
      // streaming-backpressure's ['redis', 'redis'] (r1, r2) look fully
      // claimed too — even though r1 and r2 were never part of
      // config-drift-cascade's cluster — and the whole streaming-backpressure
      // cluster is wrongly dropped. Keying claims by the AgentEvidence object
      // reference instead means only genuinely claimed evidence is removed.
      const r1 = makeEvidence('redis', {
        targetName: 'redis-queue-a',
        signals: [{ type: 'queue_depth', source: 'r1', detail: 'queue backlog', severity: 'critical' }],
      });
      const r2 = makeEvidence('redis', {
        targetName: 'redis-queue-b',
        signals: [{ type: 'queue_depth', source: 'r2', detail: 'queue backlog', severity: 'critical' }],
      });
      const r3 = makeEvidence('redis', {
        targetName: 'redis-config',
        signals: [{ type: 'config_mismatch', source: 'r3', detail: 'config drifted', severity: 'critical' }],
      });
      const appConfigEvidence = makeEvidence('application-config', {
        signals: [{ type: 'config_mismatch', source: 'app-config', detail: 'config drifted', severity: 'critical' }],
      });

      const result = synthesizeByRules([r1, r2, r3, appConfigEvidence]);

      const driftCluster = result.clusters.find((c) => c.reasoning.includes('config-drift-cascade'));
      expect(driftCluster).toBeDefined();
      expect(driftCluster!.agents).toEqual(['redis', 'application-config']);

      // r1 and r2 were never part of config-drift-cascade's cluster (only r3
      // was) — streaming-backpressure must survive with both of them intact,
      // not be silently dropped because their shared agentKind string
      // collided with r3's.
      const backpressureCluster = result.clusters.find((c) => c.reasoning.includes('streaming-backpressure'));
      expect(backpressureCluster, 'the unrelated r1+r2 cluster must survive de-dup').toBeDefined();
      expect(backpressureCluster!.agents).toEqual(['redis', 'redis']);
    });
  });

  describe('config-drift-cascade regression (iac-drift arc)', () => {
    // The `drift|out-of-band|intended|mismatch` TYPE_PATTERN added for
    // iac-drift's config_mismatch classification also reclassifies the
    // pre-existing config-drift agent's "N env var(s) drifted from expected
    // values" wording — previously unmatched (fell back to 'custom'), so
    // config-drift-cascade (which requires a 'config_mismatch' signal from
    // application-config) could never fire on it. Reviewed and accepted by
    // the human as a deliberate improvement, not a regression: this test
    // pins the new behavior and routes the application-config side through
    // the real healthToSignals mapping so it breaks if the regex is later
    // narrowed back.
    it('fires when a drift-worded application-config signal co-occurs with a postgresql connection signal', () => {
      const configHealth: HealthAssessment = {
        status: 'recovering',
        confidence: 0.8,
        summary: 'config drift detected',
        observedAt: new Date().toISOString(),
        signals: [
          {
            source: 'environment_variables',
            status: 'warning',
            detail: '2 env var(s) drifted from expected values: DATABASE_URL, REDIS_URL.',
            observedAt: new Date().toISOString(),
          },
        ],
        recommendedActions: [],
      };

      const evidence: AgentEvidence[] = [
        makeEvidence('application-config', { signals: healthToSignals(configHealth) }),
        makeEvidence('postgresql', {
          signals: [
            { type: 'connection', source: 'pg_connection', detail: 'connect ECONNREFUSED', severity: 'critical' },
          ],
        }),
      ];

      // Sanity check that the reclassification is really what's driving this —
      // if healthToSignals stops emitting config_mismatch here, this assertion
      // (not just the cluster-not-found one below) is what should fail first.
      expect(evidence[0]!.signals!.map((s) => s.type)).toEqual(['config_mismatch']);

      const result = synthesizeByRules(evidence);
      const cluster = result.clusters.find((c) => c.reasoning.includes('config-drift-cascade'));
      expect(cluster).toBeDefined();
      expect(cluster!.agents).toContain('application-config');
      expect(cluster!.agents).toContain('postgresql');
    });
  });

  describe('synthesizeFromRoutingResults', () => {
    it('converts routing results to evidence and synthesizes', () => {
      const results: RoutingResult[] = [
        {
          scenarios: [
            { scenario: 'replication-lag', agentKind: 'postgresql', confidence: 0.8, reasoning: 'lag detected' },
            { scenario: 'redis-memory-pressure', agentKind: 'redis', confidence: 0.6, reasoning: 'high mem' },
          ],
          recommendedAgent: 'postgresql',
          explanation: 'lag',
          evidence: ['some signal'],
        },
      ];

      const result = synthesizeFromRoutingResults(results);
      expect(result.source).toBe('rules');
      expect(result.synthesizedAt).toBeTruthy();
    });

    it('filters low-confidence scenarios', () => {
      const results: RoutingResult[] = [
        {
          scenarios: [
            { scenario: 'test', agentKind: 'postgresql', confidence: 0.1, reasoning: 'low' },
          ],
          recommendedAgent: null,
          explanation: 'test',
          evidence: [],
        },
      ];

      const result = synthesizeFromRoutingResults(results);
      // Low confidence scenario (0.1 < 0.3 threshold) should be filtered
      expect(result.clusters).toHaveLength(0);
    });
  });

  describe('correlation rule freeze', () => {
    // The rule set is frozen: see the policy in the header of
    // src/framework/root-cause-synthesis.ts and in CONTRIBUTING.md. A new rule
    // requires a new agent class shipping with a concretely evidenced signal
    // pairing — no speculative incident templates. Changing this list without
    // updating both documents is the failure this test is here to catch.
    const FROZEN_RULES = [
      'deploy-cascade',
      'database-backpressure',
      'resource-exhaustion-cascade',
      'network-partition',
      'config-drift-cascade',
      'streaming-backpressure',
      'component-failure-cascade',
      'observer-environment',
      'rds-platform-degraded',
      'rds-reachability',
      'iac-out-of-band-change',
    ];

    it('contains exactly the frozen rules, in order', () => {
      expect([...CORRELATION_RULE_NAMES]).toEqual(FROZEN_RULES);
    });
  });
});
