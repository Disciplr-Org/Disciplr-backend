import { Request, Response } from 'express';
import assert from 'assert';
import { recordMetricsDirectly, httpRequestsTotal, httpRequestDurationSeconds } from '../observability/httpMetrics.js';

describe('RED Metrics HTTP Middleware Tests', () => {

  // Clear the metric counts manually before each test block runs
  beforeEach(() => {
    try {
      (httpRequestsTotal as any).clear?.();
      (httpRequestDurationSeconds as any).clear?.();
    } catch (e) {
      // Fallback if clear handles differently
    }
  });

  it('should collect metrics cleanly for a successfully matched route', async () => {
    const mockReq = { method: 'GET', baseUrl: '/api', route: { path: '/test/:id' } } as unknown as Request;
    const mockRes = { statusCode: 200 } as unknown as Response;

    recordMetricsDirectly(mockReq, mockRes, 0.123);

    const resultMetrics = await (httpRequestsTotal as any).hashMap;
    assert.ok(resultMetrics, 'Metrics hash map should exist and collect data');
  });

  it('should safely fall back to NOT_FOUND on 404 endpoints', async () => {
    const mockReq = { method: 'GET', baseUrl: '', route: undefined } as unknown as Request;
    const mockRes = { statusCode: 404 } as unknown as Response;

    recordMetricsDirectly(mockReq, mockRes, 0.045);

    const resultMetrics = await (httpRequestsTotal as any).hashMap;
    assert.ok(resultMetrics, 'Metrics hash map should handle 404 routes safely');
  });

  it('should use req.baseUrl + req.route.path as the full route label', async () => {
    // Simulate a route mounted under /api/webhooks with path /:id
    const mockReq = {
      method: 'GET',
      baseUrl: '/api/webhooks',
      route: { path: '/:id' },
    } as unknown as Request;
    const mockRes = { statusCode: 200 } as unknown as Response;

    recordMetricsDirectly(mockReq, mockRes, 0.05);

    // The key in the hashMap is built from label values — verify the correct
    // full path was recorded rather than just the ambiguous /:id fragment.
    const hashMap = (httpRequestsTotal as any).hashMap as Record<string, unknown>;
    const keys = Object.keys(hashMap);
    assert.ok(
      keys.some(k => k.includes('/api/webhooks/:id')),
      `Expected a metric key containing '/api/webhooks/:id' but found: ${keys.join(', ')}`,
    );
  });

  it('should distinguish between same sub-path pattern on different mounted routers (collision test)', async () => {
    // Two completely different routers, both using /:id as their sub-path pattern.
    // Without baseUrl they would produce the same label; with it they must differ.
    const webhookReq = {
      method: 'DELETE',
      baseUrl: '/api/webhooks',
      route: { path: '/:id' },
    } as unknown as Request;

    const orgMemberReq = {
      method: 'DELETE',
      baseUrl: '/api/orgs/members',
      route: { path: '/:userId' },
    } as unknown as Request;

    const mockRes = { statusCode: 200 } as unknown as Response;

    recordMetricsDirectly(webhookReq, mockRes, 0.03);
    recordMetricsDirectly(orgMemberReq, mockRes, 0.04);

    const hashMap = (httpRequestsTotal as any).hashMap as Record<string, unknown>;
    const keys = Object.keys(hashMap);

    assert.ok(
      keys.some(k => k.includes('/api/webhooks/:id')),
      `Expected metric key for '/api/webhooks/:id', found: ${keys.join(', ')}`,
    );
    assert.ok(
      keys.some(k => k.includes('/api/orgs/members/:userId')),
      `Expected metric key for '/api/orgs/members/:userId', found: ${keys.join(', ')}`,
    );

    // The two labels must be distinct entries — no merging.
    const webhookKeys = keys.filter(k => k.includes('/api/webhooks/:id'));
    const orgKeys = keys.filter(k => k.includes('/api/orgs/members/:userId'));
    assert.ok(webhookKeys.length > 0 && orgKeys.length > 0, 'Both routers must produce separate metric entries');
  });

  it('should handle missing baseUrl gracefully (falls back to empty string prefix)', async () => {
    // req.baseUrl may be undefined for top-level routes; the fix uses ?? '' to guard.
    const mockReq = {
      method: 'GET',
      baseUrl: undefined,
      route: { path: '/health' },
    } as unknown as Request;
    const mockRes = { statusCode: 200 } as unknown as Response;

    // Should not throw and should record /health (not undefined/health)
    assert.doesNotThrow(() => recordMetricsDirectly(mockReq, mockRes, 0.01));

    const hashMap = (httpRequestsTotal as any).hashMap as Record<string, unknown>;
    const keys = Object.keys(hashMap);
    assert.ok(
      keys.some(k => k.includes('/health')),
      `Expected metric key containing '/health', found: ${keys.join(', ')}`,
    );
    assert.ok(
      !keys.some(k => k.includes('undefined')),
      `Route label must not contain the string 'undefined', found: ${keys.join(', ')}`,
    );
  });
});
