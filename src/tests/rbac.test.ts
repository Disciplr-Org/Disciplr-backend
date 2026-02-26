import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserRole } from '../types/domain.js'
import request from 'supertest'
import express from 'express'
import { authenticate, signToken } from '../middleware/auth.js'
import { requireUser, requireVerifier, requireAdmin } from '../middleware/rbac.js'

// ── Test app ──────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get('/user-route', authenticate, requireUser, (_req, res) => res.json({ ok: true }))
app.post('/verify-route', authenticate, requireVerifier, (_req, res) => res.json({ ok: true }))
app.delete('/admin-route', authenticate, requireAdmin, (_req, res) => res.json({ ok: true }))

// ── Token helpers ─────────────────────────────────────────────────
const token = (role: 'user' | 'verifier' | 'admin') => {
     const roleMap: Record<string, UserRole> = {
          user: UserRole.USER,
          verifier: UserRole.VERIFIER,
          admin: UserRole.ADMIN,
     }
     return `Bearer ${signToken({ userId: '1', role: roleMap[role] })}`
}

// ── authenticate ──────────────────────────────────────────────────
describe('authenticate', () => {
     it('rejects request with no token', async () => {
          const res = await request(app).get('/user-route')
          assert.strictEqual(res.status, 401)
     })

     it('rejects an invalid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer bad.token')
          assert.strictEqual(res.status, 401)
     })

     it('rejects an expired token', async () => {
          const expired = `Bearer ${signToken({ userId: '1', role: UserRole.USER }, '-1s')}`
          const res = await request(app).get('/user-route').set('Authorization', expired)
          assert.strictEqual(res.status, 401)
          assert.match(res.body.error, /expired/i)
     })

     it('accepts a valid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', token('user'))
          assert.strictEqual(res.status, 200)
     })
})

// ── requireUser ───────────────────────────────────────────────────
describe('requireUser', () => {
     it('allows user', async () => assert.strictEqual((await request(app).get('/user-route').set('Authorization', token('user'))).status, 200))
     it('allows verifier', async () => assert.strictEqual((await request(app).get('/user-route').set('Authorization', token('verifier'))).status, 200))
     it('allows admin', async () => assert.strictEqual((await request(app).get('/user-route').set('Authorization', token('admin'))).status, 200))
})

// ── requireVerifier ───────────────────────────────────────────────
describe('requireVerifier', () => {
     it('forbids user', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', token('user'))
          assert.strictEqual(res.status, 403)
     })
     it('allows verifier', async () => assert.strictEqual((await request(app).post('/verify-route').set('Authorization', token('verifier'))).status, 200))
     it('allows admin', async () => assert.strictEqual((await request(app).post('/verify-route').set('Authorization', token('admin'))).status, 200))
})

// ── requireAdmin ──────────────────────────────────────────────────
describe('requireAdmin', () => {
     it('forbids user', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', token('user'))
          assert.strictEqual(res.status, 403)
     })
     it('forbids verifier', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', token('verifier'))
          assert.strictEqual(res.status, 403)
     })
     it('allows admin', async () => assert.strictEqual((await request(app).delete('/admin-route').set('Authorization', token('admin'))).status, 200))
})