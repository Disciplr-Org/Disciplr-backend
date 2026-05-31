import request from 'supertest';
import { app } from '../app.js';
import { metricsRouter } from '../routes/metrics.js';
import { BackgroundJobSystem } from '../jobs/system.js';
import { getPgPool } from '../db/pool.js';
import { getLatestListenerLag } from '../services/monitor.js';

// Mock admin guard for testing purposes
app.use((req, res, next) => {
  // Simulate authenticated admin user
  (req as any).user = { role: 'ADMIN' };
  next();
});

// Attach job system and mocks
const mockJobSystem = new BackgroundJobSystem();
mockJobSystem.getMetrics = () => ({
  queueDepth: 5,
  totals: { failed: 2 },
} as any);
app.locals.jobSystem = mockJobSystem;

// Mock database pool metrics
jest.mock('../db/pool', () => ({
  getPgPool: () => ({
    // Simulate pg Pool object; getDBHealthMetrics will handle it
  }),
}));

// Mock DB health metrics
jest.mock('../services/dbMetrics', () => ({
  getDBHealthMetrics: () => ({
    pool: {
      availableConnections: 3,
      waitingClients: 1,
      totalConnections: 5,
      poolSize: { min: 2, max: 10 },
      timestamp: new Date(),
    },
    slowQueries: [],
    isHealthy: true,
    warnings: [],
  }),
}));

// Mock listener lag
jest.mock('../services/monitor', () => ({
  getLatestListenerLag: () => 42,
}));

describe('GET /api/metrics', () => {
  it('returns Prometheus metrics with gauges', async () => {
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    const body = response.text;
    expect(body).toMatch(/disciplr_job_queue_depth 5/);
    expect(body).toMatch(/disciplr_job_failed_total 2/);
    expect(body).toMatch(/disciplr_db_available_connections 3/);
    expect(body).toMatch(/disciplr_db_waiting_clients 1/);
    expect(body).toMatch(/disciplr_horizon_listener_lag 42/);
  });
});
