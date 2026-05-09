import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { authenticate, requireAdmin } from '../middleware/auth.js'
import { createAuditLog, clearAuditLogs, listAuditLogs, getAuditLogById } from '../lib/audit-logs.js'

const SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

// No jti → bypasses session validation in authenticate middleware
const adminToken = jwt.sign({ userId: 'admin-1', role: 'ADMIN' }, SECRET)
const userToken = jwt.sign({ userId: 'user-1', role: 'USER' }, SECRET)

const AUTH = (token: string) => ({ Authorization: `Bearer ${token}` })

// Minimal test app replicating only the audit-log routes from admin.ts
const testApp = express()
testApp.use(express.json())
testApp.use(authenticate)
testApp.use(requireAdmin)

const getStringQuery = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

testApp.get('/api/admin/audit-logs', async (req, res) => {
  try {
    const limit = getStringQuery(req.query.limit) ? Number(getStringQuery(req.query.limit)) : undefined
    const offset = getStringQuery(req.query.offset) ? Number(getStringQuery(req.query.offset)) : undefined
    
    const logs = await listAuditLogs({
      actor_user_id: getStringQuery(req.query.actor_user_id),
      action: getStringQuery(req.query.action),
      target_type: getStringQuery(req.query.target_type),
      target_id: getStringQuery(req.query.target_id),
      limit,
      offset,
    })
    
    res.status(200).json({ 
      audit_logs: logs, 
      count: logs.length,
      total: logs.length, // Simplified for tests
      limit,
      offset: offset || 0,
      has_more: false // Simplified for tests
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit logs' })
  }
})

testApp.get('/api/admin/audit-logs/:id', async (req, res) => {
  try {
    const log = await getAuditLogById(req.params.id)
    if (!log) {
      res.status(404).json({ error: 'Audit log not found' })
      return
    }
    res.status(200).json(log)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit log' })
  }
})

// Seed helper
const seed = async (overrides: Partial<Parameters<typeof createAuditLog>[0]> = {}) =>
  await createAuditLog({
    actor_user_id: 'admin-1',
    action: 'auth.login',
    target_type: 'user',
    target_id: 'user-1',
    metadata: { source: 'test' },
    ...overrides,
  })

describe('GET /api/admin/audit-logs', () => {
  beforeEach(async () => await clearAuditLogs())

  // --- Auth ---
  it('returns 401 with no token', async () => {
    const res = await request(testApp).get('/api/admin/audit-logs')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin role', async () => {
    const res = await request(testApp).get('/api/admin/audit-logs').set(AUTH(userToken))
    expect(res.status).toBe(403)
  })

  // --- Success shape ---
  it('returns empty list when no logs exist', async () => {
    const res = await request(testApp).get('/api/admin/audit-logs').set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ audit_logs: [], count: 0 })
  })

  it('returns all logs with correct shape', async () => {
    const log = await seed()
    const res = await request(testApp).get('/api/admin/audit-logs').set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.audit_logs).toHaveLength(1)
    expect(res.body.audit_logs[0]).toMatchObject({
      id: log.id,
      actor_user_id: 'admin-1',
      action: 'auth.login',
      target_type: 'user',
      target_id: 'user-1',
    })
    expect(typeof res.body.audit_logs[0].created_at).toBe('string')
  })

  // --- Sorting ---
  it('returns logs sorted by created_at descending', async () => {
    await seed({ action: 'auth.login' })
    await seed({ action: 'vault.created' })
    await seed({ action: 'vault.cancelled' })

    const res = await request(testApp).get('/api/admin/audit-logs').set(AUTH(adminToken))
    expect(res.status).toBe(200)
    const timestamps = res.body.audit_logs.map((l: { created_at: string }) => l.created_at)
    const sorted = [...timestamps].sort((a, b) => b.localeCompare(a))
    expect(timestamps).toEqual(sorted)
  })

  // --- Filtering ---
  it('filters by actor_user_id', async () => {
    await seed({ actor_user_id: 'admin-1' })
    await seed({ actor_user_id: 'admin-2' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?actor_user_id=admin-1')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.audit_logs[0].actor_user_id).toBe('admin-1')
  })

  it('filters by action', async () => {
    await seed({ action: 'auth.login' })
    await seed({ action: 'auth.role_changed' })
    await seed({ action: 'vault.created' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?action=auth.login')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.audit_logs[0].action).toBe('auth.login')
  })

  it('filters by target_type', async () => {
    await seed({ target_type: 'user' })
    await seed({ target_type: 'vault' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?target_type=vault')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.audit_logs[0].target_type).toBe('vault')
  })

  it('filters by target_id', async () => {
    await seed({ target_id: 'vault-abc' })
    await seed({ target_id: 'vault-xyz' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?target_id=vault-abc')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.audit_logs[0].target_id).toBe('vault-abc')
  })

  it('returns empty list when filter matches nothing', async () => {
    await seed({ action: 'auth.login' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?action=nonexistent.action')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ audit_logs: [], count: 0 })
  })

  // --- Limit ---
  it('respects limit parameter', async () => {
    await seed({ action: 'auth.login' })
    await seed({ action: 'vault.created' })
    await seed({ action: 'vault.cancelled' })

    const res = await request(testApp)
      .get('/api/admin/audit-logs?limit=2')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.audit_logs).toHaveLength(2)
    expect(res.body.count).toBe(2)
  })

  it('returns all logs when limit exceeds total', async () => {
    seed()
    seed()

    const res = await request(testApp)
      .get('/api/admin/audit-logs?limit=100')
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.audit_logs).toHaveLength(2)
  })

  // --- Multiple fixture actions ---
  it('returns logs for all audited action types', async () => {
    const actions = ['auth.login', 'auth.role_changed', 'vault.created', 'vault.cancelled', 'admin.override']
    await Promise.all(actions.map((action) => seed({ action })))

    const res = await request(testApp).get('/api/admin/audit-logs').set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(actions.length)
    const returnedActions = res.body.audit_logs.map((l: { action: string }) => l.action)
    for (const action of actions) {
      expect(returnedActions).toContain(action)
    }
  })
})

describe('GET /api/admin/audit-logs/:id', () => {
  beforeEach(() => clearAuditLogs())

  // --- Auth ---
  it('returns 401 with no token', async () => {
    const res = await request(testApp).get('/api/admin/audit-logs/any-id')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin role', async () => {
    const res = await request(testApp).get('/api/admin/audit-logs/any-id').set(AUTH(userToken))
    expect(res.status).toBe(403)
  })

  // --- Not found ---
  it('returns 404 for unknown id', async () => {
    const res = await request(testApp)
      .get('/api/admin/audit-logs/does-not-exist')
      .set(AUTH(adminToken))
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })

  // --- Success ---
  it('returns the correct log by id', async () => {
    const log = await seed({ action: 'vault.cancelled', target_type: 'vault', target_id: 'vault-99' })

    const res = await request(testApp)
      .get(`/api/admin/audit-logs/${log.id}`)
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: log.id,
      action: 'vault.cancelled',
      target_type: 'vault',
      target_id: 'vault-99',
      actor_user_id: 'admin-1',
    })
    expect(typeof res.body.created_at).toBe('string')
  })

  it('returns the correct log when multiple logs exist', async () => {
    await seed({ action: 'auth.login' })
    const target = await seed({ action: 'admin.override', target_id: 'vault-special' })
    await seed({ action: 'vault.created' })

    const res = await request(testApp)
      .get(`/api/admin/audit-logs/${target.id}`)
      .set(AUTH(adminToken))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(target.id)
    expect(res.body.action).toBe('admin.override')
  })
})
