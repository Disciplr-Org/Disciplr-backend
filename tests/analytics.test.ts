import { db, initializeDatabase, getTimeRangeFilter, updateAnalyticsSummary } from '../src/db/database.js'
import {
    getOverallAnalytics,
    getAnalyticsByPeriod,
    getVaultStatusBreakdown,
    getCapitalAnalytics,
} from '../src/services/analytics.service.js'

describe('Analytics Service', () => {
    beforeAll(() => {
        // Use test database
        initializeDatabase()
    })

    beforeEach(() => {
        // Clear vaults table before each test
        db.prepare('DELETE FROM vaults').run()
        db.prepare('DELETE FROM vault_analytics_summary').run()
        db.prepare(`
      INSERT INTO vault_analytics_summary (id, total_vaults, active_vaults, completed_vaults, failed_vaults, total_locked_capital, active_capital, success_rate, last_updated)
      VALUES (1, 0, 0, 0, 0, '0', '0', 0, datetime('now'))
    `).run()
    })

    afterAll(() => {
        db.close()
    })

    describe('getTimeRangeFilter', () => {
        it('should return correct date range for 7d', () => {
            const { startDate, endDate } = getTimeRangeFilter('7d')
            const start = new Date(startDate)
            const end = new Date(endDate)
            const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
            expect(diffDays).toBeCloseTo(7, 0)
        })

        it('should return correct date range for 30d', () => {
            const { startDate, endDate } = getTimeRangeFilter('30d')
            const start = new Date(startDate)
            const end = new Date(endDate)
            const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
            expect(diffDays).toBeCloseTo(30, 0)
        })

        it('should return correct date range for 90d', () => {
            const { startDate, endDate } = getTimeRangeFilter('90d')
            const start = new Date(startDate)
            const end = new Date(endDate)
            const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
            expect(diffDays).toBeCloseTo(90, 0)
        })

        it('should return correct date range for 1y', () => {
            const { startDate, endDate } = getTimeRangeFilter('1y')
            const start = new Date(startDate)
            const end = new Date(endDate)
            const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
            expect(diffDays).toBeCloseTo(365, 0)
        })

        it('should return epoch start for unknown period', () => {
            const { startDate } = getTimeRangeFilter('unknown')
            expect(startDate).toBe(new Date(0).toISOString())
        })
    })

    describe('getOverallAnalytics', () => {
        it('should return zero analytics when no vaults exist', () => {
            const analytics = getOverallAnalytics()
            expect(analytics.totalVaults).toBe(0)
            expect(analytics.activeVaults).toBe(0)
            expect(analytics.completedVaults).toBe(0)
            expect(analytics.failedVaults).toBe(0)
            expect(analytics.totalLockedCapital).toBe('0')
            expect(analytics.activeCapital).toBe('0')
            expect(analytics.successRate).toBe(0)
        })

        it('should return correct analytics with vaults', () => {
            // Insert test vaults
            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-1', 'user1', '1000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-2', 'user2', '2000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-3', 'user3', '3000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            updateAnalyticsSummary()

            const analytics = getOverallAnalytics()
            expect(analytics.totalVaults).toBe(3)
            expect(analytics.activeVaults).toBe(1)
            expect(analytics.completedVaults).toBe(1)
            expect(analytics.failedVaults).toBe(1)
            expect(analytics.totalLockedCapital).toBe('6000')
            expect(analytics.activeCapital).toBe('1000')
            expect(analytics.successRate).toBe(50)
        })
    })

    describe('getAnalyticsByPeriod', () => {
        it('should filter vaults by time period', () => {
            // Insert vault from 15 days ago
            const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-old', 'user1', '1000', fifteenDaysAgo, '2026-12-31T00:00:00Z', '0xA', '0xB', 'completed', fifteenDaysAgo, fifteenDaysAgo)

            // Insert vault from today
            const today = new Date().toISOString()
            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-new', 'user2', '2000', today, '2026-12-31T00:00:00Z', '0xA', '0xB', 'active', today, today)

            // 30d should include both
            const analytics30d = getAnalyticsByPeriod('30d')
            expect(analytics30d.totalVaults).toBe(2)

            // 7d should only include the new vault
            const analytics7d = getAnalyticsByPeriod('7d')
            expect(analytics7d.totalVaults).toBe(1)
        })
    })

    describe('getVaultStatusBreakdown', () => {
        it('should return correct status breakdown', () => {
            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-1', 'user1', '1000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-2', 'user2', '2000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            const breakdown = getVaultStatusBreakdown()
            expect(breakdown.byStatus.active).toBe(1)
            expect(breakdown.byStatus.completed).toBe(1)
        })
    })

    describe('getCapitalAnalytics', () => {
        it('should return correct capital analytics', () => {
            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-1', 'user1', '1000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            db.prepare(`
        INSERT INTO vaults (id, creator, amount, start_timestamp, end_timestamp, success_destination, failure_destination, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('vault-2', 'user2', '2000', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', '0xA', '0xB', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

            const capital = getCapitalAnalytics('all')
            expect(capital.totalLockedCapital).toBe('3000')
            expect(capital.activeCapital).toBe('1000')
            expect(capital.averageVaultSize).toBe('1500.00')
        })
    })
})
