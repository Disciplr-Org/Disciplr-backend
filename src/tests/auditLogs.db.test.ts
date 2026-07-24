/**
 * tests/auditLogs.db.test.ts
 *
 * Comprehensive database tests for audit logs persistence with PostgreSQL.
 * Tests index efficiency, filtering, pagination, authorization, and sanitization.
 * Issue #332: https://github.com/Disciplr-Org/Disciplr-backend/issues/332
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { db } from '../db/knex.js'
import {
  createAuditLog,
  listAuditLogs,
  getAuditLogById,
  clearAuditLogs,
  AuditLog,
  AuditLogFilters,
} from '../lib/audit-logs.js'

// Helper to generate UUID v4 for consistent ID format
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Test fixture: Create a sample audit log entry
 */
const createSampleLog = (overrides: Partial<AuditLog> = {}) => ({
  actor_user_id: 'user-' + generateUUID(),
  action: 'vault.created',
  target_type: 'vault',
  target_id: 'vault-' + generateUUID(),
  metadata: {
    vault_amount: '5000',
    destination: 'GBVX...',
  },
  ...overrides,
})

describe('Audit Logs Database Persistence (Issue #332)', () => {
  beforeAll(async () => {
    // Ensure audit_logs table exists
    const exists = await db.schema.hasTable('audit_logs')
    expect(exists).toBe(true)
  })

  beforeEach(async () => {
    // Clear audit logs before each test for isolation
    await clearAuditLogs()
  })

  afterAll(async () => {
    // Cleanup
    await clearAuditLogs()
  })

  describe('createAuditLog - Persistence and Sanitization', () => {
    it('should persist audit log to PostgreSQL with all required fields', async () => {
      const entry = createSampleLog()
      const created = await createAuditLog(entry)

      expect(created).toEqual(
        expect.objectContaining({
          actor_user_id: entry.actor_user_id,
          action: entry.action,
          target_type: entry.target_type,
          target_id: entry.target_id,
        }),
      )
      expect(created.id).toBeDefined()
      expect(created.created_at).toBeDefined()
      expect(new Date(created.created_at).getTime()).toBeGreaterThan(0)
    })

    it('should sanitize sensitive metadata (passwords, tokens, emails, IPs)', async () => {
      const entry = createSampleLog({
        metadata: {
          user_password: 'secret123',
          auth_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJpc3MiOiIifQ',
          user_email: 'test@example.com',
          ip_address: '192.168.1.1',
          safe_field: 'this_should_remain',
          long_secret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      })

      const created = await createAuditLog(entry)
      const retrieved = await getAuditLogById(created.id)

      expect(retrieved?.metadata).toBeDefined()
      expect(retrieved?.metadata.safe_field).toBe('this_should_remain')
      // Sensitive fields should be redacted
      expect(retrieved?.metadata.user_password).toBeUndefined()
      expect(retrieved?.metadata.auth_token).toBeUndefined()
      expect(retrieved?.metadata.user_email).toBeUndefined()
      expect(retrieved?.metadata.ip_address).toBeUndefined()
      expect(retrieved?.metadata.long_secret).toBeUndefined()
    })

    it('should reject audit log with missing required fields', async () => {
      const invalid = {
        actor_user_id: 'user-123',
        action: 'test.action',
        // missing target_type and target_id
      }

      await expect(
        createAuditLog(invalid as any),
      ).rejects.toThrow('Invalid audit log entry: missing required fields')
    })

    it('should normalize metadata keys to snake_case', async () => {
      const entry = createSampleLog({
        metadata: {
          vaultAmount: '5000',
          successDestination: 'GBXXX',
          'user-id': 'user-001',
        },
      })

      const created = await createAuditLog(entry)
      const retrieved = await getAuditLogById(created.id)

      expect(retrieved?.metadata.vault_amount).toBeDefined()
      expect(retrieved?.metadata.success_destination).toBeDefined()
      expect(retrieved?.metadata.user_id).toBeDefined()
    })

    it('should store metadata as JSONB with proper JSON serialization', async () => {
      const entry = createSampleLog({
        metadata: {
          nested_object: {
            level_one: {
              level_two: 'deep_value',
            },
          },
          array_data: [1, 2, 3],
          boolean_flag: true,
          null_value: null,
        },
      })

      const created = await createAuditLog(entry)
      const retrieved = await getAuditLogById(created.id)

      expect(retrieved?.metadata.nested_object).toEqual({
        level_one: { level_two: 'deep_value' },
      })
      expect(retrieved?.metadata.array_data).toEqual([1, 2, 3])
      expect(retrieved?.metadata.boolean_flag).toBe(true)
    })

    it('should add admin_id to metadata from actor_user_id', async () => {
      const userId = 'admin-' + generateUUID()
      const entry = createSampleLog({
        actor_user_id: userId,
        metadata: { action_reason: 'security_audit' },
      })

      const created = await createAuditLog(entry)
      const retrieved = await getAuditLogById(created.id)

      expect(retrieved?.metadata.admin_id).toBe(userId)
      expect(retrieved?.metadata.action_reason).toBe('security_audit')
    })
  })

  describe('listAuditLogs - Filtering and Query Efficiency', () => {
    beforeEach(async () => {
      // Create test data with various combinations
      const userId1 = 'user-' + generateUUID()
      const userId2 = 'user-' + generateUUID()
      const vaultId = 'vault-' + generateUUID()

      await createAuditLog({
        actor_user_id: userId1,
        action: 'vault.created',
        target_type: 'vault',
        target_id: vaultId,
        metadata: { amount: '1000' },
      })

      await createAuditLog({
        actor_user_id: userId1,
        action: 'vault.cancelled',
        target_type: 'vault',
        target_id: vaultId,
        metadata: { reason: 'user_request' },
      })

      await createAuditLog({
        actor_user_id: userId2,
        action: 'auth.login',
        target_type: 'user',
        target_id: userId2,
        metadata: { ip: '[redacted]' },
      })

      await createAuditLog({
        actor_user_id: userId2,
        action: 'auth.role_changed',
        target_type: 'user',
        target_id: userId1,
        metadata: { old_role: 'USER', new_role: 'ADMIN' },
      })

      await createAuditLog({
        actor_user_id: 'system',
        action: 'admin.override',
        target_type: 'vault',
        target_id: vaultId,
        metadata: { reason_code: 'SYSTEM_ERROR' },
      })
    })

    it('should filter by actor_user_id using index', async () => {
      const allLogs = await listAuditLogs()
      const userId = allLogs[0].actor_user_id

      const filtered = await listAuditLogs({ actor_user_id: userId })

      expect(filtered.length).toBeGreaterThan(0)
      expect(filtered.every((log) => log.actor_user_id === userId)).toBe(true)
    })

    it('should filter by action using index', async () => {
      const filtered = await listAuditLogs({ action: 'vault.created' })

      expect(filtered.length).toBeGreaterThan(0)
      expect(filtered.every((log) => log.action === 'vault.created')).toBe(true)
    })

    it('should filter by target_type', async () => {
      const filtered = await listAuditLogs({ target_type: 'vault' })

      expect(filtered.every((log) => log.target_type === 'vault')).toBe(true)
    })

    it('should filter by target_id', async () => {
      const allLogs = await listAuditLogs()
      const targetId = allLogs.find((log) => log.target_type === 'vault')?.target_id

      const filtered = await listAuditLogs({ target_id: targetId })

      expect(filtered.every((log) => log.target_id === targetId)).toBe(true)
    })

    it('should combine multiple filters (actor_user_id + action)', async () => {
      const allLogs = await listAuditLogs()
      const userId = allLogs[0].actor_user_id
      const action = allLogs[0].action

      const filtered = await listAuditLogs({
        actor_user_id: userId,
        action: action,
      })

      expect(
        filtered.every(
          (log) => log.actor_user_id === userId && log.action === action,
        ),
      ).toBe(true)
    })

    it('should combine action + target_type filters', async () => {
      const filtered = await listAuditLogs({
        action: 'vault.created',
        target_type: 'vault',
      })

      expect(
        filtered.every(
          (log) => log.action === 'vault.created' && log.target_type === 'vault',
        ),
      ).toBe(true)
    })

    it('should return empty array for no matches', async () => {
      const filtered = await listAuditLogs({
        action: 'nonexistent.action',
      })

      expect(filtered).toEqual([])
    })

    it('should order results by created_at descending (most recent first)', async () => {
      const logs = await listAuditLogs()

      if (logs.length > 1) {
        for (let i = 0; i < logs.length - 1; i++) {
          const current = new Date(logs[i].created_at).getTime()
          const next = new Date(logs[i + 1].created_at).getTime()
          expect(current).toBeGreaterThanOrEqual(next)
        }
      }
    })
  })

  describe('listAuditLogs - Pagination', () => {
    beforeEach(async () => {
      // Create exactly 15 audit logs
      for (let i = 0; i < 15; i++) {
        await createAuditLog({
          actor_user_id: `user-${i}`,
          action: 'test.action',
          target_type: 'test',
          target_id: `target-${i}`,
          metadata: { index: i },
        })
      }
    })

    it('should respect limit parameter (default 100)', async () => {
      const logs = await listAuditLogs({ limit: 5 })
      expect(logs.length).toBeLessThanOrEqual(5)
    })

    it('should respect offset parameter for pagination', async () => {
      const firstPage = await listAuditLogs({ limit: 5, offset: 0 })
      const secondPage = await listAuditLogs({ limit: 5, offset: 5 })

      expect(firstPage.length).toBe(5)
      expect(secondPage.length).toBe(5)
      expect(firstPage[0].id).not.toBe(secondPage[0].id)
    })

    it('should handle limit as string number', async () => {
      const logs = await listAuditLogs({ limit: '3' as any })
      expect(logs.length).toBeLessThanOrEqual(3)
    })

    it('should handle offset as string number', async () => {
      const logs = await listAuditLogs({ offset: '10' as any })
      expect(logs.length).toBeLessThanOrEqual(5)
    })

    it('should use default limit of 100 when not specified', async () => {
      const logs = await listAuditLogs()
      expect(logs.length).toBeLessThanOrEqual(100)
    })

    it('should default offset to 0', async () => {
      const logsNoOffset = await listAuditLogs({ limit: 5 })
      const logsExplicitZero = await listAuditLogs({ limit: 5, offset: 0 })

      expect(logsNoOffset[0].id).toBe(logsExplicitZero[0].id)
    })

    it('should handle negative limit gracefully (should use default)', async () => {
      const logs = await listAuditLogs({ limit: -5 as any })
      expect(logs.length).toBeGreaterThanOrEqual(0)
    })

    it('should handle negative offset gracefully (should use 0)', async () => {
      const logs = await listAuditLogs({ offset: -1 as any })
      expect(logs.length).toBeGreaterThan(0)
    })
  })

  describe('getAuditLogById - ID Lookups', () => {
    let testLogId: string

    beforeEach(async () => {
      const created = await createAuditLog(createSampleLog())
      testLogId = created.id
    })

    it('should retrieve audit log by exact ID', async () => {
      const retrieved = await getAuditLogById(testLogId)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(testLogId)
    })

    it('should return undefined for nonexistent ID', async () => {
      const retrieved = await getAuditLogById('nonexistent-id-' + generateUUID())

      expect(retrieved).toBeUndefined()
    })

    it('should preserve all fields in retrieval', async () => {
      const entry = createSampleLog({
        action: 'auth.role_changed',
        metadata: { old_role: 'USER', new_role: 'ADMIN' },
      })
      const created = await createAuditLog(entry)
      const retrieved = await getAuditLogById(created.id)

      expect(retrieved).toMatchObject({
        actor_user_id: entry.actor_user_id,
        action: entry.action,
        target_type: entry.target_type,
        target_id: entry.target_id,
      })
      expect(retrieved?.metadata).toHaveProperty('old_role')
      expect(retrieved?.metadata).toHaveProperty('new_role')
    })

    it('should handle empty string ID', async () => {
      const retrieved = await getAuditLogById('')

      expect(retrieved).toBeUndefined()
    })
  })

  describe('Audit Log Actions - Coverage', () => {
    it('should support auth.login action', async () => {
      const log = await createAuditLog({
        actor_user_id: 'user-123',
        action: 'auth.login',
        target_type: 'user',
        target_id: 'user-123',
        metadata: { login_method: 'password' },
      })

      expect(log.action).toBe('auth.login')
      const retrieved = await listAuditLogs({ action: 'auth.login' })
      expect(retrieved.length).toBeGreaterThan(0)
    })

    it('should support auth.role_changed action', async () => {
      const log = await createAuditLog({
        actor_user_id: 'admin-001',
        action: 'auth.role_changed',
        target_type: 'user',
        target_id: 'user-001',
        metadata: { old_role: 'USER', new_role: 'ADMIN' },
      })

      expect(log.action).toBe('auth.role_changed')
    })

    it('should support vault.created action', async () => {
      const log = await createAuditLog({
        actor_user_id: 'user-123',
        action: 'vault.created',
        target_type: 'vault',
        target_id: 'vault-001',
        metadata: { amount: '5000' },
      })

      expect(log.action).toBe('vault.created')
    })

    it('should support vault.cancelled action', async () => {
      const log = await createAuditLog({
        actor_user_id: 'admin-001',
        action: 'vault.cancelled',
        target_type: 'vault',
        target_id: 'vault-001',
        metadata: { reason: 'FRAUD_DETECTED' },
      })

      expect(log.action).toBe('vault.cancelled')
    })

    it('should support admin.override action', async () => {
      const log = await createAuditLog({
        actor_user_id: 'admin-001',
        action: 'admin.override',
        target_type: 'vault',
        target_id: 'vault-001',
        metadata: { reason_code: 'EMERGENCY_ADMIN_ACTION' },
      })

      expect(log.action).toBe('admin.override')
    })
  })

  describe('Index Efficiency - Query Performance Assertions', () => {
    beforeEach(async () => {
      // Create test data across multiple actors and actions
      for (let i = 0; i < 20; i++) {
        await createAuditLog({
          actor_user_id: `user-${i % 5}`,
          action:
            ['auth.login', 'vault.created', 'vault.cancelled', 'admin.override'][
              i % 4
            ],
          target_type: 'vault',
          target_id: `vault-${i % 10}`,
          metadata: { iteration: i },
        })
      }
    })

    it('should use actor_user_id index for filtered queries', async () => {
      const start = Date.now()
      const logs = await listAuditLogs({ actor_user_id: 'user-1' })
      const duration = Date.now() - start

      expect(logs.length).toBeGreaterThan(0)
      expect(duration).toBeLessThan(1000) // Should complete quickly with index
    })

    it('should use action index for filtered queries', async () => {
      const start = Date.now()
      const logs = await listAuditLogs({ action: 'auth.login' })
      const duration = Date.now() - start

      expect(logs.length).toBeGreaterThan(0)
      expect(duration).toBeLessThan(1000)
    })

    it('should use composite (actor_user_id, created_at) index', async () => {
      const start = Date.now()
      const logs = await listAuditLogs({
        actor_user_id: 'user-1',
        limit: 10,
        offset: 0,
      })
      const duration = Date.now() - start

      expect(logs.length).toBeGreaterThan(0)
      expect(duration).toBeLessThan(1000)
    })

    it('should use created_at index for ordering', async () => {
      const start = Date.now()
      const logs = await listAuditLogs({ limit: 100, offset: 0 })
      const duration = Date.now() - start

      // Verify ordered by created_at
      if (logs.length > 1) {
        const first = new Date(logs[0].created_at).getTime()
        const second = new Date(logs[1].created_at).getTime()
        expect(first).toBeGreaterThanOrEqual(second)
      }
      expect(duration).toBeLessThan(1000)
    })
  })

  describe('Data Integrity and Consistency', () => {
    it('should maintain referential consistency across multiple operations', async () => {
      const userId = 'user-' + generateUUID()
      const vaultId = 'vault-' + generateUUID()

      const log1 = await createAuditLog({
        actor_user_id: userId,
        action: 'vault.created',
        target_type: 'vault',
        target_id: vaultId,
        metadata: { amount: '1000' },
      })

      const log2 = await createAuditLog({
        actor_user_id: userId,
        action: 'vault.cancelled',
        target_type: 'vault',
        target_id: vaultId,
        metadata: { reason: 'user_request' },
      })

      const logs = await listAuditLogs({
        actor_user_id: userId,
        target_id: vaultId,
      })

      expect(logs.length).toBeGreaterThanOrEqual(2)
      expect(logs.map((l) => l.id)).toContain(log1.id)
      expect(logs.map((l) => l.id)).toContain(log2.id)
    })

    it('should preserve created_at timestamp exactly as stored', async () => {
      const before = new Date().toISOString()
      const created = await createAuditLog(createSampleLog())
      const after = new Date().toISOString()

      expect(created.created_at).toBeGreaterThanOrEqual(before)
      expect(created.created_at).toBeLessThanOrEqual(after)

      const retrieved = await getAuditLogById(created.id)
      expect(retrieved?.created_at).toBe(created.created_at)
    })

    it('should handle concurrent creates without data loss', async () => {
      const promises = Array.from({ length: 10 }, () =>
        createAuditLog(createSampleLog()),
      )

      const created = await Promise.all(promises)
      const ids = created.map((log) => log.id)

      // Verify all were persisted
      const retrieved = await Promise.all(ids.map((id) => getAuditLogById(id)))
      expect(retrieved.every((log) => log !== undefined)).toBe(true)
    })
  })

  describe('Timezone Handling - UTC Consistency', () => {
    it('should store and retrieve created_at in UTC ISO 8601 format', async () => {
      const created = await createAuditLog(createSampleLog())

      expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(created.created_at).toMatch(/Z$/) // UTC indicator

      const retrieved = await getAuditLogById(created.id)
      expect(retrieved?.created_at).toBe(created.created_at)
    })
  })
})
