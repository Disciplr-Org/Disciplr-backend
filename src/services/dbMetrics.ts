import { Pool } from 'pg'
import { db } from '../db/index.js'

/**
 * Slow query tracking configuration
 * Tracks queries exceeding threshold for operational insights
 */
interface SlowQuerySample {
  queryHash: string
  duration: number
  queryPattern: string
  count: number
  lastOccurred: Date
}

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
  slowQueries: SlowQuerySample[]
  isHealthy: boolean
  warnings: string[]
}

/**
 * In-memory slow query tracker
 * Stores aggregated query performance data without storing raw SQL
 */
class SlowQueryTracker {
  private queries: Map<string, SlowQuerySample> = new Map()
  private readonly maxSamples = 50
  private readonly thresholdMs = 100 // Log queries exceeding 100ms

  /**
   * Hash a query pattern to aggregate similar queries
   * Removes specific values to normalize queries
   */
  private hashQueryPattern(query: string): { hash: string; pattern: string } {
    // Sanitize query: remove values, parameters, and PII patterns
    let normalized = query
      // Remove quoted strings and string values
      .replace(/'[^']*'/g, "'{value}'")
      // Remove numeric values
      .replace(/\d+/g, '{num}')
      // Remove email patterns (PII protection)
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '{email}')
      // Remove UUIDs
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()

    // Simple hash via character sum (not cryptographic, just for aggregation)
    const hash = Array.from(normalized).reduce(
      (h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0,
      0
    ).toString(16)

    return { hash, pattern: normalized.substring(0, 150) } // Limit pattern length
  }

  /**
   * Record a query execution time
   */
  recordQuery(query: string, durationMs: number): void {
    if (durationMs < this.thresholdMs) return

    const { hash, pattern } = this.hashQueryPattern(query)
    const existing = this.queries.get(hash)

    if (existing) {
      existing.count += 1
      existing.duration = Math.max(existing.duration, durationMs)
      existing.lastOccurred = new Date()
    } else {
      if (this.queries.size >= this.maxSamples) {
        // Remove oldest entry when at capacity
        const oldest = Array.from(this.queries.values()).sort(
          (a, b) => a.lastOccurred.getTime() - b.lastOccurred.getTime()
        )[0]
        if (oldest) {
          this.queries.delete(oldest.queryHash)
        }
      }

      this.queries.set(hash, {
        queryHash: hash,
        duration: durationMs,
        queryPattern: pattern,
        count: 1,
        lastOccurred: new Date(),
      })
    }
  }

  /**
   * Get aggregated slow queries, sorted by total impact
   */
  getSamples(limit: number = 20): SlowQuerySample[] {
    return Array.from(this.queries.values())
      .sort((a, b) => b.duration * b.count - a.duration * a.count)
      .slice(0, limit)
  }

  /**
   * Clear tracker (useful for tests)
   */
  clear(): void {
    this.queries.clear()
  }
}

// Global tracker instance
const slowQueryTracker = new SlowQueryTracker()

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
  const slowQueries = slowQueryTracker.getSamples(20)

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
 * Record slow query for monitoring
 * Call this from database query middleware
 * @param query - Query string (will be normalized)
 * @param durationMs - Query duration in milliseconds
 */
export function recordSlowQuery(query: string, durationMs: number): void {
  slowQueryTracker.recordQuery(query, durationMs)
}

/**
 * Reset slow query tracker
 * Useful for testing or starting fresh monitoring
 */
export function resetSlowQueryTracker(): void {
  slowQueryTracker.clear()
}

/**
 * Get active slow queries
 * @returns Array of slow query samples
 */
export function getSlowQueries(limit: number = 20): SlowQuerySample[] {
  return slowQueryTracker.getSamples(limit)
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

export { SlowQueryTracker, PoolMetrics, DBHealthMetrics, SlowQuerySample }

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
