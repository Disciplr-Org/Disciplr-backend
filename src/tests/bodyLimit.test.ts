import express from 'express';
import request from 'supertest';
import { requireJson } from '../middleware/requireJson.js';
import {
  AUTH_JSON_MAX_BYTES,
  JOBS_JSON_MAX_BYTES,
} from '../middleware/requestBodyLimits.js';

// Import just what we need for this test, avoiding full app import that pulls in Prisma
const { errorHandler, ErrorCode } = await import('../middleware/errorHandler.js');

describe('JSON Body Size Limits', () => {
  let app: express.Application;
  let authRouteHits: number;
  let jobsRouteHits: number;

  beforeEach(() => {
    authRouteHits = 0;
    jobsRouteHits = 0;
    app = express();
    app.use('/api/auth', express.json({ limit: AUTH_JSON_MAX_BYTES }));
    app.use('/api/jobs/enqueue', express.json({ limit: JOBS_JSON_MAX_BYTES }));
    app.use(express.json({ limit: '500kb' }));

    app.post('/test-body-limit', (req: express.Request, res: express.Response) => {
      res.status(200).json({ status: 'ok', size: JSON.stringify(req.body).length });
    });

    app.post('/api/auth/login', requireJson({ maxBytes: AUTH_JSON_MAX_BYTES }), (_req, res) => {
      authRouteHits += 1;
      res.status(200).json({ status: 'ok' });
    });

    app.post('/api/jobs/enqueue', requireJson({ maxBytes: JOBS_JSON_MAX_BYTES }), (_req, res) => {
      jobsRouteHits += 1;
      res.status(202).json({ queued: true });
    });

    app.use(errorHandler);
  });

  it('should accept payloads within the default 500kb limit', async () => {
    const normalPayload = {
      data: 'a'.repeat(10000),
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(normalPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should reject payloads exceeding the 500kb limit with 413 Error', async () => {
    const largePayload = {
      data: 'a'.repeat(600 * 1024),
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(res.body.error.message).toBe('Payload too large');
  });

  it('should accept auth payloads within the 8kb route limit', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ data: 'a'.repeat(4 * 1024) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(authRouteHits).toBe(1);
  });

  it('should reject auth payloads exceeding the 8kb route limit', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ data: 'a'.repeat(9 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(res.body.error.message).toBe('Payload too large');
    expect(authRouteHits).toBe(0);
  });

  it('should accept jobs payloads larger than auth but within the 32kb route limit', async () => {
    const res = await request(app)
      .post('/api/jobs/enqueue')
      .send({ data: 'a'.repeat(16 * 1024) });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(jobsRouteHits).toBe(1);
  });

  it('should reject jobs payloads exceeding the 32kb route limit', async () => {
    const res = await request(app)
      .post('/api/jobs/enqueue')
      .send({ data: 'a'.repeat(40 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(res.body.error.message).toBe('Payload too large');
    expect(jobsRouteHits).toBe(0);
  });
});
