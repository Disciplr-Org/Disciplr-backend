import request from 'supertest'
import { app } from '../app.js'

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const response = await request(app).get('/api/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'disciplr-backend',
    })
    expect(response.body.timestamp).toBeDefined()
  })
})

describe('GET /api/health/security', () => {
  it('returns security metrics', async () => {
    const response = await request(app).get('/api/health/security')

    expect(response.status).toBe(200)
    expect(response.body).toBeDefined()
  })
})
