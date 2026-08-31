import { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import { transitionOperation, isTerminal } from './observabilityState.js';

// ── Core RED metrics ─────────────────────────────────────────────────────────

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

// ── Actionable diagnostics ───────────────────────────────────────────────────

/**
 * Number of HTTP requests currently in flight.
 * Exposes real-time concurrency so operators can alert on saturation.
 */
export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed.',
  labelNames: ['method'],
});

/**
 * Count of requests that ended with a 4xx or 5xx status.
 * Enables error-rate alerting without parsing duration histograms.
 */
export const httpErrorsTotal = new client.Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP requests that resulted in a 4xx or 5xx response.',
  labelNames: ['method', 'route', 'status_class'],
});

/**
 * Count of requests that exceeded the slow-request threshold (1 second).
 * Separates latency signal from error signal for faster triage.
 */
export const httpSlowRequestsTotal = new client.Counter({
  name: 'http_slow_requests_total',
  help: 'Total number of HTTP requests exceeding the slow-request threshold.',
  labelNames: ['method', 'route'],
});

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Requests slower than this are counted in httpSlowRequestsTotal. */
const SLOW_REQUEST_THRESHOLD_SECONDS = 1.0;

const getStatusClass = (statusCode: number): string => {
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
};

// Core logic isolated so tests can invoke it reliably.
//
// Atomicity invariant: counter increment and histogram observation are
// wrapped in a single try-catch so both record together or neither does.
// This prevents inconsistent metric state when prom-client throws.
export const recordMetricsDirectly = (
  req: Request,
  res: Response,
  durationInSeconds: number,
): void => {
  const statusClass = getStatusClass(res.statusCode);
  const method = req.method;
  let route = 'NOT_FOUND';

  if (req.route && req.route.path) {
    // Prepend req.baseUrl so routes from different sub-routers with overlapping
    // path patterns (e.g. /:id) are recorded as distinct labels.
    route = (req.baseUrl ?? '') + req.route.path;
  }

  try {
    httpRequestsTotal.inc({ method, route, status_class: statusClass });
    httpRequestDurationSeconds.observe(
      { method, route, status_class: statusClass },
      durationInSeconds,
    );

    // Error diagnostics: count 4xx/5xx for alerting
    if (res.statusCode >= 400) {
      httpErrorsTotal.inc({ method, route, status_class: statusClass });
    }

    // Slow-request diagnostic
    if (durationInSeconds >= SLOW_REQUEST_THRESHOLD_SECONDS) {
      httpSlowRequestsTotal.inc({ method, route });
    }
  } catch {
    // Metrics failures must never propagate to the request lifecycle.
  }
};

// Paths that generate polling traffic excluded from metrics to prevent
// label cardinality inflation and in-flight gauge skew.
const EXCLUDED_PATHS = [
  '/api/metrics',
  '/api/health',
  '/api/v1/health',
  '/health',
  '/ready',
] as const;

function isExcluded(path: string): boolean {
  return EXCLUDED_PATHS.some((p) => path.startsWith(p));
}

export const httpMetricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (isExcluded(req.path)) {
    return next();
  }

  const start = process.hrtime();
  const method = req.method;

  // Mark metrics pipeline as in-progress in the observability state machine
  transitionOperation(req, 'metrics', 'in_progress');

  // Track in-flight concurrency
  httpRequestsInFlight.inc({ method });

  res.on('finish', () => {
    httpRequestsInFlight.dec({ method });

    // Idempotent: skip if metrics already recorded (duplicate finish events)
    if (isTerminal(req, 'metrics')) return;

    try {
      const diff = process.hrtime(start);
      const durationInSeconds = diff[0] + diff[1] / 1e9;
      recordMetricsDirectly(req, res, durationInSeconds);
      transitionOperation(req, 'metrics', 'done');
    } catch {
      // Metrics recording must never propagate errors to the request lifecycle.
      transitionOperation(req, 'metrics', 'failed', 'metrics recording error');
    }
  });

  // Decrement in-flight on abnormal close (client disconnect before finish)
  res.on('close', () => {
    // 'finish' fires before 'close' on a normal response — guard against
    // double-decrement by checking writableEnded.
    if (!res.writableEnded) {
      httpRequestsInFlight.dec({ method });
    }
  });

  next();
};
