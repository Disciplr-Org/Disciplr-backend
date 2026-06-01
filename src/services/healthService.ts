import { prisma } from '../lib/prisma.js';
import { db } from '../db/knex.js';
import type { BackgroundJobSystem } from '../jobs/system.js';

const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      if (typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }
    }),
  ]);
}

export const healthService = {
  buildHealthStatus(serviceName: string, jobSystem?: BackgroundJobSystem) {
    const base = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: serviceName,
    };

    if (!jobSystem) {
      return base;
    }

    const metrics = jobSystem.getMetrics();
    return {
      ...base,
      jobs: {
        running: metrics.running,
        queueDepth: metrics.queueDepth,
        activeJobs: metrics.activeJobs,
      },
    };
  },

  async buildDeepHealthStatus(jobSystem: BackgroundJobSystem) {
    const [dbResult, migrationResult, jobResult, horizonResult] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkMigrations(),
      Promise.resolve(this.checkJobSystem(jobSystem)),
      this.checkHorizonListener(),
    ]);

    const database =
      dbResult.status === 'fulfilled'
        ? dbResult.value
        : { status: 'down', error: String(dbResult.reason?.message ?? 'Unknown error') };

    const migrations =
      migrationResult.status === 'fulfilled'
        ? migrationResult.value
        : { status: 'down', pendingCount: 0, error: String(migrationResult.reason?.message ?? 'Unknown error') };

    const jobs =
      jobResult.status === 'fulfilled'
        ? jobResult.value
        : { status: 'down', error: String(jobResult.reason?.message ?? 'Unknown error') };

    const horizonListener =
      horizonResult.status === 'fulfilled'
        ? horizonResult.value
        : { status: 'down', error: String(horizonResult.reason?.message ?? 'Unknown error') };

    const components = [database, migrations, jobs, horizonListener];
    const isDown = components.some((c: any) => c.status === 'down');
    const isDegraded = components.some((c: any) => c.status === 'stale');

    return {
      status: isDown ? 'error' : isDegraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      details: {
        database,
        migrations,
        jobs,
        horizonListener,
      },
    };
  },

  async checkDatabase(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: string; error?: string }> {
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, 'Database check');
      return { status: 'up' };
    } catch (error: any) {
      return { status: 'down', error: error.message };
    }
  },

  async checkMigrations(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: string; pendingCount: number; error?: string }> {
    try {
      const result = await withTimeout(db.migrate.list(), timeoutMs, 'Migration check') as [any, any[]];
      const pending = result[1];
      return { status: 'up', pendingCount: pending.length };
    } catch (error: any) {
      return { status: 'down', pendingCount: 0, error: error.message };
    }
  },

  checkJobSystem(jobSystem: BackgroundJobSystem): {
    status: string;
    running: boolean;
    queueDepth: number;
    activeJobs: number;
    totals: { enqueued: number; completed: number; failed: number };
  } {
    const metrics = jobSystem.getMetrics();
    return {
      status: metrics.running ? 'up' : 'down',
      running: metrics.running,
      queueDepth: metrics.queueDepth,
      activeJobs: metrics.activeJobs,
      totals: {
        enqueued: metrics.totals.enqueued,
        completed: metrics.totals.completed,
        failed: metrics.totals.failed,
      },
    };
  },

  async checkHorizonListener(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
    status: string;
    lastProcessedLedger?: number;
    lastProcessedAt?: string;
    timeSinceLastEventMs?: number;
    error?: string;
  }> {
    const isEnabled = !!(process.env.HORIZON_URL && process.env.CONTRACT_ADDRESS);
    if (!isEnabled) {
      return { status: 'disabled' };
    }

    // Degraded threshold: 5 minutes. Down threshold: 30 minutes.
    const DEGRADED_THRESHOLD_MS = Number(process.env.LISTENER_DEGRADED_THRESHOLD_MS ?? 5 * 60 * 1000);
    const DOWN_THRESHOLD_MS = Number(process.env.LISTENER_DOWN_THRESHOLD_MS ?? 30 * 60 * 1000);

    try {
      const state = await withTimeout(
        db('listener_state')
          .where({ service_name: 'horizon_listener' })
          .select('last_processed_at', 'last_processed_ledger')
          .first() as Promise<{ last_processed_at: string | Date; last_processed_ledger: number | null } | undefined>,
        timeoutMs,
        'Horizon listener check',
      );

      if (!state || !state.last_processed_at) {
        return { status: 'down', error: 'No heartbeat recorded in listener_state' };
      }

      const lastProcessedAt = new Date(state.last_processed_at);
      const timeSinceLastEventMs = Date.now() - lastProcessedAt.getTime();
      const lastProcessedLedger = state.last_processed_ledger != null ? Number(state.last_processed_ledger) : undefined;

      if (timeSinceLastEventMs > DOWN_THRESHOLD_MS) {
        return {
          status: 'down',
          lastProcessedLedger,
          lastProcessedAt: lastProcessedAt.toISOString(),
          timeSinceLastEventMs,
          error: 'Listener appears to be down (no events for over 30 minutes)',
        };
      }

      if (timeSinceLastEventMs > DEGRADED_THRESHOLD_MS) {
        return {
          status: 'stale',
          lastProcessedLedger,
          lastProcessedAt: lastProcessedAt.toISOString(),
          timeSinceLastEventMs,
          error: 'Heartbeat is stale',
        };
      }

      return {
        status: 'up',
        lastProcessedLedger,
        lastProcessedAt: lastProcessedAt.toISOString(),
        timeSinceLastEventMs,
      };
    } catch (error: any) {
      return { status: 'down', error: error.message };
    }
  },

  // Kept for backward compatibility; not used by the new health endpoints.
  async checkHorizon(): Promise<{ status: string; error?: string }> {
    return { status: 'down', error: 'Deprecated' };
  },
};

