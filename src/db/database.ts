import type { Pool } from 'pg'
import { subDays, subYears } from 'date-fns'
import { utcStartOfDay, utcEndOfDay } from '../utils/timestamps.js'
import { getPgPool } from './pool.js'

type AnalyticsStatsRow = {
  total_vaults: number
  active_vaults: number
  completed_vaults: number
  failed_vaults: number
  total_locked_capital: number | null
  active_capital: number | null
}

export type AnalyticsSummaryRow = {
  total_vaults: number
  active_vaults: number
  completed_vaults: number
  failed_vaults: number
  total_locked_capital: string
  active_capital: string
  success_rate: number
  last_updated: string
}

const analyticsStorage = (process.env.ANALYTICS_STORAGE ?? '').toLowerCase()
const shouldUsePostgres = analyticsStorage === 'postgres'

const getPool = (): Pool => getPgPool()

const initializePostgresSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_vault_summary (
      id SMALLINT PRIMARY KEY,
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      active_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      success_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analytics_vault_daily_rollups (
      bucket_date DATE PRIMARY KEY,
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      active_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      success_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_rollups_last_updated
    ON analytics_vault_daily_rollups(last_updated);
  `)
}

const writePostgresSummary = async (pool: Pool): Promise<void> => {
  const { rows } = await pool.query<AnalyticsStatsRow>(`
    SELECT
      COUNT(*)::int as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_vaults,
      SUM(CAST(amount AS numeric))::float as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::float as active_capital
    FROM vaults
  `)

  const stats = rows[0] ?? {
    total_vaults: 0, active_vaults: 0, completed_vaults: 0, failed_vaults: 0,
    total_locked_capital: 0, active_capital: 0,
  }
  const successRate = stats.completed_vaults + stats.failed_vaults > 0
    ? (stats.completed_vaults / (stats.completed_vaults + stats.failed_vaults)) * 100
    : 0

  await pool.query(
    `INSERT INTO analytics_vault_summary (
        id, total_vaults, active_vaults, completed_vaults, failed_vaults,
        total_locked_capital, active_capital, success_rate, last_updated
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET
        total_vaults = EXCLUDED.total_vaults,
        active_vaults = EXCLUDED.active_vaults,
        completed_vaults = EXCLUDED.completed_vaults,
        failed_vaults = EXCLUDED.failed_vaults,
        total_locked_capital = EXCLUDED.total_locked_capital,
        active_capital = EXCLUDED.active_capital,
        success_rate = EXCLUDED.success_rate,
        last_updated = NOW()`,
    [stats.total_vaults, stats.active_vaults, stats.completed_vaults, stats.failed_vaults,
     stats.total_locked_capital ?? 0, stats.active_capital ?? 0, successRate],
  )

  await pool.query(`
    INSERT INTO analytics_vault_daily_rollups (
      bucket_date, total_vaults, active_vaults, completed_vaults, failed_vaults,
      total_locked_capital, active_capital, success_rate, last_updated
    )
    SELECT
      DATE(created_at) as bucket_date,
      COUNT(*)::int,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int,
      SUM(CAST(amount AS numeric))::numeric(20,7),
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::numeric(20,7),
      CASE WHEN SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) = 0 THEN 0
        ELSE (SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::numeric
              / SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END)::numeric) * 100
      END,
      NOW()
    FROM vaults
    GROUP BY DATE(created_at)
    ON CONFLICT (bucket_date) DO UPDATE SET
      total_vaults = EXCLUDED.total_vaults,
      active_vaults = EXCLUDED.active_vaults,
      completed_vaults = EXCLUDED.completed_vaults,
      failed_vaults = EXCLUDED.failed_vaults,
      total_locked_capital = EXCLUDED.total_locked_capital,
      active_capital = EXCLUDED.active_capital,
      success_rate = EXCLUDED.success_rate,
      last_updated = NOW()
  `)
}

export function initializeDatabase(): void {
  const pool = getPool()
  void initializePostgresSchema(pool).catch((error) => {
    console.warn('PostgreSQL analytics schema initialization failed:', error)
  })
}

export function closeDatabase(): void {
  void getPool().end().catch(() => undefined)
}

export async function updateAnalyticsSummary(): Promise<void> {
  const pool = getPool()
  try {
    await writePostgresSummary(pool)
  } catch (error) {
    console.warn('PostgreSQL analytics summary update failed:', error)
  }
}

const mapSummary = (row: Record<string, unknown>): AnalyticsSummaryRow => ({
  total_vaults: Number(row.total_vaults ?? 0),
  active_vaults: Number(row.active_vaults ?? 0),
  completed_vaults: Number(row.completed_vaults ?? 0),
  failed_vaults: Number(row.failed_vaults ?? 0),
  total_locked_capital: String(row.total_locked_capital ?? '0'),
  active_capital: String(row.active_capital ?? '0'),
  success_rate: Number(row.success_rate ?? 0),
  last_updated: String(row.last_updated ?? new Date().toISOString()),
})

const emptyAnalyticsSummary = (): AnalyticsSummaryRow => ({
  total_vaults: 0, active_vaults: 0, completed_vaults: 0, failed_vaults: 0,
  total_locked_capital: '0', active_capital: '0', success_rate: 0,
  last_updated: new Date().toISOString(),
})

export async function readAnalyticsSummary(): Promise<AnalyticsSummaryRow> {
  if (!shouldUsePostgres) return emptyAnalyticsSummary()

  const pool = getPool()
  const { rows } = await pool.query<Record<string, unknown>>(`
    SELECT total_vaults, active_vaults, completed_vaults, failed_vaults,
      total_locked_capital::text, active_capital::text, success_rate::float, last_updated::text
    FROM analytics_vault_summary WHERE id = 1
  `)
  return rows[0] ? mapSummary(rows[0]) : emptyAnalyticsSummary()
}

export async function queryVaultStatsByPeriod(startDate: string, endDate: string): Promise<AnalyticsStatsRow> {
  const pool = getPool()
  const { rows } = await pool.query<AnalyticsStatsRow>(
    `SELECT COUNT(*)::int as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_vaults,
      SUM(CAST(amount AS numeric))::float as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::float as active_capital
    FROM vaults WHERE created_at >= $1 AND created_at <= $2`,
    [startDate, endDate],
  )
  return rows[0] ?? { total_vaults: 0, active_vaults: 0, completed_vaults: 0, failed_vaults: 0,
                      total_locked_capital: 0, active_capital: 0 }
}

export async function queryVaultStatusBreakdownByPeriod(
  startDate: string, endDate: string,
): Promise<Array<{ status: string; count: number }>> {
  const pool = getPool()
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text as count FROM vaults
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY status`,
    [startDate, endDate],
  )
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }))
}

export async function queryVaultStatusBreakdownAllTime(): Promise<Array<{ status: string; count: number }>> {
  const pool = getPool()
  const { rows } = await pool.query<{ status: string; count: string }>(
    'SELECT status, COUNT(*)::text as count FROM vaults GROUP BY status',
  )
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }))
}

export async function backfillAnalyticsStorage(): Promise<void> {
  const pool = getPool()
  await initializePostgresSchema(pool)
  await writePostgresSummary(pool)
}

export function getTimeRangeFilter(period: string): { startDate: string; endDate: string } {
  const now = new Date()
  const endDate = utcEndOfDay(now)
  let startDate: string

  switch (period) {
    case '7d':  startDate = utcStartOfDay(subDays(now, 7)); break
    case '30d': startDate = utcStartOfDay(subDays(now, 30)); break
    case '90d': startDate = utcStartOfDay(subDays(now, 90)); break
    case '1y':  startDate = utcStartOfDay(subYears(now, 1)); break
    default:    return { startDate: new Date(0).toISOString(), endDate }
  }

  return { startDate, endDate }
}
