import { describe, it, expect, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const metricsAuth = jest.fn<any>((_req: any, res: any) => {
  res.status(204).end()
})
const authenticate = jest.fn<any>((_req: any, res: any) => {
  res.status(418).end()
})
const requireAdmin = jest.fn<any>((_req: any, res: any) => {
  res.status(403).end()
})

jest.unstable_mockModule('../middleware/metricsAuth.js', () => ({ metricsAuth }))
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate,
  csrfProtection: jest.fn<any>((_req: any, _res: any, next: any) => next()),
}))
jest.unstable_mockModule('../middleware/rbac.js', () => ({ requireAdmin }))
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  metricsRateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
}))
jest.unstable_mockModule('../observability/httpMetrics.js', () => ({
  httpMetricsMiddleware: jest.fn<any>((_req: any, _res: any, next: any) => next()),
}))
jest.unstable_mockModule('../observability/tracingMiddleware.js', () => ({
  tracingMiddleware: jest.fn<any>((_req: any, _res: any, next: any) => next()),
}))
jest.unstable_mockModule('../middleware/privacy-logger.js', () => ({
  privacyLogger: jest.fn<any>((_req: any, _res: any, next: any) => next()),
}))
jest.unstable_mockModule('../routes/admin.js', () => ({ adminRouter: express.Router() }))
jest.unstable_mockModule('../routes/notifications.js', () => ({ notificationsRouter: express.Router() }))
jest.unstable_mockModule('../routes/metrics.js', () => ({ metricsRouter: express.Router() }))
jest.unstable_mockModule('../routes/webhooks.js', () => ({ default: express.Router() }))
jest.unstable_mockModule('../middleware/errorHandler.js', () => ({
  errorHandler: jest.fn<any>((_err: any, _req: any, res: any, _next: any) => {
    res.status(500).end()
  }),
}))

const { app } = await import('../app.js')

describe('metrics route authentication', () => {
  it('uses scraper authentication instead of user JWT/admin guards', async () => {
    const response = await request(app).get('/api/metrics')

    expect(response.status).toBe(204)
    expect(metricsAuth).toHaveBeenCalledTimes(1)
    expect(authenticate).not.toHaveBeenCalled()
    expect(requireAdmin).not.toHaveBeenCalled()
  })
})
