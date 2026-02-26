import request from 'supertest'
import { app } from '../app.js'
import { setVaults } from '../routes/vaults.js'

// Reset in-memory store between tests
beforeEach(() => setVaults([]))

// Helper: a future timestamp (1 year from now) in various formats
const futureUTC = () => {
  const d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  return d.toISOString()
}

const futureWithOffset = () => {
  const d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  // Express as +05:30 offset
  const shifted = new Date(d.getTime() + 5.5 * 60 * 60 * 1000)
  const iso = shifted.toISOString().replace('Z', '+05:30')
  return iso
}

const baseBody = (endTimestamp: string) => ({
  creator: 'GA1234',
  amount: '1000',
  endTimestamp,
  successDestination: 'GA_SUCCESS',
  failureDestination: 'GA_FAILURE',
})

describe('POST /api/vaults — timestamp validation', () => {
  it('accepts a valid UTC endTimestamp and returns 201', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .send(baseBody(futureUTC()))

    expect(res.status).toBe(201)
    expect(res.body.endTimestamp).toMatch(/Z$/)
    expect(res.body.startTimestamp).toMatch(/Z$/)
    expect(res.body.createdAt).toMatch(/Z$/)
  })

  it('normalizes an offset endTimestamp to UTC (Z)', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .send(baseBody(futureWithOffset()))

    expect(res.status).toBe(201)
    expect(res.body.endTimestamp).toMatch(/Z$/)
    expect(res.body.endTimestamp).not.toContain('+')
  })

  it('rejects endTimestamp without timezone → 400', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .send(baseBody('2099-06-15T12:00:00'))

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ISO 8601/)
  })

  it('rejects non-ISO text → 400', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .send(baseBody('next tuesday'))

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/ISO 8601/)
  })

  it('rejects a past endTimestamp → 400', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .send(baseBody('2020-01-01T00:00:00Z'))

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/future/)
  })
})

describe('GET /api/vaults — response format', () => {
  it('returns timestamps ending in Z', async () => {
    // Create a vault first
    await request(app)
      .post('/api/vaults')
      .send(baseBody(futureUTC()))

    const res = await request(app).get('/api/vaults')
    expect(res.status).toBe(200)

    const vault = res.body.data[0]
    expect(vault.startTimestamp).toMatch(/Z$/)
    expect(vault.endTimestamp).toMatch(/Z$/)
    expect(vault.createdAt).toMatch(/Z$/)
  })
})

describe('X-Timezone header', () => {
  it('includes X-Timezone: UTC on all responses', async () => {
    const res = await request(app).get('/api/health')
    expect(res.headers['x-timezone']).toBe('UTC')
  })
})
