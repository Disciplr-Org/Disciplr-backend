import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { recordMetricsDirectly, httpMetricsMiddleware, httpRequestsTotal, httpRequestDurationSeconds } from './httpMetrics';
import { Request, Response } from 'express';
import client from 'prom-client';

describe('httpMetrics', () => {
  beforeEach(() => {
    client.register.clear();
  });

  describe('recordMetricsDirectly', () => {
    it('records metrics correctly', () => {
      const req: Partial<Request> = {
        method: 'GET',
        baseUrl: '/api',
        route: { path: '/users/:id' } as any,
      };
      const res: Partial<Response> = {
        statusCode: 200,
      };
      
      const incSpy = jest.spyOn(httpRequestsTotal, 'inc');
      const observeSpy = jest.spyOn(httpRequestDurationSeconds, 'observe');
      
      recordMetricsDirectly(req as Request, res as Response, 1.5);
      
      expect(incSpy).toHaveBeenCalledWith({
        method: 'GET',
        route: '/api/users/:id',
        status_class: '2xx',
      });
      expect(observeSpy).toHaveBeenCalledWith({
        method: 'GET',
        route: '/api/users/:id',
        status_class: '2xx',
      }, 1.5);
      
      incSpy.mockRestore();
      observeSpy.mockRestore();
    });

    it('handles requests without route gracefully', () => {
      const req: Partial<Request> = {
        method: 'POST',
      };
      const res: Partial<Response> = {
        statusCode: 404,
      };
      
      const incSpy = jest.spyOn(httpRequestsTotal, 'inc');
      
      recordMetricsDirectly(req as Request, res as Response, 0.5);
      
      expect(incSpy).toHaveBeenCalledWith({
        method: 'POST',
        route: 'NOT_FOUND',
        status_class: '4xx',
      });
      
      incSpy.mockRestore();
    });
    
    it('handles 5xx status codes', () => {
      const req: Partial<Request> = {
        method: 'PUT',
      };
      const res: Partial<Response> = {
        statusCode: 500,
      };
      
      const incSpy = jest.spyOn(httpRequestsTotal, 'inc');
      recordMetricsDirectly(req as Request, res as Response, 0.5);
      expect(incSpy).toHaveBeenCalledWith({
        method: 'PUT',
        route: 'NOT_FOUND',
        status_class: '5xx',
      });
      incSpy.mockRestore();
    });
  });

  describe('httpMetricsMiddleware', () => {
    it('skips metrics for excluded paths', () => {
      const req: Partial<Request> = {
        path: '/api/health',
      };
      const res: Partial<Response> = {};
      const next = jest.fn();
      
      httpMetricsMiddleware(req as Request, res as Response, next);
      
      expect(next).toHaveBeenCalled();
      // It should not attach 'finish' listener since it returns early
      expect(res.on).toBeUndefined();
    });

    it('attaches finish listener for normal paths', () => {
      const req: Partial<Request> = {
        path: '/api/users',
      };
      const res: Partial<Response> = {
        on: jest.fn(),
      };
      const next = jest.fn();
      
      httpMetricsMiddleware(req as Request, res as Response, next);
      
      expect(next).toHaveBeenCalled();
      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    });
  });
});
