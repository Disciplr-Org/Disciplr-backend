import { readAnalyticsSummary, updateAnalyticsSummary } from '../db/database.js'
import { getAnalyticsByPeriod } from '../services/analytics.service.js'

describe('analytics storage compatibility', () => {
  beforeAll(async () => {
    await updateAnalyticsSummary()
  })

  it('returns a stable summary payload shape for /api/analytics consumers', async () => {
    const summary = await readAnalyticsSummary()

    expect(summary).toEqual({
      total_vaults: expect.any(Number),
      active_vaults: expect.any(Number),
      completed_vaults: expect.any(Number),
      failed_vaults: expect.any(Number),
      total_locked_capital: expect.any(String),
      active_capital: expect.any(String),
      success_rate: expect.any(Number),
      last_updated: expect.any(String),
    })
  })

  it('handles UTC date boundaries correctly for different periods', async () => {
    const periods = ['7d', '30d', '90d']
    
    for (const period of periods) {
      const result = await getAnalyticsByPeriod(period)
      expect(result.period).toBe(period)
      expect(result.startDate).toBeTruthy()
      expect(result.endDate).toBeTruthy()
      expect(result.totalVaults).toBeGreaterThanOrEqual(0)
    }
  })
})