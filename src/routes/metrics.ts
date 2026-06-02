import express, { Request, Response } from 'express';
import client from 'prom-client';
import { getDBHealthMetrics } from '../services/dbMetrics.js';
import { pool } from '../db/index.js';
import { BackgroundJobSystem } from '../jobs/system.js';
import { getLatestListenerLag } from '../services/monitor.js';

// Create a Registry which registers the metrics
const register = new client.Registry();

// Enable collection of default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// Define custom gauges
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

  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

export const metricsRouter = router;
