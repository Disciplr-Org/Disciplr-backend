import { createAuditLog, listAuditLogs, getAuditLogById, clearAuditLogs } from '../lib/audit-logs.js'

describe('audit logs core', () => {
  beforeEach(async () => {
    await clearAuditLogs()
  })

  test('should create structured audit log with sanitized metadata', async () => {
    const entry = await createAuditLog({
      actor_user_id: 'admin-user-id',
      action: 'user.role.update',
      target_type: 'user',
      target_id: 'user-123',
      metadata: {
        oldRole: 'USER',
        newRole: 'ADMIN',
        password: 'secret',
        ip: '192.168.0.1',
      },
    })

    expect(entry).toHaveProperty('id')
    expect(entry).toHaveProperty('created_at')
    expect(entry.action).toBe('user.role.update')
    expect(entry.actor_user_id).toBe('admin-user-id')
    expect(entry.metadata).toHaveProperty('admin_id', 'admin-user-id')
    expect(entry.metadata).toHaveProperty('old_role', 'USER')
    expect(entry.metadata).toHaveProperty('new_role', 'ADMIN')
    expect(entry.metadata).not.toHaveProperty('password')
    expect(entry.metadata).not.toHaveProperty('ip')
  })

  test('should support listing and filtering', async () => {
    await createAuditLog({
      actor_user_id: 'system',
      action: 'event_processed',
      target_type: 'event',
      target_id: 'evt-1',
      metadata: { foo: 'bar' },
    })
    await createAuditLog({
      actor_user_id: 'other',
      action: 'event_processing_failed',
      target_type: 'event',
      target_id: 'evt-2',
      metadata: { foo: 'baz' },
    })

    const logs = await listAuditLogs({ action: 'event_processed' })
    expect(logs.length).toBe(1)
    expect(logs[0].action).toBe('event_processed')
  })

  test('should retrieve by id', async () => {
    const entry = await createAuditLog({
      actor_user_id: 'system',
      action: 'event_processed',
      target_type: 'event',
      target_id: 'evt-123',
      metadata: { a: 'b' },
    })

    const found = await getAuditLogById(entry.id)
    expect(found).toEqual(entry)
  })

  test('should throw if required fields missing', async () => {
    await expect(
      createAuditLog({
        actor_user_id: '',
        action: '',
        target_type: '',
        target_id: '',
        metadata: {},
      } as any),
    ).rejects.toThrow('Invalid audit log entry: missing required fields')
  })

  test('should support pagination', async () => {
    // Create multiple audit logs
    for (let i = 1; i <= 5; i++) {
      await createAuditLog({
        actor_user_id: 'user-1',
        action: 'test.action',
        target_type: 'test',
        target_id: `test-${i}`,
        metadata: { index: i },
      })
    }

    // Test limit
    const limitedLogs = await listAuditLogs({ limit: 3 })
    expect(limitedLogs).toHaveLength(3)

    // Test offset
    const offsetLogs = await listAuditLogs({ limit: 2, offset: 2 })
    expect(offsetLogs).toHaveLength(2)

    // Test pagination metadata
    const allLogs = await listAuditLogs({ limit: 2, offset: 0 })
    expect(allLogs).toHaveLength(2)
  })

  test('should filter by multiple criteria', async () => {
    await createAuditLog({
      actor_user_id: 'admin-1',
      action: 'user.create',
      target_type: 'user',
      target_id: 'user-1',
      metadata: {},
    })
    await createAuditLog({
      actor_user_id: 'admin-2',
      action: 'user.create',
      target_type: 'user',
      target_id: 'user-2',
      metadata: {},
    })
    await createAuditLog({
      actor_user_id: 'admin-1',
      action: 'user.delete',
      target_type: 'user',
      target_id: 'user-3',
      metadata: {},
    })

    // Filter by actor_user_id and action
    const filteredLogs = await listAuditLogs({
      actor_user_id: 'admin-1',
      action: 'user.create',
    })
    expect(filteredLogs).toHaveLength(1)
    expect(filteredLogs[0].actor_user_id).toBe('admin-1')
    expect(filteredLogs[0].action).toBe('user.create')
  })
})