jest.mock('../lib/prisma.js', () => ({
  prisma: {
    vault: {
      findMany: jest.fn(async () => [
        {
          id: 'vault-1',
          creatorId: 'user-1',
          creator: { id: 'user-1' },
        },
      ]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  },
}), { virtual: true })

jest.mock('../utils/timestamps.js', () => ({
  utcNow: jest.fn(() => '2026-04-24T00:00:00.000Z'),
}), { virtual: true })

jest.mock('../middleware/auth.js', () => ({
  authenticate: (req, res, next) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = { userId: 'user-1', role: 'USER' }
    next()
  },
}), { virtual: true })

const request = require('supertest')
const express = require('express')
const { privacyRouter } = require('../routes/privacy.ts')

const app = express()
app.use(express.json())
app.use('/api/privacy', privacyRouter)

const auth = { Authorization: 'Bearer test-token' }

describe('Privacy API contract tests', () => {
  test('requires authentication for export', async () => {
    const res = await request(app)
      .get('/api/privacy/export')
      .query({ creator: 'user-1' })

    expect(res.status).toBe(401)
  })

  test('returns 400 if creator is missing (export)', async () => {
    const res = await request(app)
      .get('/api/privacy/export')
      .set(auth)

    expect(res.status).toBe(400)
  })

  test('returns export data shape', async () => {
    const res = await request(app)
      .get('/api/privacy/export')
      .set(auth)
      .query({ creator: 'user-1' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('creator', 'user-1')
    expect(res.body).toHaveProperty('exportDate')
    expect(res.body.data).toHaveProperty('vaults')
  })

  test('does not leak PII fields in export response', async () => {
    const res = await request(app)
      .get('/api/privacy/export')
      .set(auth)
      .query({ creator: 'user-1' })

    const bodyText = JSON.stringify(res.body)

    expect(bodyText).not.toContain('user@example.com')
    expect(bodyText).not.toContain('email')
    expect(bodyText).not.toContain('password')
    expect(bodyText).not.toContain('token')
    expect(res.body.data.vaults[0].creator).not.toHaveProperty('email')
  })

  test('requires authentication for account deletion', async () => {
    const res = await request(app)
      .delete('/api/privacy/account')
      .query({ creator: 'user-1' })

    expect(res.status).toBe(401)
  })

  test('returns 400 if creator is missing (delete)', async () => {
    const res = await request(app)
      .delete('/api/privacy/account')
      .set(auth)

    expect(res.status).toBe(400)
  })

  test('deletes account data successfully', async () => {
    const res = await request(app)
      .delete('/api/privacy/account')
      .set(auth)
      .query({ creator: 'user-1' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      deletedCount: 1,
      status: 'success',
    })
    expect(JSON.stringify(res.body)).not.toContain('user-1 has been deleted')
  })
})