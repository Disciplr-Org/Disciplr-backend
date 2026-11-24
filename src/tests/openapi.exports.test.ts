import { ExportRequestSchema, ExportJobResponseSchema, ExportJobStatusSchema, generateOpenApiSpec } from '../docs/openapi-generator.js'

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

describe('OpenAPI webhook routes and schemas', () => {
  it('registers all webhook and admin webhook paths', () => {
    const spec = generateOpenApiSpec() as unknown as {
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown }>>
    }
    const paths = spec.paths

    // Standard subscriber endpoints
    expect(paths['/api/webhooks']).toBeDefined()
    expect(paths['/api/webhooks'].post).toBeDefined()
    expect(paths['/api/webhooks'].post.tags).toContain('Webhooks')
    expect(paths['/api/webhooks'].get).toBeDefined()
    expect(paths['/api/webhooks'].get.tags).toContain('Webhooks')

    expect(paths['/api/webhooks/{id}']).toBeDefined()
    expect(paths['/api/webhooks/{id}'].get).toBeDefined()
    expect(paths['/api/webhooks/{id}'].delete).toBeDefined()

    expect(paths['/api/webhooks/{id}/rotate-secret']).toBeDefined()
    expect(paths['/api/webhooks/{id}/rotate-secret'].post).toBeDefined()

    // Admin webhook endpoints
    expect(paths['/api/admin/webhooks/dead-letters']).toBeDefined()
    expect(paths['/api/admin/webhooks/dead-letters'].get).toBeDefined()

    expect(paths['/api/admin/webhooks/dead-letters/{id}/replay']).toBeDefined()
    expect(paths['/api/admin/webhooks/dead-letters/{id}/replay'].post).toBeDefined()

    expect(paths['/api/admin/webhooks/subscribers']).toBeDefined()
    expect(paths['/api/admin/webhooks/subscribers'].post).toBeDefined()
    expect(paths['/api/admin/webhooks/subscribers'].get).toBeDefined()

    expect(paths['/api/admin/webhooks/subscribers/{id}/rotate-secret']).toBeDefined()
    expect(paths['/api/admin/webhooks/subscribers/{id}/rotate-secret'].post).toBeDefined()

    expect(paths['/api/admin/webhooks/pause/status']).toBeDefined()
    expect(paths['/api/admin/webhooks/pause/status'].get).toBeDefined()

    expect(paths['/api/admin/webhooks/pause']).toBeDefined()
    expect(paths['/api/admin/webhooks/pause'].post).toBeDefined()

    expect(paths['/api/admin/webhooks/resume']).toBeDefined()
    expect(paths['/api/admin/webhooks/resume'].post).toBeDefined()

    expect(paths['/api/admin/webhooks/{id}/replay']).toBeDefined()
    expect(paths['/api/admin/webhooks/{id}/replay'].post).toBeDefined()

    expect(paths['/api/admin/webhooks/egress-allowlist']).toBeDefined()
    expect(paths['/api/admin/webhooks/egress-allowlist'].get).toBeDefined()
    expect(paths['/api/admin/webhooks/egress-allowlist'].post).toBeDefined()
    expect(paths['/api/admin/webhooks/egress-allowlist'].delete).toBeDefined()

    expect(paths['/api/admin/webhooks/{id}/stats']).toBeDefined()
    expect(paths['/api/admin/webhooks/{id}/stats'].get).toBeDefined()

    expect(paths['/api/admin/webhooks/subscribers/{id}/field-policy']).toBeDefined()
    expect(paths['/api/admin/webhooks/subscribers/{id}/field-policy'].patch).toBeDefined()
  })

  it('validates WebhookSubscriptionSchema with valid subscription', () => {
    const valid = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      url: 'https://example.com/webhook',
      events: ['vault.created', 'vault.completed'],
      active: true,
      orgId: 'org_123',
      createdAt: '2026-06-02T10:00:00Z',
    }
    expect(WebhookSubscriptionSchema.safeParse(valid).success).toBe(true)
  })

  it('validates CreateWebhookRequestSchema and rejects non-url', () => {
    const valid = {
      url: 'https://example.com/webhook',
      events: ['vault.created'],
      active: true,
    }
    expect(CreateWebhookRequestSchema.safeParse(valid).success).toBe(true)

    const invalid = {
      url: 'not-a-url',
      events: ['vault.created'],
    }
    expect(CreateWebhookRequestSchema.safeParse(invalid).success).toBe(false)
  })

  it('validates CreateWebhookResponseSchema', () => {
    const valid = {
      secret: 'sec_1234567890',
      subscription: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        url: 'https://example.com/webhook',
        events: ['vault.created'],
        active: true,
        createdAt: '2026-06-02T10:00:00Z',
      },
    }
    expect(CreateWebhookResponseSchema.safeParse(valid).success).toBe(true)
  })

  it('validates WebhookDeadLetterSchema', () => {
    const valid = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      subscriber_id: '123e4567-e89b-12d3-a456-426614174001',
      event_id: 'evt_123',
      event_type: 'vault.failed',
      payload: { vaultId: 'vault_1' },
      last_error: 'Connection timeout',
      attempts: 3,
      failed_at: '2026-06-02T10:00:00Z',
      replayed_at: null,
    }
    expect(WebhookDeadLetterSchema.safeParse(valid).success).toBe(true)
  })

  it('validates FieldPolicySchema', () => {
    const valid = {
      mode: 'allowlist',
      fields: ['vaultId', 'amount'],
      stripPii: true,
    }
    expect(FieldPolicySchema.safeParse(valid).success).toBe(true)

    const invalid = {
      mode: 'invalid-mode',
      fields: [],
      stripPii: true,
    }
    expect(FieldPolicySchema.safeParse(invalid).success).toBe(false)
  })

  it('validates AdminWebhookSubscriberSchema', () => {
    const valid = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      organization_id: 'org_123',
      url: 'https://example.com/webhook',
      events: ['vault.created'],
      active: true,
      created_at: '2026-06-02T10:00:00Z',
      rotated_at: null,
    }
    expect(AdminWebhookSubscriberSchema.safeParse(valid).success).toBe(true)
  })

  it('validates EgressAllowlistEntrySchema', () => {
    const valid = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      organizationId: 'org_123',
      host: 'api.partner.com',
      createdAt: '2026-06-02T10:00:00Z',
    }
    expect(EgressAllowlistEntrySchema.safeParse(valid).success).toBe(true)
  })

  it('validates SubscriberDeliveryStatsSchema', () => {
    const valid = {
      subscriber_id: '123e4567-e89b-12d3-a456-426614174000',
      window: '24h',
      window_start: '2026-06-01T10:00:00Z',
      window_end: '2026-06-02T10:00:00Z',
      attempt_count: 50,
      success_count: 48,
      failure_count: 2,
      success_rate: 0.96,
      p50_latency_ms: 30,
      p95_latency_ms: 110,
      last_failure_reason: '503 Service Unavailable',
      breaker_state: 'CLOSED',
    }
    expect(SubscriberDeliveryStatsSchema.safeParse(valid).success).toBe(true)
  })
})

