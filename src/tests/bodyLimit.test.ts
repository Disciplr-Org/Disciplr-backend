import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Import just what we need for this test, avoiding full app import that pulls in Prisma
const { errorHandler, ErrorCode } = await import('../middleware/errorHandler.js');

describe('JSON Body Size Limits', () => {
  let app: express.Application;

  beforeEach(() => {
    // Create a minimal test app
    app = express();
    app.use(express.json({ limit: '500kb' }));

    // Add a test route
    app.post('/test-body-limit', (req: express.Request, res: express.Response) => {
      res.status(200).json({ status: 'ok', size: JSON.stringify(req.body).length });
    });

    // Add the error handler
    app.use(errorHandler);
  });

  it('should accept payloads within the default 500kb limit', async () => {
    // Generate a payload that is ~10kb
    const normalPayload = {
      data: 'a'.repeat(10000), // 10kb of string data
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(normalPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should reject payloads exceeding the 500kb limit with 413 Error', async () => {
    // Generate a payload that is ~600kb (exceeds 500kb default)
    const largePayload = {
      data: 'a'.repeat(600 * 1024), // 600kb of string data
    };

    const res = await request(app)
      .post('/test-body-limit')
      .send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(res.body.error.message).toBe('Payload too large');
  });
});
