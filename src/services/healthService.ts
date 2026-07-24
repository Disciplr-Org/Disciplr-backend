import { prisma } from '../lib/prisma.js';
import { db } from '../db/knex.js';
import type { BackgroundJobSystem } from '../jobs/system.js';
import { getSorobanBootResult } from './sorobanBoot.js';
import { getRpcPoolHealth, type RpcEndpointHealth } from './soroban.js';

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
    const [dbResult, migrationResult, jobResult, horizonResult, schedulerResult] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkMigrations(),
      Promise.resolve(this.checkJobSystem(jobSystem)),
      this.checkHorizonListener(),
      this.checkExpirationScheduler(),
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

    const expirationScheduler =
      schedulerResult.status === 'fulfilled'
        ? schedulerResult.value
        : { status: 'down', error: String(schedulerResult.reason?.message ?? 'Unknown error') };

    const sorobanBoot = this.checkSorobanBoot();
    const sorobanRpcPool = this.checkSorobanRpcPool();

    const components = [database, migrations, jobs, horizonListener, expirationScheduler];
    const isDown = components.some((c: any) => c.status === 'down');
    const isDegraded =
      components.some((c: any) => c.status === 'stale') ||
      (sorobanRpcPool !== null && sorobanRpcPool.some((e: RpcEndpointHealth) => e.status === 'down'));

    return {
      status: isDown ? 'error' : isDegraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      details: {
        database,
        migrations,
        jobs,
        horizonListener,
        expirationScheduler,
        sorobanBoot,
        sorobanRpcPool,
      },
    };
  },

  /**
   * Reports the cached result of the testnet friendbot precheck.
   * Status is 'pending' before the async precheck completes.
   */
  checkSorobanBoot(): { status: string; funded?: boolean; error?: string } {
    const result = getSorobanBootResult();
    if (!result) return { status: 'pending' };
    if (!result.ran) return { status: 'not_applicable' };
    if (result.error) return { status: 'error', error: result.error };
    return { status: 'ok', funded: result.funded ?? false };
  },

  /**
   * Returns current health of each Soroban RPC endpoint in the pool.
   * Returns null when no submissions have been attempted yet (pool not initialised).
   */
  checkSorobanRpcPool(): RpcEndpointHealth[] | null {
    return getRpcPoolHealth();
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

  async checkExpirationScheduler(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
    status: string
    lastRunAt?: string
    timeSinceLastRunMs?: number
    error?: string
  }> {
    const DEGRADED_THRESHOLD_MS = Number(process.env.SCHEDULER_DEGRADED_THRESHOLD_MS ?? 3 * 60 * 1000)
    const DOWN_THRESHOLD_MS = Number(process.env.SCHEDULER_DOWN_THRESHOLD_MS ?? 10 * 60 * 1000)

    try {
      const state = await withTimeout(
        db('scheduler_heartbeats')
          .where({ name: 'expiration_scheduler' })
          .select('last_run_at')
          .first() as Promise<{ last_run_at: string | Date } | undefined>,
        timeoutMs,
        'Expiration scheduler check'
      )

      if (!state || !state.last_run_at) {
        return { status: 'down', error: 'No heartbeat recorded in scheduler_heartbeats' }
      }

      const lastRunAt = new Date(state.last_run_at)
      const timeSinceLastRunMs = Date.now() - lastRunAt.getTime()

      if (timeSinceLastRunMs > DOWN_THRESHOLD_MS) {
        return {
          status: 'down',
          lastRunAt: lastRunAt.toISOString(),
          timeSinceLastRunMs,
          error: 'Scheduler appears to be down (no run for over 10 minutes)',
        }
      }

      if (timeSinceLastRunMs > DEGRADED_THRESHOLD_MS) {
        return {
          status: 'stale',
          lastRunAt: lastRunAt.toISOString(),
          timeSinceLastRunMs,
          error: 'Heartbeat is stale',
        }
      }

      return {
        status: 'up',
        lastRunAt: lastRunAt.toISOString(),
        timeSinceLastRunMs,
      }
    } catch (error: any) {
      return { status: 'down', error: error.message }
    }
  },

  // Kept for backward compatibility; not used by the new health endpoints.
  async checkHorizon(): Promise<{ status: string; error?: string }> {
    return { status: 'down', error: 'Deprecated' };
  },
};

