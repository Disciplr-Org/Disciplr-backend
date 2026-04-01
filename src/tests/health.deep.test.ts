import { jest } from '@jest/globals';

jest.unstable_mockModule('../services/healthService.js', () => ({
  healthService: {
    checkDatabase: jest.fn(),
    checkHorizon: jest.fn()
  }
}));

const { healthService } = await import('../services/healthService.js');
const { app } = await import('../app.js');
const { createHealthRouter } = await import('../routes/health.js');
const request = (await import('supertest')).default;

const mockJobSystem: any = { getMetrics: () => ({}) };
app.use('/api/health', createHealthRouter(mockJobSystem));

describe('Health Check Deep', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 for normal health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).not.toHaveProperty('details');
  });

  it('should return 200 and details when deep=1 and services are up', async () => {
    (healthService.checkDatabase as any).mockResolvedValue({ status: 'up' });
    (healthService.checkHorizon as any).mockResolvedValue({ status: 'up' });

    const res = await request(app).get('/api/health?deep=1');
    expect(res.status).toBe(200);
    expect(res.body.details.database.status).toBe('up');
    expect(res.body.details.horizon.status).toBe('up');
  });

  it('should return 503 when a service is down', async () => {
    (healthService.checkDatabase as any).mockResolvedValue({ status: 'down', error: 'Conn error' });
    (healthService.checkHorizon as any).mockResolvedValue({ status: 'up' });
    
    const res = await request(app).get('/api/health?deep=1');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });
});
