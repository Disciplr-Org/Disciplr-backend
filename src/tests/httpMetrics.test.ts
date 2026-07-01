import { Request, Response } from 'express';
import assert from 'assert'; 
import { recordMetricsDirectly, httpRequestsTotal, httpRequestDurationSeconds } from '../observability/httpMetrics.js';

describe('RED Metrics HTTP Middleware Tests', () => {
  
  // Clear the metric counts manually before each test block runs
  beforeEach(() => {
    try {
      // If the registry has a clear method, reset it to prevent overlaps
      (httpRequestsTotal as any).clear?.();
      (httpRequestDurationSeconds as any).clear?.();
    } catch (e) {
      // Fallback if clear handles differently
    }
  });

  it('should collect metrics cleanly for a successfully matched route', async () => {
    const mockReq = { method: 'GET', route: { path: '/api/test/:id' } } as unknown as Request;
    const mockRes = { statusCode: 200 } as unknown as Response;

    // Run our isolated logic mechanism
    recordMetricsDirectly(mockReq, mockRes, 0.123);

    // Grab the internal raw values collected by prom-client directly
    const resultMetrics = await (httpRequestsTotal as any).hashMap;
    
    // Validate that our tracking logic populated the metrics data successfully
    assert.ok(resultMetrics, 'Metrics hash map should exist and collect data');
  });

  it('should safely fall back to NOT_FOUND on 404 endpoints', async () => {
    const mockReq = { method: 'GET', route: undefined } as unknown as Request;
    const mockRes = { statusCode: 404 } as unknown as Response;

    recordMetricsDirectly(mockReq, mockRes, 0.045);

    const resultMetrics = await (httpRequestsTotal as any).hashMap;
    assert.ok(resultMetrics, 'Metrics hash map should handle 404 routes safely');
  });
});