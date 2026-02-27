import Database, { Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dbPath = path.join(__dirname, '../../data/disciplr.db')

// Ensure data directory exists
const dataDir = path.dirname(dbPath)
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
}

export const db: DatabaseType = new Database(dbPath)

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL')

// Initialize database schema
export function initializeDatabase(): void {
    // Create vaults table
    db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      amount TEXT NOT NULL,
      start_timestamp TEXT NOT NULL,
      end_timestamp TEXT NOT NULL,
      success_destination TEXT NOT NULL,
      failure_destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

    // Create indexes for efficient queries
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vaults_status ON vaults(status);
    CREATE INDEX IF NOT EXISTS idx_vaults_created_at ON vaults(created_at);
    CREATE INDEX IF NOT EXISTS idx_vaults_start_timestamp ON vaults(start_timestamp);
    CREATE INDEX IF NOT EXISTS idx_vaults_status_created_at ON vaults(status, created_at);
  `)

    // Create materialized view for vault analytics summary
    db.exec(`
    CREATE TABLE IF NOT EXISTS vault_analytics_summary (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital TEXT NOT NULL DEFAULT '0',
      active_capital TEXT NOT NULL DEFAULT '0',
      success_rate REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL
    )
  `)

    // Initialize summary if not exists
    const summary = db.prepare('SELECT * FROM vault_analytics_summary WHERE id = 1').get()
    if (!summary) {
        db.prepare(`
      INSERT INTO vault_analytics_summary (id, total_vaults, active_vaults, completed_vaults, failed_vaults, total_locked_capital, active_capital, success_rate, last_updated)
      VALUES (1, 0, 0, 0, 0, '0', '0', 0, datetime('now'))
    `).run()
    }

    console.log('Database initialized successfully')
}

// Function to update analytics summary (can be called after vault changes)
export function updateAnalyticsSummary(): void {
    const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_vaults,
      SUM(CAST(amount AS REAL)) as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS REAL) ELSE 0 END) as active_capital
    FROM vaults
  `).get() as {
        total_vaults: number
        active_vaults: number
        completed_vaults: number
        failed_vaults: number
        total_locked_capital: number | null
        active_capital: number | null
    }

    const totalCompleted = stats.completed_vaults || 0
    const totalFailed = stats.failed_vaults || 0
    const successRate = (totalCompleted + totalFailed) > 0
        ? (totalCompleted / (totalCompleted + totalFailed)) * 100
        : 0

    db.prepare(`
    UPDATE vault_analytics_summary SET
      total_vaults = ?,
      active_vaults = ?,
      completed_vaults = ?,
      failed_vaults = ?,
      total_locked_capital = ?,
      active_capital = ?,
      success_rate = ?,
      last_updated = datetime('now')
    WHERE id = 1
  `).run(
        stats.total_vaults || 0,
        stats.active_vaults || 0,
        stats.completed_vaults || 0,
        stats.failed_vaults || 0,
        (stats.total_locked_capital || 0).toString(),
        (stats.active_capital || 0).toString(),
        successRate
    )
}

// Helper function to get time-range filter
export function getTimeRangeFilter(period: string): { startDate: string; endDate: string } {
    const endDate = new Date().toISOString()
    let startDate: string

    switch (period) {
        case '7d':
            startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
            break
        case '30d':
            startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
            break
        case '90d':
            startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
            break
        case '1y':
            startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
            break
        default:
            // Default to all time
            startDate = new Date(0).toISOString()
    }

    return { startDate, endDate }
}
