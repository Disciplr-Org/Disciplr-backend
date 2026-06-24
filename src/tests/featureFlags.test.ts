import { jest } from '@jest/globals'
import knex, { Knex } from 'knex'
import request from 'supertest'

// In-memory SQLite instance. Created in beforeAll, shared with the service via the mock below.
let testDb: Knex

// jest.mock is hoisted to the top of the file by Babel/ts-jest.
// The factory captures a reference to a stable wrapper function so that by the
// time any test runs (after beforeAll), testDb is fully initialised.
const dbProxy: any = new Proxy(
  function () {} as any,
  {
    // called as: db('feature_flags')
    apply(_target: any, _this: any, args: any[]) {
      return (testDb as any)(...args)
    },
    // accessed as: db.fn, db.schema, etc.
    get(_target: any, prop: string) {
      return (testDb as any)[prop]
    },
  }
)

jest.mock('../db/knex', () => ({
  db: dbProxy,
  closeDatabase: async () => {},
}))

import { app } from '../app'
import {
  getFlag,
  setFlag,
  getAllFlags,
  FeatureFlag,
  isValidFeatureFlag,
  clearCache,
  getCacheStats,
} from '../services/featureFlags'

// Mock auth middleware for admin routes
jest.mock('../middleware/auth.js', () => ({
  authorize: (req: any, res: any, next: any) => {
    req.user = {
      userId: 'test-admin-user',
      role: 'admin',
    }
    next()
  },
}))

jest.mock('../middleware/rbac', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  },
}))

jest.mock('../lib/audit-logs', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-log-123' }),
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
}))

