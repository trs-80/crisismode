// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { QueueSimulator } from '../agent/queue-backlog/simulator.js';

describe('QueueSimulator', () => {
  // ---------------------------------------------------------------------------
  // getQueueStats()
  // ---------------------------------------------------------------------------
  describe('getQueueStats()', () => {
    it('returns 3 queues in backlog_growing with high depths', async () => {
      const sim = new QueueSimulator();
      const queues = await sim.getQueueStats();
      expect(queues).toHaveLength(3);
      expect(queues[0].name).toBe('orders');
      expect(queues[0].depth).toBe(84_500);
      expect(queues[2].name).toBe('analytics');
      expect(queues[2].depth).toBe(156_000);
    });

    it('returns lower depths and paused queues in draining', async () => {
      const sim = new QueueSimulator();
      sim.transition('draining');
      const queues = await sim.getQueueStats();
      expect(queues[0].depth).toBe(32_000);
      expect(queues.every((q) => q.paused)).toBe(true);
    });

    it('returns minimal depths and unpaused queues in cleared', async () => {
      const sim = new QueueSimulator();
      sim.transition('cleared');
      const queues = await sim.getQueueStats();
      expect(queues[0].depth).toBe(120);
      expect(queues.every((q) => !q.paused)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getWorkerStatus()
  // ---------------------------------------------------------------------------
  describe('getWorkerStatus()', () => {
    it('has stuck and dead workers in backlog_growing', async () => {
      const sim = new QueueSimulator();
      const workers = await sim.getWorkerStatus();
      expect(workers).toHaveLength(5);
      const stuck = workers.filter((w) => w.status === 'stuck');
      const dead = workers.filter((w) => w.status === 'dead');
      expect(stuck).toHaveLength(2);
      expect(dead).toHaveLength(1);
    });

    it('has all active workers in draining', async () => {
      const sim = new QueueSimulator();
      sim.transition('draining');
      const workers = await sim.getWorkerStatus();
      expect(workers.every((w) => w.status === 'active')).toBe(true);
    });

    it('has mix of active and idle workers in cleared', async () => {
      const sim = new QueueSimulator();
      sim.transition('cleared');
      const workers = await sim.getWorkerStatus();
      const active = workers.filter((w) => w.status === 'active');
      const idle = workers.filter((w) => w.status === 'idle');
      expect(active.length).toBeGreaterThan(0);
      expect(idle.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getDeadLetterStats()
  // ---------------------------------------------------------------------------
  describe('getDeadLetterStats()', () => {
    it('has high depth and 3 errors in backlog_growing', async () => {
      const sim = new QueueSimulator();
      const dlq = await sim.getDeadLetterStats();
      expect(dlq.depth).toBe(4_230);
      expect(dlq.recentErrors).toHaveLength(3);
    });

    it('has same depth but fewer errors in draining', async () => {
      const sim = new QueueSimulator();
      sim.transition('draining');
      const dlq = await sim.getDeadLetterStats();
      expect(dlq.depth).toBe(4_230);
      expect(dlq.recentErrors).toHaveLength(1);
    });

    it('has low depth and no errors in cleared', async () => {
      const sim = new QueueSimulator();
      sim.transition('cleared');
      const dlq = await sim.getDeadLetterStats();
      expect(dlq.depth).toBe(150);
      expect(dlq.recentErrors).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getProcessingRate()
  // ---------------------------------------------------------------------------
  describe('getProcessingRate()', () => {
    it('has positive growth rate in backlog_growing', async () => {
      const sim = new QueueSimulator();
      const rates = await sim.getProcessingRate();
      expect(rates.backlogGrowthRate).toBe(260);
      expect(rates.estimatedClearTime).toBe(Infinity);
    });

    it('has negative growth rate in draining', async () => {
      const sim = new QueueSimulator();
      sim.transition('draining');
      const rates = await sim.getProcessingRate();
      expect(rates.backlogGrowthRate).toBe(-265);
      expect(rates.incomingRate).toBe(0);
    });

    it('has negative growth rate and zero clear time in cleared', async () => {
      const sim = new QueueSimulator();
      sim.transition('cleared');
      const rates = await sim.getProcessingRate();
      expect(rates.backlogGrowthRate).toBe(-200);
      expect(rates.estimatedClearTime).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('queue_stats returns full status', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'queue_stats' }) as Record<string, unknown>;
      expect(result).toHaveProperty('queues');
      expect(result).toHaveProperty('workers');
      expect(result).toHaveProperty('dlq');
      expect(result).toHaveProperty('rates');
    });

    it('pause_intake transitions to draining', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'pause_intake' }) as Record<string, unknown>;
      expect(result.paused).toBe(true);
      const queues = await sim.getQueueStats();
      expect(queues.every((q) => q.paused)).toBe(true);
    });

    it('restart_workers transitions to draining', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'restart_workers' }) as Record<string, unknown>;
      expect(result.restartedWorkers).toBe(true);
    });

    it('resume_intake transitions to cleared', async () => {
      const sim = new QueueSimulator();
      sim.transition('draining');
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'resume_intake' }) as Record<string, unknown>;
      expect(result.resumed).toBe(true);
      const queues = await sim.getQueueStats();
      expect(queues[0].depth).toBe(120);
    });

    it('scale_workers returns target count', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({
        type: 'structured_command',
        operation: 'scale_workers',
        parameters: { count: 20 },
      }) as Record<string, unknown>;
      expect(result.scaled).toBe(true);
      expect(result.targetCount).toBe(20);
    });

    it('scale_workers defaults to 10 without count param', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'scale_workers' }) as Record<string, unknown>;
      expect(result.targetCount).toBe(10);
    });

    it('dlq_retry returns retried count', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({
        type: 'structured_command',
        operation: 'dlq_retry',
        parameters: { count: 50 },
      }) as Record<string, unknown>;
      expect(result.retriedCount).toBe(50);
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new QueueSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'unknown' }) as Record<string, unknown>;
      expect(result.simulated).toBe(true);
    });

    it('throws on wrong command type', async () => {
      const sim = new QueueSimulator();
      await expect(sim.executeCommand({ type: 'api_call', operation: 'test' }))
        .rejects.toThrow('Unsupported queue simulator command type: api_call');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('evaluates queue_service_health', async () => {
      const sim = new QueueSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'queue_service_health',
        expect: { operator: 'eq', value: 'ok' },
      });
      expect(result).toBe(true);
    });

    it('evaluates total_queue_depth', async () => {
      const sim = new QueueSimulator();
      // backlog_growing total: 84500 + 23100 + 156000 = 263600
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'total_queue_depth',
        expect: { operator: 'gt', value: 200_000 },
      });
      expect(result).toBe(true);
    });

    it('evaluates stuck_worker_count', async () => {
      const sim = new QueueSimulator();
      // backlog_growing: 2 stuck + 1 dead = 3
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'stuck_worker_count',
        expect: { operator: 'eq', value: 3 },
      });
      expect(result).toBe(true);
    });

    it('evaluates backlog_growth_rate', async () => {
      const sim = new QueueSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'backlog_growth_rate',
        expect: { operator: 'gt', value: 0 },
      });
      expect(result).toBe(true);
    });

    it('evaluates dlq_depth', async () => {
      const sim = new QueueSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'dlq_depth',
        expect: { operator: 'eq', value: 4230 },
      });
      expect(result).toBe(true);
    });

    it('returns true for unknown statement', async () => {
      const sim = new QueueSimulator();
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
      const sim = new QueueSimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0].id).toBe('queue-simulator-read');
      expect(providers[1].id).toBe('queue-simulator-write');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new QueueSimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });
});
