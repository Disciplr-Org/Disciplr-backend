import { describe, it, expect } from '@jest/globals'
import {
  ExportRequestSchema,
  ExportJobResponseSchema,
  ExportJobStatusSchema,
  NotificationSchema,
  NotificationListResponseSchema,
  UserNotificationPreferencesSchema,
  UpdateUserNotificationPreferencesSchema,
  OrgNotificationPreferencesSchema,
  UpdateOrgNotificationPreferencesSchema,
  generateOpenApiSpec,
} from '../docs/openapi-generator.js'

describe('OpenAPI export schemas', () => {
  it('ExportRequestSchema accepts valid json/all payload', () => {
    const result = ExportRequestSchema.safeParse({ format: 'json', scope: 'all' })
    expect(result.success).toBe(true)
  })

  it('ExportRequestSchema accepts optional targetUserId', () => {
    const result = ExportRequestSchema.safeParse({ format: 'csv', scope: 'vaults', targetUserId: 'user_1' })
    expect(result.success).toBe(true)
  })

  it('ExportRequestSchema rejects invalid format', () => {
    const result = ExportRequestSchema.safeParse({ format: 'xml', scope: 'all' })
    expect(result.success).toBe(false)
  })

  it('ExportRequestSchema rejects invalid scope', () => {
    const result = ExportRequestSchema.safeParse({ format: 'json', scope: 'unknown' })
    expect(result.success).toBe(false)
  })

  it('ExportJobResponseSchema accepts valid response', () => {
    const result = ExportJobResponseSchema.safeParse({
      jobId: 'job_abc',
      statusUrl: '/api/exports/status/job_abc',
      pollIntervalMs: 1000,
    })
    expect(result.success).toBe(true)
  })

  it('ExportJobStatusSchema accepts done status with downloadUrl', () => {
    const result = ExportJobStatusSchema.safeParse({
      jobId: 'job_abc',
      status: 'done',
      attempts: 1,
      maxAttempts: 3,
      downloadUrl: '/api/exports/download/token',
      expiresInSeconds: 3600,
    })
    expect(result.success).toBe(true)
  })

  it('ExportJobStatusSchema accepts failed status with error', () => {
    const result = ExportJobStatusSchema.safeParse({
      jobId: 'job_abc',
      status: 'failed',
      attempts: 3,
      maxAttempts: 3,
      error: 'Internal error',
    })
    expect(result.success).toBe(true)
  })

  it('ExportJobStatusSchema rejects invalid status', () => {
    const result = ExportJobStatusSchema.safeParse({
      jobId: 'job_abc',
      status: 'unknown',
      attempts: 1,
      maxAttempts: 3,
    })
    expect(result.success).toBe(false)
  })
})

describe('OpenAPI notification routes and schemas', () => {
  it('registers all notification and notification preference paths', () => {
    const spec = generateOpenApiSpec() as unknown as {
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown }>>
    }
    const paths = spec.paths

    // Notifications router paths
    expect(paths['/api/notifications']).toBeDefined()
    expect(paths['/api/notifications'].get).toBeDefined()
    expect(paths['/api/notifications'].get.tags).toContain('Notifications')
    expect(paths['/api/notifications'].get.security).toBeDefined()

    expect(paths['/api/notifications/{id}/read']).toBeDefined()
    expect(paths['/api/notifications/{id}/read'].patch).toBeDefined()
    expect(paths['/api/notifications/{id}/read'].patch.tags).toContain('Notifications')

    expect(paths['/api/notifications/read-all']).toBeDefined()
    expect(paths['/api/notifications/read-all'].post).toBeDefined()
    expect(paths['/api/notifications/read-all'].post.tags).toContain('Notifications')

    // User notification preferences router paths
    expect(paths['/api/users/me/notification-preferences']).toBeDefined()
    expect(paths['/api/users/me/notification-preferences'].get).toBeDefined()
    expect(paths['/api/users/me/notification-preferences'].put).toBeDefined()
    expect(paths['/api/users/me/notification-preferences'].delete).toBeDefined()
    expect(paths['/api/users/me/notification-preferences'].get.tags).toContain('Notifications')

    // Org notification preferences router paths
    expect(paths['/api/orgs/{orgId}/notification-preferences']).toBeDefined()
    expect(paths['/api/orgs/{orgId}/notification-preferences'].get).toBeDefined()
    expect(paths['/api/orgs/{orgId}/notification-preferences'].put).toBeDefined()
    expect(paths['/api/orgs/{orgId}/notification-preferences'].get.tags).toContain('Notifications')
  })

  it('NotificationSchema validates a valid notification', () => {
    const valid = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      user_id: 'user_1',
      type: 'vault_failure',
      title: 'Alert',
      message: 'Deadline expired',
      data: { vaultId: '123' },
      idempotency_key: 'idem_key',
      read_at: '2026-06-02T10:00:00Z',
      archived_at: null,
      created_at: '2026-06-02T09:00:00Z',
    }
    expect(NotificationSchema.safeParse(valid).success).toBe(true)
  })

  it('NotificationListResponseSchema validates paginated notifications', () => {
    const valid = {
      data: [
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          user_id: 'user_1',
          type: 'vault_failure',
          title: 'Alert',
          message: 'Deadline expired',
          data: null,
          idempotency_key: null,
          read_at: null,
          archived_at: null,
          created_at: '2026-06-02T09:00:00Z',
        },
      ],
      pagination: {
        limit: 20,
        has_more: false,
        count: 1,
      },
    }
    expect(NotificationListResponseSchema.safeParse(valid).success).toBe(true)
  })

  it('UserNotificationPreferencesSchema validates user preferences', () => {
    const valid = {
      id: 'pref_1',
      user_id: 'user_1',
      timezone: 'UTC',
      quiet_hours_enabled: true,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      created_at: '2026-06-02T10:00:00Z',
      updated_at: '2026-06-02T10:00:00Z',
    }
    expect(UserNotificationPreferencesSchema.safeParse(valid).success).toBe(true)
  })

  it('UpdateUserNotificationPreferencesSchema validates update payload', () => {
    const valid = {
      timezone: 'America/New_York',
      quiet_hours_enabled: false,
      quiet_hours_start: '23:00',
      quiet_hours_end: '07:00',
    }
    expect(UpdateUserNotificationPreferencesSchema.safeParse(valid).success).toBe(true)
  })

  it('OrgNotificationPreferencesSchema validates org preferences', () => {
    const valid = {
      organizationId: 'org_1',
      categories: { vault_failure: true, milestone_reminder: false },
      channels: { email: true },
    }
    expect(OrgNotificationPreferencesSchema.safeParse(valid).success).toBe(true)
  })

  it('UpdateOrgNotificationPreferencesSchema validates org update payload', () => {
    const valid = {
      categories: { vault_failure: false },
      channels: { email: true },
    }
    expect(UpdateOrgNotificationPreferencesSchema.safeParse(valid).success).toBe(true)
  })
})