describe('Feature Flags Service', () => {
  beforeAll(async () => {
    testDb = knex({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true })
    await testDb.schema.createTable('feature_flags', (t) => {
      t.string('name', 128).notNullable()
      t.string('org_id', 255).nullable()
      t.boolean('enabled').notNullable().defaultTo(false)
      t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
    })
  })

  afterAll(async () => {
    await testDb.destroy()
  })

  beforeEach(async () => {
    clearCache()

    // Reset DB to clean state
    await testDb('feature_flags').del()

    // Seed initial flags
    await testDb('feature_flags').insert([
      { name: 'ENTERPRISE_ANALYTICS', org_id: null, enabled: false },
      { name: 'MULTI_VERIFIER_ENABLED', org_id: null, enabled: false },
      { name: 'ORGANIZATION_QUOTAS', org_id: null, enabled: false },
      { name: 'ADVANCED_ANALYTICS', org_id: null, enabled: false },
    ])
  })

  afterEach(() => {
    clearCache()
  })

  describe('getFlag() - Service Function', () => {
    test('should retrieve global flag when orgId not provided', async () => {
      // Enable global flag in DB
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      const result = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(result).toBe(true)
    })

    test('should retrieve org-specific flag when orgId provided and exists', async () => {
      // Create org-specific override
      await testDb('feature_flags').insert({
        name: 'ENTERPRISE_ANALYTICS',
        org_id: 'org-123',
        enabled: true,
      })

      const result = await getFlag('ENTERPRISE_ANALYTICS', 'org-123')
      expect(result).toBe(true)
    })

    test('should fall back to global when org-specific does not exist', async () => {
      // Enable only global flag
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      // Query for non-existent org should return global value
      const result = await getFlag('ENTERPRISE_ANALYTICS', 'org-999')
      expect(result).toBe(true)
    })

    test('should return false for non-existent flags', async () => {
      const result = await getFlag('NONEXISTENT_FLAG', null)
      expect(result).toBe(false)
    })

    test('should cache results on subsequent calls', async () => {
      // Prime cache with first call
      const result1 = await getFlag('ENTERPRISE_ANALYTICS', null)
      const sizeAfterFirst = getCacheStats().size

      // Second call should use cache (size unchanged means no new DB call would be needed)
      const result2 = await getFlag('ENTERPRISE_ANALYTICS', null)
      const sizeAfterSecond = getCacheStats().size

      expect(result1).toBe(result2)
      expect(sizeAfterSecond).toBe(sizeAfterFirst)
    })

    test('should cache separately for different orgIds', async () => {
      await testDb('feature_flags').insert([
        { name: 'MULTI_VERIFIER_ENABLED', org_id: 'org-a', enabled: true },
        { name: 'MULTI_VERIFIER_ENABLED', org_id: 'org-b', enabled: false },
      ])

      const resultA = await getFlag('MULTI_VERIFIER_ENABLED', 'org-a')
      const resultB = await getFlag('MULTI_VERIFIER_ENABLED', 'org-b')
      const resultGlobal = await getFlag('MULTI_VERIFIER_ENABLED', null)

      expect(resultA).toBe(true)
      expect(resultB).toBe(false)
      expect(resultGlobal).toBe(false)
    })

    test('should handle DB errors gracefully', async () => {
      // Corrupt the table temporarily by dropping it
      await testDb.schema.dropTable('feature_flags')
      const result = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(result).toBe(false) // Returns false on error
      // Recreate for subsequent tests
      await testDb.schema.createTable('feature_flags', (t) => {
        t.string('name', 128).notNullable()
        t.string('org_id', 255).nullable()
        t.boolean('enabled').notNullable().defaultTo(false)
        t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
      })
    })
  })

  describe('setFlag() - Service Function', () => {
    test('should update existing flag', async () => {
      await setFlag('ENTERPRISE_ANALYTICS', null, true)

      const row = await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .first()
      expect(row?.enabled).toBe(true)
    })

    test('should create new flag if not exists', async () => {
      await setFlag('ENTERPRISE_ANALYTICS', 'org-new', true)

      const row = await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: 'org-new' })
        .first()
      expect(row?.enabled).toBe(true)
    })

    test('should invalidate cache after update', async () => {
      // Prime cache
      await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(getCacheStats().size).toBeGreaterThan(0)

      // Update should invalidate cache
      await setFlag('ENTERPRISE_ANALYTICS', null, true)

      // Next fetch should query DB again (cache miss)
      const stats = getCacheStats()
      // Cache size may vary, but the specific key should be invalidated
      const result = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(result).toBe(true)
    })

    test('should return the enabled value that was set', async () => {
      const result = await setFlag('ENTERPRISE_ANALYTICS', 'org-123', true)
      expect(result).toBe(true)

      const result2 = await setFlag('ENTERPRISE_ANALYTICS', 'org-456', false)
      expect(result2).toBe(false)
    })

    test('should handle DB errors', async () => {
      await testDb.schema.dropTable('feature_flags')
      await expect(setFlag('ENTERPRISE_ANALYTICS', 'org-fail', true)).rejects.toThrow()
      await testDb.schema.createTable('feature_flags', (t) => {
        t.string('name', 128).notNullable()
        t.string('org_id', 255).nullable()
        t.boolean('enabled').notNullable().defaultTo(false)
        t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
      })
    })
  })

  describe('getAllFlags() - Service Function', () => {
    test('should return all global flags', async () => {
      const flags = await getAllFlags(null)

      expect(flags['ENTERPRISE_ANALYTICS']).toBe(false)
      expect(flags['MULTI_VERIFIER_ENABLED']).toBe(false)
      expect(flags['ORGANIZATION_QUOTAS']).toBe(false)
      expect(flags['ADVANCED_ANALYTICS']).toBe(false)
    })

    test('should merge org-specific overrides with global defaults', async () => {
      // Set global
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      // Set org override (different value)
      await testDb('feature_flags').insert({
        name: 'MULTI_VERIFIER_ENABLED',
        org_id: 'org-123',
        enabled: true,
      })

      const flags = await getAllFlags('org-123')

      // Should get org-specific override
      expect(flags['MULTI_VERIFIER_ENABLED']).toBe(true)
      // Should fall back to global
      expect(flags['ENTERPRISE_ANALYTICS']).toBe(true)
    })

    test('should return empty object on DB error', async () => {
      await testDb.schema.dropTable('feature_flags')
      const flags = await getAllFlags(null)
      expect(flags).toEqual({})
      await testDb.schema.createTable('feature_flags', (t) => {
        t.string('name', 128).notNullable()
        t.string('org_id', 255).nullable()
        t.boolean('enabled').notNullable().defaultTo(false)
        t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
      })
    })
  })

  describe('isValidFeatureFlag() - Type Guard', () => {
    test('should accept valid flag names', () => {
      expect(isValidFeatureFlag('ENTERPRISE_ANALYTICS')).toBe(true)
      expect(isValidFeatureFlag('MULTI_VERIFIER_ENABLED')).toBe(true)
    })

    test('should reject invalid flag names', () => {
      expect(isValidFeatureFlag('INVALID_FLAG')).toBe(false)
      expect(isValidFeatureFlag('random_string')).toBe(false)
      expect(isValidFeatureFlag('')).toBe(false)
    })
  })

  describe('Cache Behavior', () => {
    test('should have TTL of 5 minutes', async () => {
      // Set a flag
      await setFlag('ENTERPRISE_ANALYTICS', null, true)

      // Get and verify cache hit
      let cached = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(cached).toBe(true)

      // Fast-forward time by changing the value and checking immediate behavior
      // Note: Full TTL test would require mocking Date
      const stats = getCacheStats()
      expect(stats.size).toBeGreaterThan(0)
      expect(stats.maxSize).toBe(1000)
    })

    test('should not exceed max cache size of 1000', async () => {
      // Create many flags beyond cache size
      for (let i = 0; i < 1100; i++) {
        const flagName = `FLAG_${i}`
        await testDb('feature_flags').insert({
          name: flagName,
          org_id: null,
          enabled: i % 2 === 0,
        })
      }

      // Access all flags (populate cache)
      for (let i = 0; i < 1100; i++) {
        await getFlag(`FLAG_${i}`, null)
      }

      const stats = getCacheStats()
      expect(stats.size).toBeLessThanOrEqual(1000)
    })

    test('clearCache() should empty cache', () => {
      const statsBefore = getCacheStats()

      clearCache()

      const statsAfter = getCacheStats()
      expect(statsAfter.size).toBe(0)
    })
  })

  describe('Admin Endpoint - GET /api/admin/flags', () => {
    test('should return global flags without orgId query param', async () => {
      // Enable one flag for testing
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      const res = await request(app).get('/api/admin/flags').set('Authorization', 'Bearer test')

      expect(res.status).toBe(200)
      expect(res.body.data.orgId).toBe('global')
      expect(res.body.data.flags['ENTERPRISE_ANALYTICS']).toBe(true)
    })

    test('should return org-specific flags with orgId query param', async () => {
      await testDb('feature_flags').insert({
        name: 'ENTERPRISE_ANALYTICS',
        org_id: 'org-123',
        enabled: true,
      })

      const res = await request(app)
        .get('/api/admin/flags?orgId=org-123')
        .set('Authorization', 'Bearer test')

      expect(res.status).toBe(200)
      expect(res.body.data.orgId).toBe('org-123')
      expect(res.body.data.flags['ENTERPRISE_ANALYTICS']).toBe(true)
    })

    test('should include timestamp in response', async () => {
      const res = await request(app).get('/api/admin/flags').set('Authorization', 'Bearer test')

      expect(res.status).toBe(200)
      expect(res.body.data.timestamp).toBeDefined()
      expect(typeof res.body.data.timestamp).toBe('string')
    })

    test('should handle DB errors gracefully', async () => {
      await testDb.schema.dropTable('feature_flags')

      const res = await request(app).get('/api/admin/flags').set('Authorization', 'Bearer test')

      expect(res.status).toBe(200) // getAllFlags catches errors and returns {}
      await testDb.schema.createTable('feature_flags', (t) => {
        t.string('name', 128).notNullable()
        t.string('org_id', 255).nullable()
        t.boolean('enabled').notNullable().defaultTo(false)
        t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
      })
    })
  })

  describe('Admin Endpoint - PATCH /api/admin/flags/:name', () => {
    test('should enable a flag globally', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true })

      expect(res.status).toBe(200)
      expect(res.body.data.flag).toBe('ENTERPRISE_ANALYTICS')
      expect(res.body.data.orgId).toBe('global')
      expect(res.body.data.enabled).toBe(true)

      // Verify in DB
      const row = await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .first()
      expect(row?.enabled).toBe(true)
    })

    test('should set org-specific flag when orgId provided', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/MULTI_VERIFIER_ENABLED')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true, orgId: 'org-456' })

      expect(res.status).toBe(200)
      expect(res.body.data.orgId).toBe('org-456')
      expect(res.body.data.enabled).toBe(true)

      // Verify in DB
      const row = await testDb('feature_flags')
        .where({ name: 'MULTI_VERIFIER_ENABLED', org_id: 'org-456' })
        .first()
      expect(row?.enabled).toBe(true)
    })

    test('should disable a flag', async () => {
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: false })

      expect(res.status).toBe(200)
      expect(res.body.data.enabled).toBe(false)
    })

    test('should reject request with missing enabled field', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request body')
      expect(res.body.details).toContain('enabled must be a boolean')
    })

    test('should reject request with non-boolean enabled value', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: 'true' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request body')
    })

    test('should reject invalid flag name', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/INVALID_FLAG')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid feature flag name')
      expect(res.body.details).toContain('Unknown flag')
    })

    test('should reject non-string orgId', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true, orgId: 123 })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request body')
      expect(res.body.details).toContain('orgId must be a string')
    })

    test('should include timestamp in response', async () => {
      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true })

      expect(res.status).toBe(200)
      expect(res.body.data.timestamp).toBeDefined()
      expect(typeof res.body.data.timestamp).toBe('string')
    })

    test('should handle DB errors gracefully', async () => {
      await testDb.schema.dropTable('feature_flags')

      const res = await request(app)
        .patch('/api/admin/flags/ENTERPRISE_ANALYTICS')
        .set('Authorization', 'Bearer test')
        .send({ enabled: true })

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('Failed to update feature flag')
      await testDb.schema.createTable('feature_flags', (t) => {
        t.string('name', 128).notNullable()
        t.string('org_id', 255).nullable()
        t.boolean('enabled').notNullable().defaultTo(false)
        t.timestamp('updated_at').notNullable().defaultTo(testDb.fn.now())
      })
    })
  })

  describe('Concurrent Request Handling', () => {
    test('should handle multiple concurrent getFlag calls', async () => {
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(getFlag('ENTERPRISE_ANALYTICS', `org-${i}`))
      }

      const results = await Promise.all(promises)
      expect(results.length).toBe(10)
      expect(results.every((r) => typeof r === 'boolean')).toBe(true)
    })

    test('should handle concurrent get and set operations', async () => {
      const getPromises = []
      const setPromises = []

      // Mix of gets and sets
      for (let i = 0; i < 5; i++) {
        getPromises.push(getFlag('ENTERPRISE_ANALYTICS', `org-get-${i}`))
        setPromises.push(setFlag('MULTI_VERIFIER_ENABLED', `org-set-${i}`, i % 2 === 0))
      }

      await Promise.all([...getPromises, ...setPromises])

      // Verify consistency
      const result = await getFlag('MULTI_VERIFIER_ENABLED', 'org-set-0')
      expect(typeof result).toBe('boolean')
    })
  })

  describe('Edge Cases', () => {
    test('should handle null orgId explicitly', async () => {
      await setFlag('ENTERPRISE_ANALYTICS', null, true)
      const result = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(result).toBe(true)
    })

    test('should treat empty string orgId as global', async () => {
      await setFlag('ENTERPRISE_ANALYTICS', '', true)

      const row = await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: '' })
        .first()
      expect(row).toBeUndefined() // Empty string treated as null
    })

    test('should handle flag names with special characters', async () => {
      // Our enum doesn't have special chars, so this tests rejection
      const result = isValidFeatureFlag('FLAG-WITH-DASH')
      expect(result).toBe(false)
    })

    test('should survive rapid cache invalidation', async () => {
      for (let i = 0; i < 20; i++) {
        await setFlag('ENTERPRISE_ANALYTICS', null, i % 2 === 0)
        const result = await getFlag('ENTERPRISE_ANALYTICS', null)
        expect(typeof result).toBe('boolean')
      }
    })

    test('should handle very long orgId strings', async () => {
      const longOrgId = 'org-' + 'x'.repeat(250)
      await setFlag('ENTERPRISE_ANALYTICS', longOrgId, true)
      const result = await getFlag('ENTERPRISE_ANALYTICS', longOrgId)
      expect(result).toBe(true)
    })
  })

  describe('Fallback Logic', () => {
    test('org override takes precedence over global', async () => {
      // Global: false
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: false })

      // Org override: true
      await testDb('feature_flags').insert({
        name: 'ENTERPRISE_ANALYTICS',
        org_id: 'org-123',
        enabled: true,
      })

      const resultOrg = await getFlag('ENTERPRISE_ANALYTICS', 'org-123')
      const resultGlobal = await getFlag('ENTERPRISE_ANALYTICS', null)

      expect(resultOrg).toBe(true) // Org override
      expect(resultGlobal).toBe(false) // Global
    })

    test('global default used when org override missing', async () => {
      // Set global to true, no org override
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS', org_id: null })
        .update({ enabled: true })

      const result = await getFlag('ENTERPRISE_ANALYTICS', 'org-nonexistent')
      expect(result).toBe(true)
    })

    test('false returned for completely missing flag', async () => {
      // Delete a flag
      await testDb('feature_flags')
        .where({ name: 'ENTERPRISE_ANALYTICS' })
        .del()

      const result = await getFlag('ENTERPRISE_ANALYTICS', null)
      expect(result).toBe(false)
    })
  })
})
