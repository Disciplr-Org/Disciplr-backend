import { describe, it, expect } from '@jest/globals'
import {
  ExportRequestSchema,
  ExportJobResponseSchema,
  ExportJobStatusSchema,
  WebhookSubscriptionSchema,
  CreateWebhookRequestSchema,
  CreateWebhookResponseSchema,
  WebhookDeadLetterSchema,
  FieldPolicySchema,
  AdminWebhookSubscriberSchema,
  EgressAllowlistEntrySchema,
  SubscriberDeliveryStatsSchema,
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
