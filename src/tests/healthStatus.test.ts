import { afterEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const mockBuildDeepHealthStatus = jest.fn<any>()

jest.unstable_mockModule('../services/healthService.js', () => ({
  healthService: {
    buildDeepHealthStatus: mockBuildDeepHealthStatus,
    buildHealthStatus: jest.fn(),
  },
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn((_req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}))

const { createHealthRouter } = await import('../routes/health.js')

const mockJobSystem = {
  getMetrics: () => ({
    running: true,
    queueDepth: 0,
    activeJobs: 0,
    totals: { enqueued: 0, completed: 0, failed: 0 },
  }),
} as any

const buildApp = () => {
  const app = express()
  app.use('/api/health', createHealthRouter(mockJobSystem))
  return app
}

describe('deep health HTTP status', () => {
  afterEach(() => {
    mockBuildDeepHealthStatus.mockReset()
  })

  it.each(['/api/health?deep=1', '/api/health/deep'])(
    'returns 207 for a degraded response from %s',
    async (path) => {
      mockBuildDeepHealthStatus.mockResolvedValue({ status: 'degraded' })

      const response = await request(buildApp()).get(path)

      expect(response.status).toBe(207)
      expect(response.body.status).toBe('degraded')
    },
  )

  it.each([
    ['/api/health?deep=1', 'ok', 200],
    ['/api/health?deep=1', 'error', 503],
    ['/api/health/deep', 'ok', 200],
    ['/api/health/deep', 'error', 503],
  ])('maps %s with status %s to HTTP %i', async (path, status, expectedStatus) => {
    mockBuildDeepHealthStatus.mockResolvedValue({ status })

    const response = await request(buildApp()).get(path)

    expect(response.status).toBe(expectedStatus)
  })
})
