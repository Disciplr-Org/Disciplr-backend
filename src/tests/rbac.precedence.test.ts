import { describe, it, expect } from '@jest/globals'
import request from 'supertest'
import { bootstrapApp } from '../app-bootstrap.js'
import { TEST_TOKENS, INVALID_TOKENS } from './helpers/rbacTestUtils.js'

const { app } = bootstrapApp()

// Helper to check standard error response envelope
function checkErrorEnvelope(res: request.Response, expectedStatus: number, expectedSubstring: string) {
  expect(res.status).toBe(expectedStatus)
  expect(res.body).toHaveProperty('error')
  
  // Extract error message string (handling both raw JSON and AppError formats)
  const errorObj = res.body.error
  const message = typeof errorObj === 'string' ? errorObj : errorObj?.message
  expect(typeof message).toBe('string')
  expect(message.toLowerCase()).toContain(expectedSubstring.toLowerCase())
}

describe('RBAC Authentication and Authorization Precedence (Requirement 5 & 6)', () => {
  // Test endpoints requiring Admin privileges
  const adminEndpoints = [
    { method: 'get', path: '/api/admin/users' },
    { method: 'get', path: '/api/admin/verifiers' },
    { method: 'get', path: '/api/verifications' },
    { method: 'post', path: '/api/exports/admin' },
    { method: 'post', path: '/api/auth/users/33333333-3333-3333-3333-333333333333/role' }
  ] as const

  // Test endpoints requiring Verifier privileges
  const verifierEndpoints = [
    { method: 'post', path: '/api/verifications' }
  ] as const

  describe('Unauthenticated requests (Requirements 5.1 - 5.4 & 6.1)', () => {
    adminEndpoints.forEach(({ method, path }) => {
      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when no token is provided`, async () => {
        const res = await (request(app) as any)[method](path)
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })

      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when Bearer prefix is malformed`, async () => {
        const res = await (request(app) as any)[method](path)
          .set('Authorization', 'BearerNoSpaceToken')
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })

      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when token is malformed`, async () => {
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${INVALID_TOKENS.malformed()}`)
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })

      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when token is expired`, async () => {
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${INVALID_TOKENS.expired()}`)
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })

      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when token has wrong secret`, async () => {
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${INVALID_TOKENS.wrongSecret()}`)
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })
    })

    verifierEndpoints.forEach(({ method, path }) => {
      it(`[${method.toUpperCase()} ${path}] - should return 401 (never 403) with Unauthorized message when no token is provided`, async () => {
        const res = await (request(app) as any)[method](path)
        checkErrorEnvelope(res, 401, 'Unauthorized')
      })
    })
  })

  describe('Authenticated requests with insufficient role (Requirements 5.5 & 6.2)', () => {
    adminEndpoints.forEach(({ method, path }) => {
      it(`[${method.toUpperCase()} ${path}] - should return 403 with Forbidden message for USER role`, async () => {
        const token = TEST_TOKENS.user()
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${token}`)
        checkErrorEnvelope(res, 403, 'Forbidden')
      })

      it(`[${method.toUpperCase()} ${path}] - should return 403 with Forbidden message for VERIFIER role`, async () => {
        const token = TEST_TOKENS.verifier()
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${token}`)
        checkErrorEnvelope(res, 403, 'Forbidden')
      })
    })

    verifierEndpoints.forEach(({ method, path }) => {
      it(`[${method.toUpperCase()} ${path}] - should return 403 with Forbidden message for USER role`, async () => {
        const token = TEST_TOKENS.user()
        const res = await (request(app) as any)[method](path)
          .set('Authorization', `Bearer ${token}`)
        checkErrorEnvelope(res, 403, 'Forbidden')
      })
    })
  })

  describe('OPTIONS CORS preflight requests (CORS pass-through)', () => {
    adminEndpoints.forEach(({ path }) => {
      it(`[OPTIONS ${path}] - should pass through CORS preflight without authentication checks`, async () => {
        const res = await request(app)
          .options(path)
          .set('Origin', 'http://localhost:3000')
          .set('Access-Control-Request-Method', 'GET')
        
        expect(res.status).toBe(204)
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
      })
    })
  })
})
