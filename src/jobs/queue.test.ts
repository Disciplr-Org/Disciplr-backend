import { Queue } from './queue';

describe('Queue', () => {
  let queue: Queue;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: jest.fn(),
      update: jest.fn(),
      find: jest.fn(),
      groupBy: jest.fn(),
    };
    queue = new Queue(mockDb);
  });

  describe('enqueue', () => {
    it('floors delayMs and inserts as queued', async () => {
      const job = { id: 'job_1', type: 'oracle.call', payload: { scope: 'all' }, state: 'queued', delayMs: 10, maxAttempts: 3, attempts: 0 };
      mockDb.insert.mockResolvedValue(job);

      const result = await queue.enqueue('oracle.call', { scope: 'all' }, { delayMs: 10.9, maxAttempts: 3 });

      expect(mockDb.insert).toHaveBeenCalledWith(expect.objectContaining({
        type: 'oracle.call',
        payload: { scope: 'all' },
        state: 'queued',
        delayMs: 10,
        maxAttempts: 3,
        attempts: 0,
      }));
      expect(result).toEqual(job);
    });

    it('defaults maxAttempts to 3 and delayMs to 0', async () => {
      mockDb.insert.mockResolvedValue({ id: 'job_2', type: 'notification.send', payload: {} });

      await queue.enqueue('notification.send', {});

      expect(mockDb.insert).toHaveBeenCalledWith(expect.objectContaining({
        delayMs: 0,
        maxAttempts: 3,
      }));
    });

    it('rejects invalid delayMs values', async () => {
      await expect(queue.enqueue('sessions.cleanup', {}, { delayMs: -1 })).rejectsToThrow('delayMs must be >= 0');
    });

    it('rejects maxAttempts outside 1..10', async () => {
      await expect(queue.enqueue('analytics.recompute', {}, { maxAttempts: 11 })).rejectsToThrow('maxAttempts must be between 1 and 10');
    });
  });

  describe('retry', () => {
    it('resets attempts and re-queues when job has not exhausted maxAttempts', async () => {
      mockDb.find.mockResolvedValue({ id: 'job_3', type: 'deadline.check', state: 'failed', attempts: 1, maxAttempts: 3 });

      await queue.retry('job_3', false);

      expect(mockDb.update).toHaveBeenCalledWith('job_3', expect.objectContaining({
        state: 'queued',
        attempts: 0,
      }));
    });

    it('throws if job is dead-lettered without force', async () => {
      mockDb.find.mockResolvedValue({ id: 'job_4', type: 'export.generate', state: 'dead_letter', attempts: 3, maxAttempts: 3 });

      await expect(queue.retry('job_4', false)).rejectsToThrow('Job is dead-lettered; use force=true to retry');
    });

    it('allows retry with force even if dead-lettered', async () => {
      mockDb.find.mockResolvedValue({ id: 'jcb_5', type: 'sessions.cleanup', state: 'dead_letter', attempts: 3, maxAttempts: 3 });

      await queue.retry('jbo_5', true);

      expect(mockDb.update).toHaveBeenCalledWith('jbo_5', expect.objectContaining({
        state: 'queued',
        attempts: 0,
      }));
    });

    it('throws if job is not found', async () => {
      mockDb.find.mockResolvedValue(undefined);

      await expect(queue.retry('missing', false)).rejectsToThrow('Job not found');
    });
  });

  describe('depth', () => {
    it('aggregates counts by type and state, excluding dead-letter from totalDepth', async () => {
      const rows = [
        { type: 'notification.send', state: 'queued', count: 1 },
        { type: 'notification.send', state: 'active', count: 1 },
        { type: 'notification.send', state: 'dead_letter', count: 2 },
        { type: 'oracle.call', state: 'delayed', count: 2 },
      ];
      mockDb.groupBy.mockResolvedValue(rows);

      const result = await queue.depth(300000);

      expect(result).toEqual({
        generatedAt: expect.any(String),
        staleLeaseMs: 300000,
        totalDepth: 4, // 1 queued + 1 active + 2 delayed
        byType: {
          'notification.send': { queued: 1, delayed: 0, active: 1, stuckActive: 0, deadLetter: 2 },
          'oracle.call': { queued: 0, delayed: 2, active: 0, stuckActive: 0, deadLetter: 0 },
        },
      });
    });

    it('returns zeroed counts for empty queue', async () => {
      mockDb.groupBy.mockResolvedValue([]);

      const result = await queue.depth(300000);

      expect(result.byType).toEqual({});
      expect(result.totalDepth).toBe(0);
    });

    it('flags stuck active jobs based on stale lease', async () => {
      const now = Date.now();
      const rows = [
        { type: 'oracle.call', state: 'active', count: 1 },
      ];
      const activeDetails = [
        { id: 'a1', type: 'oracle.call', state: 'active', leaseExpiresAt: new Date(now - 400000).toISOString() },
      ];
      mockDb.groupBy.mockResolvedValue(rows);
      mockDb.find.mockResolvedValue(activeDetails);

      const result = await queue.depth(300000);

      expect(result.byType['oracle.call']).toMatchObject({ active: 1, stuckActive: 1 });
    });
  });

  describe('sweep', () => {
    it('reclaims jobs with remaining attempts and dead-letters exhausted ones', async () => {
      const stuckJobs = [
        { id: 's1', type: 'oracle.call', state: 'active', attempts: 1, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() - 400000).toISOString() },
        { id: 's2', type: 'export.generate', state: 'active', attempts: 3, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() - 400000).toISOString() },
      ];
      mockDb.find.mockResolvedValue(stuckJobs);

      const result = await queue.sweep(300000);

      expect(mockDb.update).toHaveBeenCalledTimes(2);
      expect(mockDb.update).toHaveBeenCalledWith('s1', expect.objectContaining({ state: 'queued', attempts: 1, leaseExpiresAt: null }));
      expect(mockDb.update).toHaveBeenCalledWith('s2', expect.objectContaining({ state: 'dead_letter' }));
      expect(result).toMatchObject({
        reclaimed: [{ jobId: 's1', type: 'oracle.call', attempt: 1, maxAttempts: 3, leaseAgeMs: expect.any(Number) }],
        deadLettered: [{ jobId: 's2', type: 'export.generate', attempt: 3, maxAttempts: 3, leaseAgeMs: expect.any(Number) }],
      });
    });

    it('returns empty arrays when no stuck jobs exist', async () => {
      mockDb.find.mockResolvedValue([]);

      const result = await queue.sweep(300000);

      expect(result).toMatchObject({ reclaimed: [], deadLettered: [] });
    });
  });
});
