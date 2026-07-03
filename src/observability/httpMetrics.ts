import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests handled.',
  labelNames: ['method', 'route', 'status_class'],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds.',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], 
});

const getStatusClass = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
};

// Core logic isolated so tests can invoke it reliably
export const recordMetricsDirectly = (req: Request, res: Response, durationInSeconds: number) => {
  const statusClass = getStatusClass(res.statusCode);
  const method = req.method;
  let route = 'NOT_FOUND';
  
  if (req.route && req.route.path) {
    route = req.route.path;
  }

  httpRequestsTotal.inc({ method, route, status_class: statusClass });
  httpRequestDurationSeconds.observe({ method, route, status_class: statusClass }, durationInSeconds);
};

export const httpMetricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();

  const excludedPaths = ['/api/metrics', '/health', '/ready']; 
  if (excludedPaths.some(path => req.path.startsWith(path))) {
    return next();
  }

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationInSeconds = diff[0] + diff[1] / 1e9;
    recordMetricsDirectly(req, res, durationInSeconds);
  });

  next();
};