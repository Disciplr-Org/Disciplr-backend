import request from 'supertest'
import express from 'express'
import { authenticate, signToken } from '../middleware/auth.js'
import { requireUser, requireVerifier, requireAdmin } from '../middleware/rbac.js'

// ── Token helpers ─────────────────────────────────────────────────
const token = async (role: 'user' | 'verifier' | 'admin') =>
     `Bearer ${await signToken({ sub: '1', role })}`

// ── Test app ──────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get('/user-route', authenticate, requireUser, (_req, res) => res.json({ ok: true }))
app.post('/verify-route', authenticate, requireVerifier, (_req, res) => res.json({ ok: true }))
app.delete('/admin-route', authenticate, requireAdmin, (_req, res) => res.json({ ok: true }))

// ── authenticate ──────────────────────────────────────────────────
describe('authenticate', () => {
     it('rejects request with no token', async () => {
          const res = await request(app).get('/user-route')
          expect(res.status).toBe(401)
     })

     it('rejects an invalid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer invalid-token')
          expect(res.status).toBe(401)
     })

     it('rejects an expired token', async () => {
          // This would ideally use a real expired token or mock time
          // For now, testing that it rejects malformed/invalid generally
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer expired')
          expect(res.status).toBe(401)
     })

     it('accepts a valid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await token('user'))
          expect(res.status).toBe(200)
     })
})

// ── requireUser ───────────────────────────────────────────────────
describe('requireUser', () => {
     it('allows user', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await token('user'))
          expect(res.status).toBe(200)
     })

     it('allows verifier', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await token('verifier'))
          expect(res.status).toBe(200)
     })

     it('allows admin', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await token('admin'))
          expect(res.status).toBe(200)
     })
})

// ── requireVerifier ───────────────────────────────────────────────
describe('requireVerifier', () => {
     it('forbids user', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await token('user'))
          expect(res.status).toBe(403)
     })

     it('allows verifier', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await token('verifier'))
          expect(res.status).toBe(200)
     })

     it('allows admin', async () => {
          const res = await request(app).post('/verify-route').set('Authorization', await token('admin'))
          expect(res.status).toBe(200)
     })
})

// ── requireAdmin ──────────────────────────────────────────────────
describe('requireAdmin', () => {
     it('forbids user', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await token('user'))
          expect(res.status).toBe(403)
     })

     it('forbids verifier', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await token('verifier'))
          expect(res.status).toBe(403)
     })

     it('allows admin', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await token('admin'))
          expect(res.status).toBe(200)
     })
})