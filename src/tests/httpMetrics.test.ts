import express from 'express'
import request from 'supertest'
import {
  httpMetricsMiddleware,
  httpMetricsRegister,
  __resetHttpMetricsForTests,
} from '../observability/httpMetrics.js'

describe('httpMetricsMiddleware', () => {
  beforeEach(() => {
    __resetHttpMetricsForTests()
  })

  it('does not record requests to /api/health', async () => {
    const app = express()
    app.use(httpMetricsMiddleware)
    app.get('/api/health', (_req, res) => {
      res.status(200).json({ ok: true })
    })

    await request(app).get('/api/health').expect(200)

    const metrics = await httpMetricsRegister.getMetricsAsJSON()
    const requestMetric = metrics.find((metric) => metric.name === 'http_requests_total')
    const healthEntries = requestMetric?.values.filter((value) => value.labels.path === '/api/health') ?? []

    expect(healthEntries).toHaveLength(0)
  })
})
