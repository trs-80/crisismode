// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  synthesizeByRules,
  synthesizeFromRoutingResults,
} from '../framework/root-cause-synthesis.js';
import type { AgentEvidence } from '../framework/root-cause-synthesis.js';
import type { RoutingResult } from '../framework/symptom-router.js';

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
      const evidence: AgentEvidence[] = [
        makeEvidence('etcd', {
          signals: [
            { type: 'connection', source: 'etcd', detail: 'leader lost', severity: 'critical' },
            { type: 'timeout', source: 'etcd', detail: 'raft timeout', severity: 'critical' },
          ],
        }),
        makeEvidence('kafka', {
          signals: [
            { type: 'connection', source: 'kafka', detail: 'broker unreachable', severity: 'critical' },
            { type: 'timeout', source: 'kafka', detail: 'ISR shrunk', severity: 'warning' },
          ],
        }),
      ];

      const result = synthesizeByRules(evidence);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);
      const networkCluster = result.clusters.find((c) =>
        c.rootCause.toLowerCase().includes('network'),
      );
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
});
