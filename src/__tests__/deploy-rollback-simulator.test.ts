// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { DeploySimulator } from '../agent/deploy-rollback/simulator.js';

describe('DeploySimulator', () => {
  // ---------------------------------------------------------------------------
  // getCurrentDeployment()
  // ---------------------------------------------------------------------------
  describe('getCurrentDeployment()', () => {
    it('returns bad deploy with running status in bad_deploy', async () => {
      const sim = new DeploySimulator();
      const deploy = await sim.getCurrentDeployment();
      expect(deploy.status).toBe('running');
      expect(deploy.message).toContain('migrate user sessions');
    });

    it('returns bad deploy with rolling_back status in rolling_back', async () => {
      const sim = new DeploySimulator();
      sim.transition('rolling_back');
      const deploy = await sim.getCurrentDeployment();
      expect(deploy.status).toBe('rolling_back');
      expect(deploy.sha).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    });

    it('returns good deploy with running status in stabilized', async () => {
      const sim = new DeploySimulator();
      sim.transition('stabilized');
      const deploy = await sim.getCurrentDeployment();
      expect(deploy.status).toBe('running');
      expect(deploy.sha).toBe('7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e');
    });
  });

  // ---------------------------------------------------------------------------
  // listRecentDeploys()
  // ---------------------------------------------------------------------------
  describe('listRecentDeploys()', () => {
    it('returns up to 3 deploys', async () => {
      const sim = new DeploySimulator();
      const deploys = await sim.listRecentDeploys(3);
      expect(deploys).toHaveLength(3);
    });

    it('respects limit parameter', async () => {
      const sim = new DeploySimulator();
      const deploys = await sim.listRecentDeploys(1);
      expect(deploys).toHaveLength(1);
    });

    it('returns at most 3 even with high limit', async () => {
      const sim = new DeploySimulator();
      const deploys = await sim.listRecentDeploys(10);
      expect(deploys).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // getTrafficDistribution()
  // ---------------------------------------------------------------------------
  describe('getTrafficDistribution()', () => {
    it('routes 100% to bad deploy in bad_deploy', async () => {
      const sim = new DeploySimulator();
      const traffic = await sim.getTrafficDistribution();
      expect(traffic.entries).toHaveLength(1);
      expect(traffic.entries[0].percentage).toBe(100);
      expect(traffic.entries[0].target).toBe('a1b2c3d4');
    });

    it('splits traffic in rolling_back', async () => {
      const sim = new DeploySimulator();
      sim.transition('rolling_back');
      const traffic = await sim.getTrafficDistribution();
      expect(traffic.entries).toHaveLength(2);
      expect(traffic.entries[0].percentage).toBe(10);
      expect(traffic.entries[1].percentage).toBe(90);
    });

    it('routes 100% to good deploy in stabilized', async () => {
      const sim = new DeploySimulator();
      sim.transition('stabilized');
      const traffic = await sim.getTrafficDistribution();
      expect(traffic.entries).toHaveLength(1);
      expect(traffic.entries[0].percentage).toBe(100);
      expect(traffic.entries[0].target).toBe('7f8e9d0c');
    });
  });

  // ---------------------------------------------------------------------------
  // getHealthEndpoints()
  // ---------------------------------------------------------------------------
  describe('getHealthEndpoints()', () => {
    it('has degraded/down endpoints in bad_deploy', async () => {
      const sim = new DeploySimulator();
      const endpoints = await sim.getHealthEndpoints();
      expect(endpoints).toHaveLength(4);
      expect(endpoints[0].status).toBe('degraded');
      expect(endpoints[1].status).toBe('down');
      expect(endpoints[2].status).toBe('down');
    });

    it('has mostly healthy endpoints in rolling_back', async () => {
      const sim = new DeploySimulator();
      sim.transition('rolling_back');
      const endpoints = await sim.getHealthEndpoints();
      const healthy = endpoints.filter((e) => e.status === 'healthy');
      expect(healthy.length).toBe(3);
      expect(endpoints[2].status).toBe('degraded');
    });

    it('has all healthy endpoints in stabilized', async () => {
      const sim = new DeploySimulator();
      sim.transition('stabilized');
      const endpoints = await sim.getHealthEndpoints();
      expect(endpoints.every((e) => e.status === 'healthy')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getRollbackTarget()
  // ---------------------------------------------------------------------------
  describe('getRollbackTarget()', () => {
    it('returns the good deploy as rollback target', async () => {
      const sim = new DeploySimulator();
      const target = await sim.getRollbackTarget();
      expect(target).not.toBeNull();
      expect(target!.sha).toBe('7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e');
      expect(target!.status).toBe('succeeded');
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('deploy_status returns current, traffic, and endpoints', async () => {
      const sim = new DeploySimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'deploy_status' }) as Record<string, unknown>;
      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('traffic');
      expect(result).toHaveProperty('endpoints');
    });

    it('traffic_shift transitions to rolling_back', async () => {
      const sim = new DeploySimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'traffic_shift' }) as Record<string, unknown>;
      expect(result.shifted).toBe(true);
      expect(result).toHaveProperty('distribution');
      const traffic = await sim.getTrafficDistribution();
      expect(traffic.entries).toHaveLength(2);
    });

    it('full_rollback transitions to stabilized', async () => {
      const sim = new DeploySimulator();
      sim.transition('rolling_back');
      const result = await sim.executeCommand({ type: 'api_call', operation: 'full_rollback' }) as Record<string, unknown>;
      expect(result.rolledBack).toBe(true);
      expect(result).toHaveProperty('activeDeploy');
    });

    it('health_check returns endpoints', async () => {
      const sim = new DeploySimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'health_check' }) as Record<string, unknown>;
      expect(result).toHaveProperty('endpoints');
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new DeploySimulator();
      const result = await sim.executeCommand({ type: 'api_call', operation: 'unknown' }) as Record<string, unknown>;
      expect(result.simulated).toBe(true);
    });

    it('throws on wrong command type', async () => {
      const sim = new DeploySimulator();
      await expect(sim.executeCommand({ type: 'sql', operation: 'test' }))
        .rejects.toThrow('Unsupported deploy simulator command type: sql');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('evaluates deploy_health check (max error rate)', async () => {
      const sim = new DeploySimulator();
      // bad_deploy max error rate: 62.1
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'deploy_health',
        expect: { operator: 'gt', value: 50 },
      });
      expect(result).toBe(true);
    });

    it('evaluates error_rate check (average)', async () => {
      const sim = new DeploySimulator();
      // bad_deploy avg error rate: (12.4+34.7+62.1+0.1)/4 = 27.325
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'error_rate',
        expect: { operator: 'gt', value: 20 },
      });
      expect(result).toBe(true);
    });

    it('evaluates traffic_distribution check', async () => {
      const sim = new DeploySimulator();
      // bad_deploy: first entry = 100%
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'traffic_distribution',
        expect: { operator: 'eq', value: 100 },
      });
      expect(result).toBe(true);
    });

    it('returns true for unknown statement', async () => {
      const sim = new DeploySimulator();
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
    it('returns 1 provider', () => {
      const sim = new DeploySimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('deploy-simulator-provider');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new DeploySimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });
});
