import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { initEnv, _resetEnvForTesting } from '../config/env.js'

// Set process.env variables needed at import time
process.env.DOWNLOAD_SECRET = 'my-super-secret-download-token-key-at-least-32-chars'
process.env.JWT_ACCESS_SECRET = 'my-super-secret-access-token-which-is-at-least-32-characters-long'

const MINIMAL_ENV = {
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'my-super-secret-access-token-which-is-at-least-32-characters-long',
  DOWNLOAD_SECRET: 'my-super-secret-download-token-key-at-least-32-chars',
}

_resetEnvForTesting()
initEnv({ ...MINIMAL_ENV })

// Dynamically import express, supertest and local files after env initialization
const express = (await import('express')).default
const request = (await import('supertest')).default
const { createHealthRouter } = await import('../routes/health.js')
const { generateAccessToken } = await import('../lib/auth-utils.js')
const { UserRole } = await import('../types/user.js')

// We need a dummy background job system
const mockJobSystem = {
  getMetrics: () => ({
    totals: { failed: 0 }
  })
} as any

describe('GET /api/health/security auth controls', () => {
  let app: any

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api/health', createHealthRouter(mockJobSystem))
  })

  it('rejects anonymous requests with 401', async () => {
    const res = await request(app).get('/api/health/security')
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('Missing or malformed Authorization header')
  })

  it('rejects regular users (USER role) with 403', async () => {
    const token = generateAccessToken({ userId: 'user-123', role: UserRole.USER })
    const res = await request(app)
      .get('/api/health/security')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('Forbidden')
  })

  it('rejects verifiers (VERIFIER role) with 403', async () => {
    const token = generateAccessToken({ userId: 'verifier-123', role: UserRole.VERIFIER })
    const res = await request(app)
      .get('/api/health/security')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('Forbidden')
  })

  it('allows admins (ADMIN role) and returns 200', async () => {
    const token = generateAccessToken({ userId: 'admin-123', role: UserRole.ADMIN })
    const res = await request(app)
      .get('/api/health/security')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('topSources')
  })
})
