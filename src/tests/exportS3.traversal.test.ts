import { afterEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
  assertAllowedS3ContentType,
  buildExportS3Key,
  resetS3ClientFactory,
  S3ObjectValidationError,
  setS3ClientFactory,
  uploadToS3,
  validateObjectStorageResponseContentType,
  validateObjectStorageUrlPath,
  validateS3ObjectKey,
} from '../services/exportS3.js'
import {
  EvidenceReferenceValidationError,
  validateSignedObjectStorageUrl,
} from '../services/evidence.js'

describe('S3 object key traversal and content-type guards', () => {
  afterEach(() => {
    resetS3ClientFactory()
  })

  it('builds tenant-prefixed export keys from safe segments', () => {
    expect(buildExportS3Key('user-123', 'job-456', 'export-2026.csv'))
      .toBe('exports/user-123/job-456/export-2026.csv')
  })

  it('rejects object keys with traversal, absolute paths, null bytes, or empty segments', () => {
    const invalidKeys = [
      '/exports/user/job/export.csv',
      'exports/user/../export.csv',
      'exports/user/%2e%2e/export.csv',
      'exports/user//export.csv',
      'exports/user\\job\\export.csv',
      'exports/user/job/export.csv\0',
      'C:\\exports\\user\\export.csv',
    ]

    for (const key of invalidKeys) {
      expect(() => validateS3ObjectKey(key)).toThrow(S3ObjectValidationError)
    }
  })

  it('accepts generated export content types and rejects browser-executable types', () => {
    expect(assertAllowedS3ContentType('text/csv; charset=utf-8')).toBe('text/csv; charset=utf-8')
    expect(assertAllowedS3ContentType('application/json; charset=utf-8')).toBe('application/json; charset=utf-8')
    expect(assertAllowedS3ContentType('application/x-ndjson')).toBe('application/x-ndjson')

    for (const contentType of ['text/html', 'application/javascript', 'application/x-msdownload', 'application/octet-stream']) {
      expect(() => assertAllowedS3ContentType(contentType)).toThrow(S3ObjectValidationError)
    }
  })

  it('validates object-storage URL paths before evidence references are accepted', () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600
    expect(() => validateObjectStorageUrlPath(`https://bucket.s3.amazonaws.com/org%2Forg-1%2Fevidence.pdf?Expires=${expiry}`))
      .not.toThrow()

    for (const url of [
      `https://bucket.s3.amazonaws.com/evidence/../secret.pdf?Expires=${expiry}`,
      `https://bucket.s3.amazonaws.com/evidence/%2e%2e/secret.pdf?Expires=${expiry}`,
      `https://bucket.s3.amazonaws.com//secret.pdf?Expires=${expiry}`,
      `https://bucket.s3.amazonaws.com/evidence/%00/secret.pdf?Expires=${expiry}`,
    ]) {
      expect(() => validateObjectStorageUrlPath(url)).toThrow(S3ObjectValidationError)
    }
  })

  it('enforces signed URL response content-type overrides when present', () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600
    expect(() => validateObjectStorageResponseContentType(
      `https://bucket.s3.amazonaws.com/evidence.pdf?Expires=${expiry}&response-content-type=application%2Fpdf`,
    )).not.toThrow()

    expect(() => validateObjectStorageResponseContentType(
      `https://bucket.s3.amazonaws.com/evidence.pdf?Expires=${expiry}&response-content-type=text%2Fhtml`,
    )).toThrow(S3ObjectValidationError)
  })

  it('wraps evidence signed URL storage-key violations in evidence validation errors', () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const validUrl = `https://storage.example.test/evidence.pdf?Expires=${expiry}&signature=valid123`
    expect(validateSignedObjectStorageUrl(validUrl).getTime()).toBeGreaterThan(Date.now())

    expect(() => validateSignedObjectStorageUrl(
      `https://storage.example.test/evidence/%2e%2e/secret.pdf?Expires=${expiry}&signature=valid123`,
    )).toThrow(EvidenceReferenceValidationError)

    expect(() => validateSignedObjectStorageUrl(
      `https://storage.example.test/evidence.pdf?Expires=${expiry}&response-content-type=text%2Fhtml`,
    )).toThrow(EvidenceReferenceValidationError)
  })

  it('rejects unsafe upload inputs before constructing an S3 client', async () => {
    let clientFactoryCalled = false
    setS3ClientFactory(() => {
      clientFactoryCalled = true
      throw new Error('client factory should not run for invalid input')
    })

    try {
      await uploadToS3(
        { bucket: 'exports', region: 'us-east-1', signedUrlTtlSeconds: 3600 },
        'exports/user-123/job-456/export.csv',
        Buffer.from('test', 'utf8'),
        'text/html',
      )
      throw new Error('expected uploadToS3 to reject unsafe content type')
    } catch (error) {
      expect(error).toBeInstanceOf(S3ObjectValidationError)
    }

    expect(clientFactoryCalled).toBe(false)
  })
})
