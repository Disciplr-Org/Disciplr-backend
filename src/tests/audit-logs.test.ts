import { createAuditLog, listAuditLogs, getAuditLogById, clearAuditLogs } from '../lib/audit-logs.js'

describe('audit logs core', () => {
  beforeEach(() => {
    clearAuditLogs()
  })

  test('should create structured audit log with sanitized metadata', () => {
    const entry = createAuditLog({
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

  test('should support listing and filtering', () => {
    createAuditLog({
      actor_user_id: 'system',
      action: 'event_processed',
      target_type: 'event',
      target_id: 'evt-1',
      metadata: { foo: 'bar' },
    })
    createAuditLog({
      actor_user_id: 'other',
      action: 'event_processing_failed',
      target_type: 'event',
      target_id: 'evt-2',
      metadata: { foo: 'baz' },
    })

    const logs = listAuditLogs({ action: 'event_processed' })
    expect(logs.length).toBe(1)
    expect(logs[0].action).toBe('event_processed')
  })

  test('should retrieve by id', () => {
    const entry = createAuditLog({
      actor_user_id: 'system',
      action: 'event_processed',
      target_type: 'event',
      target_id: 'evt-123',
      metadata: { a: 'b' },
    })

    const found = getAuditLogById(entry.id)
    expect(found).toEqual(entry)
  })

  test('should throw if required fields missing', () => {
    expect(() =>
      createAuditLog({
        actor_user_id: '',
        action: '',
        target_type: '',
        target_id: '',
        metadata: {},
      } as any),
    ).toThrow('Invalid audit log entry: missing required fields')
  })
})