describe('OpenAPI credential operations', () => {
  it('documents API key management with bearer authentication and the correct success responses', () => {
    const { paths } = generateOpenApiSpec()
    const operations = [
      [paths?.['/api/api-keys']?.get, '200'],
      [paths?.['/api/api-keys']?.post, '201'],
      [paths?.['/api/api-keys/{id}/rotate']?.post, '200'],
      [paths?.['/api/api-keys/{id}/revoke']?.post, '200'],
    ] as const

    for (const [operation, status] of operations) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
      expect(operation?.responses?.[status]).toBeDefined()
      expect(operation?.deprecated).toBe(true)
    }
    expect(paths?.['/api/v1/api-keys']?.get?.security).toEqual([{ bearerAuth: [] }])
    expect(paths?.['/api/v1/api-keys']?.post?.responses?.['201']).toBeDefined()
    expect(paths?.['/api/v1/api-keys/{id}/rotate']?.post?.responses?.['200']).toBeDefined()
    expect(paths?.['/api/v1/api-keys/{id}/revoke']?.post?.responses?.['200']).toBeDefined()

    const list = paths?.['/api/api-keys']?.get
    expect(list?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'limit', in: 'query' }),
      expect.objectContaining({ name: 'offset', in: 'query' }),
    ]))
    const revoke = paths?.['/api/api-keys/{id}/revoke']?.post
    expect(revoke?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
      expect.objectContaining({ name: 'X-Step-Up-Session-Id', in: 'header' }),
    ]))
    expect(revoke?.responses?.['401']).toMatchObject({
      content: { 'application/json': { schema: { anyOf: expect.any(Array) } } },
    })
  })

  describe('OpenAPI milestone and verification routes', () => {
    it('registers milestone lifecycle and verification operations with authentication', () => {
      const { paths } = generateOpenApiSpec()
      const operations = [
        [paths?.['/api/vaults/{vaultId}/milestones']?.post, '201'],
        [paths?.['/api/vaults/{vaultId}/milestones']?.get, '200'],
        [paths?.['/api/vaults/{vaultId}/milestones/{id}/verify']?.patch, '200'],
        [paths?.['/api/vaults/{vaultId}/milestones/{id}/validate']?.post, '200'],
        [paths?.['/api/vaults/{vaultId}/milestones/{id}/approve']?.post, '201'],
        [paths?.['/api/vaults/{vaultId}/milestones/{id}/approval-status']?.get, '200'],
        [paths?.['/api/verifications']?.post, '201'],
        [paths?.['/api/verifications']?.get, '200'],
        [paths?.['/api/verifications/bulk']?.post, '200'],
      ] as const

      for (const [operation, status] of operations) {
        expect(operation?.tags).toContain('Milestones')
        expect(operation?.security).toEqual([{ bearerAuth: [] }])
        expect(operation?.responses?.[status]).toBeDefined()
      }

      expect(paths?.['/api/vaults/{vaultId}/milestones']?.post?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'vaultId', in: 'path', required: true }),
          expect.objectContaining({ name: 'x-wallet-address', in: 'header', required: true }),
          expect.objectContaining({ name: 'x-network-id', in: 'header', required: true }),
        ]),
      )
      expect(paths?.['/api/vaults/{vaultId}/milestones/{id}/approve']?.post?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'id', in: 'path', required: true }),
        ]),
      )
    })
  })

  it('documents token exchange credentials and OAuth error fields', () => {
    const { paths } = generateOpenApiSpec()
    const token = paths?.['/api/oauth/token']?.post

    expect(token?.security).toEqual([])
    expect(token?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': {
          schema: { required: ['grant_type', 'client_id', 'client_secret'] },
        },
      },
    })
    expect(token?.responses?.['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { required: ['access_token', 'token_type', 'expires_in', 'scope'] },
        },
      },
    })
    expect(token?.responses?.['401']).toMatchObject({
      content: { 'application/json': { schema: { required: ['error', 'error_description'] } } },
    })
  })
})
