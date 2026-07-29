import { ExportRequestSchema, ExportJobResponseSchema, ExportJobStatusSchema } from '../docs/openapi-generator.js'

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
