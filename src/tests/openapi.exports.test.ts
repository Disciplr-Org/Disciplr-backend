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
