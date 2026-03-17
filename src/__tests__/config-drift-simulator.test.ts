// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ConfigDriftSimulator } from '../agent/config-drift/simulator.js';

describe('ConfigDriftSimulator', () => {
  // ---------------------------------------------------------------------------
  // getEnvironmentVars()
  // ---------------------------------------------------------------------------
  describe('getEnvironmentVars()', () => {
    it('has mismatched env vars in drifted state', async () => {
      const sim = new ConfigDriftSimulator();
      const vars = await sim.getEnvironmentVars();
      expect(vars).toHaveLength(4);
      const dbUrl = vars.find((v) => v.name === 'DATABASE_URL');
      expect(dbUrl!.actual).toContain('db-staging.dev');
      expect(dbUrl!.expected).toContain('db-primary.prod');
      const flags = vars.find((v) => v.name === 'FEATURE_FLAGS_ENDPOINT');
      expect(flags!.actual).toContain('staging');
    });

    it('has matching env vars in aligned state', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const vars = await sim.getEnvironmentVars();
      for (const v of vars) {
        expect(v.expected).toBe(v.actual);
      }
    });

    it('has matching env vars in correcting state', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('correcting');
      const vars = await sim.getEnvironmentVars();
      const dbUrl = vars.find((v) => v.name === 'DATABASE_URL');
      expect(dbUrl!.expected).toBe(dbUrl!.actual);
    });
  });

  // ---------------------------------------------------------------------------
  // getSecretStatus()
  // ---------------------------------------------------------------------------
  describe('getSecretStatus()', () => {
    it('has expired secret in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      const secrets = await sim.getSecretStatus();
      expect(secrets).toHaveLength(3);
      const apiKey = secrets.find((s) => s.name === 'api-gateway-key');
      expect(apiKey!.expired).toBe(true);
    });

    it('has no expired secrets in correcting', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('correcting');
      const secrets = await sim.getSecretStatus();
      const apiKey = secrets.find((s) => s.name === 'api-gateway-key');
      expect(apiKey!.expired).toBe(false);
    });

    it('has no expired secrets in aligned', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const secrets = await sim.getSecretStatus();
      expect(secrets.every((s) => !s.expired)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getConfigDiff()
  // ---------------------------------------------------------------------------
  describe('getConfigDiff()', () => {
    it('returns 3 diffs in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      const diffs = await sim.getConfigDiff();
      expect(diffs).toHaveLength(3);
      const sources = diffs.map((d) => d.source);
      expect(sources).toContain('file');
      expect(sources).toContain('env');
    });

    it('returns 1 diff (file only) in correcting', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('correcting');
      const diffs = await sim.getConfigDiff();
      expect(diffs).toHaveLength(1);
      expect(diffs[0].source).toBe('file');
      // In correcting state, the file diff has matching expected and actual
      expect(diffs[0].expected).toBe(diffs[0].actual);
    });

    it('returns 0 diffs in aligned', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const diffs = await sim.getConfigDiff();
      expect(diffs).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getRecentConfigChanges()
  // ---------------------------------------------------------------------------
  describe('getRecentConfigChanges()', () => {
    it('returns 3 recent changes', async () => {
      const sim = new ConfigDriftSimulator();
      const changes = await sim.getRecentConfigChanges();
      expect(changes).toHaveLength(3);
      expect(changes[0].changedBy).toBe('deploy-pipeline-v2.3.1');
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('scan_config returns full scan with api_call type', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'scan_config' }) as Record<string, unknown>;
      expect(result).toHaveProperty('envVars');
      expect(result).toHaveProperty('secrets');
      expect(result).toHaveProperty('configDiffs');
      expect(result).toHaveProperty('recentChanges');
    });

    it('scan_config also works with configuration_change type', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({ type: 'configuration_change', operation: 'scan_config' }) as Record<string, unknown>;
      expect(result).toHaveProperty('envVars');
    });

    it('restore_env_vars transitions to correcting', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({
        type: 'configuration_change',
        operation: 'restore_env_vars',
        parameters: { variables: ['DATABASE_URL'] },
      }) as Record<string, unknown>;
      expect(result.restored).toBe(true);
      // Verify state changed — env vars now match
      const vars = await sim.getEnvironmentVars();
      const dbUrl = vars.find((v) => v.name === 'DATABASE_URL');
      expect(dbUrl!.expected).toBe(dbUrl!.actual);
    });

    it('rotate_secrets returns rotated: true', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({
        type: 'api_call',
        operation: 'rotate_secrets',
        parameters: { secrets: ['api-gateway-key'] },
      }) as Record<string, unknown>;
      expect(result.rotated).toBe(true);
      expect(result.secrets).toEqual(['api-gateway-key']);
    });

    it('restore_config_files transitions to aligned', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('correcting');
      const result = await sim.executeCommand({
        type: 'configuration_change',
        operation: 'restore_config_files',
        parameters: { files: ['/etc/app/feature-flags.json'] },
      }) as Record<string, unknown>;
      expect(result.restored).toBe(true);
      const diffs = await sim.getConfigDiff();
      expect(diffs).toHaveLength(0);
    });

    it('verify_alignment reports aligned state', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const result = await sim.executeCommand({ type: 'api_call', operation: 'verify_alignment' }) as Record<string, unknown>;
      expect(result.aligned).toBe(true);
      expect(result.diffs).toEqual([]);
    });

    it('verify_alignment reports not aligned in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'verify_alignment' }) as Record<string, unknown>;
      expect(result.aligned).toBe(false);
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'unknown' }) as Record<string, unknown>;
      expect(result.simulated).toBe(true);
    });

    it('throws on wrong command type', async () => {
      const sim = new ConfigDriftSimulator();
      await expect(sim.executeCommand({ type: 'sql', operation: 'test' }))
        .rejects.toThrow('Unsupported config-drift simulator command type: sql');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('evaluates config_drift_count in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'config_drift_count',
        expect: { operator: 'eq', value: 3 },
      });
      expect(result).toBe(true);
    });

    it('evaluates config_drift_count in aligned', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'config_drift_count',
        expect: { operator: 'eq', value: 0 },
      });
      expect(result).toBe(true);
    });

    it('evaluates expired_secrets_count in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'expired_secrets_count',
        expect: { operator: 'eq', value: 1 },
      });
      expect(result).toBe(true);
    });

    it('evaluates env_var_mismatches in drifted', async () => {
      const sim = new ConfigDriftSimulator();
      // drifted: DATABASE_URL and FEATURE_FLAGS_ENDPOINT mismatch = 2
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'env_var_mismatches',
        expect: { operator: 'eq', value: 2 },
      });
      expect(result).toBe(true);
    });

    it('evaluates all_configs_aligned in aligned', async () => {
      const sim = new ConfigDriftSimulator();
      sim.transition('aligned');
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'all_configs_aligned',
        expect: { operator: 'eq', value: 'true' },
      });
      expect(result).toBe(true);
    });

    it('evaluates all_configs_aligned in drifted (false)', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'all_configs_aligned',
        expect: { operator: 'eq', value: 'false' },
      });
      expect(result).toBe(true);
    });

    it('returns true for unknown statement', async () => {
      const sim = new ConfigDriftSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'unknown_check',
        expect: { operator: 'eq', value: 'anything' },
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // listCapabilityProviders() & close()
  // ---------------------------------------------------------------------------
  describe('listCapabilityProviders()', () => {
    it('returns 2 providers', () => {
      const sim = new ConfigDriftSimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0].id).toBe('config-drift-simulator-read');
      expect(providers[1].id).toBe('config-drift-simulator-write');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new ConfigDriftSimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });
});
