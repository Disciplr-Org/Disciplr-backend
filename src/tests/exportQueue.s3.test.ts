import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals'
import type { S3Client } from '@aws-sdk/client-s3'
import {
  resolveS3Config,
  setS3ClientFactory,
  resetS3ClientFactory,
  uploadToS3,
  getExportSignedUrl,
  setPresigner,
  resetPresigner,
} from '../services/exportS3.js'
import {
  createJob,
  processJob,
  resetExportJobs,
} from '../services/exportQueue.js'

describe('Export S3 integration', () => {
  const mockSend = jest.fn()
  const mockPresign = jest.fn()

  const stubS3Client = (): S3Client => {
    const client = {
      send: mockSend,
      config: {
        requestHandler: { metadata: { handlerProtocol: 'h2' } },
        endpointProvider: jest.fn().mockResolvedValue({ url: new URL('https://s3.us-east-1.amazonaws.com') }),
        region: async () => 'us-east-1',
        credentials: async () => ({
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        }),
        signerConstructor: jest.fn(),
        systemClockOffset: 0,
      },
      middlewareStack: {
        clone: jest.fn().mockReturnThis(),
        use: jest.fn(),
        concat: jest.fn(),
        applyToStack: jest.fn(),
        identify: jest.fn(),
        identifyOnResolve: jest.fn(),
        resolve: jest.fn(),
        addRelativeTo: jest.fn(),
      },
    }
    return client as unknown as S3Client
  }

  beforeEach(() => {
    mockSend.mockClear()
    mockPresign.mockClear()
    resetS3ClientFactory()
    resetPresigner()
  })

  afterEach(async () => {
    await resetExportJobs()
    resetS3ClientFactory()
    resetPresigner()
  })

  it('resolves S3 config when both bucket and region are set', () => {
    const config = resolveS3Config({
      EXPORT_S3_BUCKET: 'export-bucket',
      EXPORT_S3_REGION: 'us-east-1',
      EXPORT_SIGNED_URL_TTL_S: '7200',
    })

    expect(config).toEqual({
      bucket: 'export-bucket',
      region: 'us-east-1',
      signedUrlTtlSeconds: 7200,
    })
  })

  it('returns undefined when bucket or region is missing', () => {
    expect(resolveS3Config({ EXPORT_S3_BUCKET: 'bucket' })).toBeUndefined()
    expect(resolveS3Config({ EXPORT_S3_REGION: 'region' })).toBeUndefined()
    expect(resolveS3Config({})).toBeUndefined()
  })

  it('defaults TTL to 3600 when invalid or missing', () => {
    const config = resolveS3Config({
      EXPORT_S3_BUCKET: 'bucket',
      EXPORT_S3_REGION: 'region',
      EXPORT_SIGNED_URL_TTL_S: 'invalid',
    })

    expect(config?.signedUrlTtlSeconds).toBe(3600)
  })

  it('uploads to S3 with streaming multipart upload', async () => {
    setS3ClientFactory(stubS3Client)

    mockSend.mockResolvedValueOnce({ ETag: '"abc123"' })

    const buffer = Buffer.from('test csv content', 'utf8')
    await uploadToS3(
      { bucket: 'export-bucket', region: 'us-east-1', signedUrlTtlSeconds: 3600 },
      'exports/job-1/export.csv',
      buffer,
      'text/csv; charset=utf-8',
    )

    expect(mockSend).toHaveBeenCalledTimes(1)
    const uploadCommand = mockSend.mock.calls[0][0]
    expect(uploadCommand.input.Bucket).toBe('export-bucket')
    expect(uploadCommand.input.Key).toBe('exports/job-1/export.csv')
    expect(uploadCommand.input.ContentType).toBe('text/csv; charset=utf-8')
    expect(uploadCommand.input.ContentDisposition).toContain('export.csv')
  })

  it('generates signed URLs for S3 objects', async () => {
    const expectedUrl = 'https://export-bucket.s3.us-east-1.amazonaws.com/exports/job-1/export.csv?X-Amz-Signature=deadbeef'
    mockPresign.mockResolvedValue(expectedUrl)
    setPresigner(mockPresign as any)

    const url = await getExportSignedUrl(
      { bucket: 'export-bucket', region: 'us-east-1', signedUrlTtlSeconds: 1800 },
      'exports/job-1/export.csv',
    )

    expect(url).toBe(expectedUrl)
    expect(mockPresign).toHaveBeenCalledTimes(1)
    const [, command, options] = mockPresign.mock.calls[0] as [unknown, { input: unknown }, { expiresIn: number }]
    expect((command as any).input.Bucket).toBe('export-bucket')
    expect((command as any).input.Key).toBe('exports/job-1/export.csv')
    expect(options.expiresIn).toBe(1800)
  })

  it('stores s3Key and clears result buffer when S3 is configured', async () => {
    setS3ClientFactory(stubS3Client)
    mockSend.mockResolvedValue({ ETag: '"abc"' })

    const originalEnv = { ...process.env }
    process.env.EXPORT_S3_BUCKET = 'test-bucket'
    process.env.EXPORT_S3_REGION = 'us-west-2'

    const job = await createJob({
      userId: 'user-s3',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-s3',
    })

    await processJob(job.id, [
      {
        id: 'vault-s3',
        creator: 'user-s3',
        amount: '100',
        status: 'active',
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    ])

    const completed = await import('../services/exportQueue.js').then((m) => m.getJob(job.id))

    expect(completed?.status).toBe('done')
    expect(completed?.s3Key).toMatch(/^exports\/[a-f0-9-]+\/export-.*\.csv$/)
    expect(completed?.result).toBeUndefined()
    expect(completed?.filename).toContain('.csv')

    process.env = originalEnv
  })

  it('stores result buffer locally when S3 is not configured', async () => {
    const job = await createJob({
      userId: 'user-local',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-local',
    })

    await processJob(job.id, [
      {
        id: 'vault-local',
        creator: 'user-local',
        amount: '200',
        status: 'completed',
        createdAt: '2030-02-01T00:00:00.000Z',
      },
    ])

    const completed = await import('../services/exportQueue.js').then((m) => m.getJob(job.id))

    expect(completed?.status).toBe('done')
    expect(completed?.result).toBeInstanceOf(Buffer)
    expect(completed?.s3Key).toBeUndefined()
    expect(completed?.filename).toContain('.json')
  })
})
