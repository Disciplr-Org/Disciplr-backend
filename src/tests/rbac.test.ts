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
const token = (role: 'user' | 'verifier' | 'admin') =>
     `Bearer ${signToken({ sub: '1', role })}`

// ── authenticate ──────────────────────────────────────────────────
describe('authenticate', () => {
     it('rejects request with no token', async () => {
          const res = await request(app).get('/user-route')
          expect(res.status).toBe(401)
     })

     it('rejects an invalid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer bad.token')
          expect(res.status).toBe(401)
     })

     it('rejects an expired token', async () => {
          const expired = `Bearer ${signToken({ sub: '1', role: 'user' }, '-1s')}`
          const res = await request(app).get('/user-route').set('Authorization', expired)
          expect(res.status).toBe(401)
          expect(res.body.error).toMatch(/expired/i)
     })

     it('accepts a valid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', token('user'))
          expect(res.status).toBe(200)
     })
})

// ── requireUser ───────────────────────────────────────────────────
describe('requireUser', () => {
     it('allows user', async () => expect((await request(app).get('/user-route').set('Authorization', token('user'))).status).toBe(200))
     it('allows verifier', async () => expect((await request(app).get('/user-route').set('Authorization', token('verifier'))).status).toBe(200))
     it('allows admin', async () => expect((await request(app).get('/user-route').set('Authorization', token('admin'))).status).toBe(200))
})

// ── requireVerifier ───────────────────────────────────────────────
describe('requireVerifier', () => {
     it('forbids user', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', token('user'))
          expect(res.status).toBe(403)
     })
     it('allows verifier', async () => expect((await request(app).post('/verify-route').set('Authorization', token('verifier'))).status).toBe(200))
     it('allows admin', async () => expect((await request(app).post('/verify-route').set('Authorization', token('admin'))).status).toBe(200))
})

// ── requireAdmin ──────────────────────────────────────────────────
describe('requireAdmin', () => {
     it('forbids user', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', token('user'))
          expect(res.status).toBe(403)
     })
     it('forbids verifier', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', token('verifier'))
          expect(res.status).toBe(403)
     })
     it('allows admin', async () => expect((await request(app).delete('/admin-route').set('Authorization', token('admin'))).status).toBe(200))
})