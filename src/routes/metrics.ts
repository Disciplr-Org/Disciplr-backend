import express, { Request, Response } from 'express';
import client from 'prom-client';
import { getDBHealthMetrics } from '../services/dbMetrics.js';
import { pool, db } from '../db/index.js';
import { BackgroundJobSystem } from '../jobs/system.js';
import { getLatestListenerLag } from '../services/monitor.js';
import { getBreakerStatesForMetrics } from '../services/webhooks.js';

// Create a Registry which registers the metrics
const register = new client.Registry();

// Enable collection of default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// Define custom gauges
// Aggregate-only — no tenant/org/user labels to avoid leaking tenant identity
const jobQueueDepthGauge = new client.Gauge({
  name: 'disciplr_job_queue_depth',
  help: 'Current depth of the background job queue',
  registers: [register],
});

const jobFailedGauge = new client.Gauge({
  name: 'disciplr_job_failed_total',
  help: 'Total number of failed jobs',
  registers: [register],
});

const dbAvailableGauge = new client.Gauge({
  name: 'disciplr_db_available_connections',
  help: 'Number of available DB connections in the pool',
  registers: [register],
});

const dbWaitingGauge = new client.Gauge({
  name: 'disciplr_db_waiting_clients',
  help: 'Number of clients waiting for a DB connection',
  registers: [register],
});

const listenerLagGauge = new client.Gauge({
  name: 'disciplr_horizon_listener_lag',
  help: 'Lag (in ledgers) between Horizon and our listener',
  registers: [register],
});

const outboxLagGauge = new client.Gauge({
  name: 'disciplr_outbox_relay_lag_seconds',
  help: 'Outbox relay lag in seconds (oldest unprocessed row age)',
  registers: [register],
});

const webhookBreakerClosedGauge = new client.Gauge({
  name: 'disciplr_webhook_breaker_closed',
  help: 'Number of webhook subscribers with closed circuit breaker',
  registers: [register],
});

const webhookBreakerOpenGauge = new client.Gauge({
  name: 'disciplr_webhook_breaker_open',
  help: 'Number of webhook subscribers with open circuit breaker',
  registers: [register],
});

const webhookBreakerHalfOpenGauge = new client.Gauge({
  name: 'disciplr_webhook_breaker_half_open',
  help: 'Number of webhook subscribers with half-open circuit breaker',
  registers: [register],
});

const router = express.Router();

router.get('/metrics', async (_req: Request, res: Response) => {
  // Update gauges on each scrape
  // Job system metrics – we need an instance; assume a singleton is attached to app locals
  const jobSystem: BackgroundJobSystem | undefined = (res.app?.locals?.jobSystem as BackgroundJobSystem) ?? undefined;
  if (jobSystem) {
    const metrics = jobSystem.getMetrics();
    jobQueueDepthGauge.set(metrics.queueDepth);
    jobFailedGauge.set(metrics.totals.failed);
  }

  // DB pool metrics
  const dbMetrics = getDBHealthMetrics(pool);
  dbAvailableGauge.set(dbMetrics.pool.availableConnections);
  dbWaitingGauge.set(dbMetrics.pool.waitingClients);

  // Listener lag metric
  const lag = getLatestListenerLag();
  if (typeof lag === 'number') {
    listenerLagGauge.set(lag);
  }

  // Outbox relay lag metric
  try {
    const oldestRow = await db('vault_outbox')
      .where('processed', false)
      .orderBy('created_at', 'asc')
      .first();
    const lagSeconds = oldestRow
      ? Math.max(0, (Date.now() - new Date(oldestRow.created_at).getTime()) / 1000)
      : 0;
    outboxLagGauge.set(lagSeconds);
  } catch (error) {
    console.error('Error fetching outbox lag metric:', error);
  }

  // Webhook circuit breaker metrics
  try {
    const breakerMetrics = await getBreakerStatesForMetrics();
    webhookBreakerClosedGauge.set(breakerMetrics.closed);
    webhookBreakerOpenGauge.set(breakerMetrics.open);
    webhookBreakerHalfOpenGauge.set(breakerMetrics.halfOpen);
  } catch (error) {
    console.error('Error fetching webhook breaker metrics:', error);
  }

  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export const metricsRouter = router;
