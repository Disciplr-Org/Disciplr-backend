import { Pool } from 'pg'

interface PoolMetrics {
  availableConnections: number
  waitingClients: number
  totalConnections: number
  poolSize: {
    min: number
    max: number
  }
  timestamp: Date
}

interface DBHealthMetrics {
  pool: PoolMetrics
  slowQueries: SlowQueryEntry[]
  isHealthy: boolean
  warnings: string[]
}

/**
 * Extract pool statistics from pg.Pool
 * Safely accesses pool internals without exposing sensitive data
 */
function getPoolStats(pool: any): PoolMetrics {
  // pg.Pool stores client information in private properties
  const idleClients = pool._idle?.length ?? 0
  const waitingClients = pool._waitingClients?.length ?? 0
  const allClients = pool._clients?.length ?? idleClients + waitingClients

  // Get configuration (should always be available)
  const poolConfig = pool.options || pool.config || {}
  const max = poolConfig.max ?? 10
  const min = poolConfig.min ?? 2

  return {
    availableConnections: Math.max(0, idleClients),
    waitingClients: Math.max(0, waitingClients),
    totalConnections: Math.max(0, allClients ?? idleClients + waitingClients),
    poolSize: {
      min: min,
      max: max,
    },
    timestamp: new Date(),
  }
}

/**
 * Get comprehensive database health metrics
 * @param pgPool - PostgreSQL pool instance
 * @returns Health metrics including pool stats and slow queries
 */
export function getDBHealthMetrics(pgPool: Pool): DBHealthMetrics {
  const poolMetrics = getPoolStats(pgPool)
  const allEntries = slowQueryRingBuffer.getAll()
  // Return up to 20 most recent slow-query entries from the ring buffer
  const slowQueries = allEntries.slice(-20)

  // Generate warnings based on pool health
  const warnings: string[] = []

  if (poolMetrics.availableConnections === 0) {
    warnings.push('No idle connections available - pool may be under stress')
  }

  if (poolMetrics.waitingClients > 0) {
    warnings.push(`${poolMetrics.waitingClients} clients waiting for connections`)
  }

  if (poolMetrics.totalConnections >= poolMetrics.poolSize.max * 0.9) {
    warnings.push('Pool is at 90% capacity - consider scaling')
  }

  if (slowQueries.length > 10) {
    warnings.push(`High number of slow queries detected (${slowQueries.length})`)
  }

  const isHealthy = warnings.length === 0 && poolMetrics.availableConnections > 0

  return {
    pool: poolMetrics,
    slowQueries,
    isHealthy,
    warnings,
  }
}

/**
 * Progress snapshot for the milestone-embedding reindex backfill job.
 * Recorded after every batch so operators can observe backfill progress
 * (and detect a stalled/backsliding cursor) without querying the DB directly.
 */
export interface EmbeddingReindexProgress {
  processed: number
  reindexed: number
  skippedUpToDate: number
  cursor: string | null
  done: boolean
  modelVersion: string
}

interface EmbeddingReindexMetrics extends EmbeddingReindexProgress {
  recordedAt: Date
}

let lastEmbeddingReindexProgress: EmbeddingReindexMetrics | null = null

/**
 * Record progress from one reindex batch. Called by the embedding reindex
 * job after each batch; overwrites the previous snapshot.
 */
export function recordEmbeddingReindexProgress(progress: EmbeddingReindexProgress): void {
  lastEmbeddingReindexProgress = { ...progress, recordedAt: new Date() }
}

/**
 * Get the most recently recorded embedding reindex progress, or null if the
 * job has not run yet in this process.
 */
export function getEmbeddingReindexProgress(): EmbeddingReindexMetrics | null {
  return lastEmbeddingReindexProgress
}

/**
 * Reset the embedding reindex progress snapshot (useful for tests).
 */
export function resetEmbeddingReindexProgress(): void {
  lastEmbeddingReindexProgress = null
}

export { PoolMetrics, DBHealthMetrics }

// ── Slow-query ring buffer ────────────────────────────────────────────────────

/** A single entry in the ring buffer – fingerprint only, never raw parameters. */
export interface SlowQueryEntry {
  /** Normalized SQL fingerprint with literals replaced by placeholders. */
  fingerprint: string
  /** Observed duration in milliseconds. */
  durationMs: number
  /** ISO 8601 capture timestamp. */
  capturedAt: string
}

const getThresholdMs = (): number => {
  const v = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '200', 10)
  return Math.max(0, isNaN(v) ? 200 : v)
}

const getBufferSize = (): number => {
  const v = parseInt(process.env.SLOW_QUERY_BUFFER_SIZE ?? '100', 10)
  return Math.max(1, isNaN(v) ? 100 : v)
}

/** Normalizes a SQL string into a parameter-free fingerprint. */
export function fingerprintSql(sql: string): string {
  return sql
    .replace(/'[^']*'/g, '?')                              // quoted strings
    .replace(/\$\d+/g, '?')                                // $1 $2 … positional params (before int regex)
    .replace(/\b\d+\.\d+\b/g, '?')                         // float literals (before int regex)
    .replace(/\b\d+\b/g, '?')                              // integer literals
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200)
}

class SlowQueryRingBuffer {
  private buf: SlowQueryEntry[] = []
  private head = 0   // next write slot

  private get size(): number { return getBufferSize() }

  record(sql: string, durationMs: number): void {
    if (durationMs < getThresholdMs()) return
    const entry: SlowQueryEntry = {
      fingerprint: fingerprintSql(sql),
      durationMs,
      capturedAt: new Date().toISOString(),
    }
    if (this.buf.length < this.size) {
      this.buf.push(entry)
      this.head = this.buf.length % this.size
    } else {
      this.buf[this.head] = entry
      this.head = (this.head + 1) % this.size
    }
  }

  /** Returns entries ordered oldest → newest. */
  getAll(): SlowQueryEntry[] {
    if (this.buf.length < this.size) return [...this.buf]
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)]
  }

  reset(): void { this.buf = []; this.head = 0 }
}

export const slowQueryRingBuffer = new SlowQueryRingBuffer()

/**
 * Call this from the Knex `query-response` / `query-error` hook to capture
 * queries that exceed the configured threshold.
 */
export function captureSlowQuery(sql: string, durationMs: number): void {
  slowQueryRingBuffer.record(sql, durationMs)
}

/** Returns all buffered slow-query entries (oldest → newest). */
export function getSlowQueryBuffer(): SlowQueryEntry[] {
  return slowQueryRingBuffer.getAll()
}

/** Clears the ring buffer (useful for tests). */
export function resetSlowQueryBuffer(): void {
  slowQueryRingBuffer.reset()
}
