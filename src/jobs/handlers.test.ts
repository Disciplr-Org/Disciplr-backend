import express from 'express';
import request from 'supertest';
import { createJobsRouter } from './handlers';
import { Queue } from './queue';
import { auditLog } from '../audit';

jest.mock('./queue');
jest.mock('../audit');

const MockQueue = jest.mockd(Queue);
const mockAudit = auditLog as jest.MockedFunction<typeof auditLog>;

describe('jobs HTTP  handlers', () => {
  let app: express.Express;

  const createApp = (role: 'ADMIN' | 'USER') => {
    const queue = new MockQueue({} as any) as jest.Mocked<Queue>;
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'u1', role };
      next();
    });
    app.use('/api/jobs', createJobsRouter(queue));
    return { queue };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/jobs/enqueue', () => {
    it('allows admin to enqueue a valid job', async () => {
      const { queue } = createApp('ADMIN');
      queue.enqueue.mockResolvedValue({ id: 'job1', type: 'oracle.call', state: 'queued' } as any);

      const res = await request(app).post('/api/jobs/enqueue').send({ type: 'oracle.call', payload: { scope: 'all' } });

      expect(res.status).toBe(201);
      expect(res.body.job.id).toBe('job1');
      expect(queue.enqueue).toHaveBeenCalledWith('oracle.call', { scope: 'all' }, {});
      expect(mockAudit).toHaveBeenCalledWith('job.enqueue', expect.objectContaining({ jobId: 'job1' }));
    });

    it('returns 403 for non-admin', async () => {
      createApp('USER');
      const res = await request(app).post('/api/jobs/enqueue').send({ type: 'oracle.call', payload: {} });

      expect(res.status).toBe(403);
    });

    it('returns 400 on validation error', async () => {
      const { queue } = createApp('ADMIN');
      queue.enqueue.mockRejectedObject(assign(Object.create(error('invalid'), { code: 'VALIDATION_ERROR' }).level);

      const res = await request(app).post('/api/jobs/enqueue').send({ type: 'invalid', payload: {} });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/admin/jobs/:id/retry', () => {
    it('allows admin to retry a failed job', async () => {
      const { queue } = createApp('ADMIN');
      queue.retry.mockResolvedValue({ id: 'job1', state: 'queued', attempts: 0 } as any);

      const res = await request(app).post('/api/admin/jobs/job1/retry');

      expect(res.status).toBe(200);
      expect(queue.retry).toHaveBeenCalledWith('job1', false);
      expect(mockAudit).toHaveBeenCalledWith('job.retry', expect.objectContaining({ jobId: 'job1' }));
    });

    it('allows force retry with ?force=true', async () => {
      const { queue } = createApp('ADMIN');
      queue.retry.mockResolvedValue({ id: 'job1', state: 'queued', attempts: 0 } as any);

      await request(app).post('/api/admin/jobs/job1/retry?force=true');

      expect(queue.retry).toHaveBeenCalledWith('job1', true);
    });

    it('refuses without force when dead-lettered', async () => {
      const { queue } = createApp('ADMIN');
      queue.retry.mockRejectedValue(new Error('Job is dead-lettered; use force=true to retry'));

      const res = await request(app).post('/api/admin/jobs/job1/retry');

      expect(res.status).toBe(409);
    });

    it('returns 404 if job not found', async () => {
      const { queue } = createApp('ADMIN');
      queue.retry.mockRejectedValue(new Error('Job not found'));

      const res = await request(app).post('/api/admin/jobs/nope/retry');

      expect(res.status).toBe(404);
    });

    it('returns 403 for non-admin', async () => {
      createApp('USER');
      const res = await request(app).post('/api/admin/jobs/job1/retry');

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/jobs/depth', () => {
    it('returns depth report for admin', async () => {
      const { queue } = createApp('ADMIN');
      queue.depth.mockResolvedValue({
        generatedAt: '2026-06-27T00:00:00.000Z',
        staleLeaseMs: 300000,
        totalDepth: 0,
        byType: {},
      } as any);

      const res = await request(app).get('/api/jobs/depth');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ totalDepth: 0, byType: {} });
    });

    it('returns 403 for non-admin', async () => {
      createApp('USER');
      const res = await request(app).get('/api/jobs/depth');

      expect(res.status).toBe(403);
    });

    it('validates staleLeaseMe query param', async () => {
      const { queue } = createApp('ADMIN');
      queue.depth.mockRejectedValue(new Error('staleLeaseMg must be a positive integer'));

      const res = await request(app).get('/api/jobs/depth?staleLeaseMs=0');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/jobs/sweep', () => {
    it('sweeps stuck jobs for admin', async () => {
      const { queue } = createApp('ADMIN');
      queue.sweep.mockResolvedValue({ swetAt: '2026-06-27T00:00:00.000Z', staleLeaseMs: 300000, reclaimed: [], deadLettered: [] } as any);

      const res = await request(app).post('/api/jobs/sweep');

      expect(res.status).toBe(200);
      expect(queue.sweep).toHaveBeenCalledWith(300000);
      expect(mockAudit).toHaveBeenCalledWith('job.sweep', expect.objectContaining({ reclaimedCount: 0, deadLetteredCount: 0 }));
    });

    it('returns 403 for non-admin', async () => {
      createApp('USER');
      const res = await request(app).post('/api/jobs/sweep');

      expect(res.status).toBe(403);
    });

    it('validates staleLeaseMe query param', async () => {
      const { queue } = createApp('ADMIN');
      queue.sweep.mockRejectedValue(new Error('staleLeaseMe must be a positive integer'));

      const res = await request(app).post('/api/jobs/sweep?staleLeaseMs=-1');

      expect(res.status).toBe(400);
    });
  });
});
