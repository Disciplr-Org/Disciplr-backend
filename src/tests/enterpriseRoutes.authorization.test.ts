import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import enterpriseRoutes from '../routes/enterpriseRoutes.js'
import { UserRole } from '../types/user.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function buildApp() {
  const app = express()
  app.use(enterpriseRoutes)
  return app
}

function nonEnterpriseToken() {
  return jwt.sign(
    { userId: 'user-1', role: UserRole.USER, isEnterprise: false },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

function enterpriseTokenWithoutId() {
  return jwt.sign(
    { userId: 'user-1', role: UserRole.USER, isEnterprise: true },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

describe('enterprise vault routes authorization', () => {
  const protectedPaths = [
    '/vaults/vault-123',
    '/vaults/vault-123/milestones',
  ]

  test.each(protectedPaths)('rejects unauthenticated requests to %s', async (path) => {
    const response = await request(buildApp()).get(path)

    expect(response.status).toBe(401)
  })

  test.each(protectedPaths)('rejects non-enterprise users from %s', async (path) => {
    const response = await request(buildApp())
      .get(path)
      .set('Authorization', `Bearer ${nonEnterpriseToken()}`)

    expect(response.status).toBe(403)
    expect(response.body.error).toBe('Forbidden')
  })

  test.each(protectedPaths)('rejects enterprise users without an enterprise ID from %s', async (path) => {
    const response = await request(buildApp())
      .get(path)
      .set('Authorization', `Bearer ${enterpriseTokenWithoutId()}`)

    expect(response.status).toBe(403)
    expect(response.body.message).toBe('Enterprise configuration missing in auth context.')
  })
})
