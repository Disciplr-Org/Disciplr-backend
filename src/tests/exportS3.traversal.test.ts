import { describe, expect, it } from '@jest/globals'
import {
  sanitizeS3KeySegment,
  assertAllowedContentType,
  ALLOWED_CONTENT_TYPES,
  S3KeyTraversalError,
  S3ContentTypeError,
} from '../services/exportS3.js'

describe('sanitizeS3KeySegment', () => {
  it('passes through safe alphanumeric segments', () => {
    expect(sanitizeS3KeySegment('abc123')).toBe('abc123')
    expect(sanitizeS3KeySegment('job-id-uuid')).toBe('job-id-uuid')
    expect(sanitizeS3KeySegment('export-2030-01-01.csv')).toBe('export-2030-01-01.csv')
  })

  it('strips leading slashes', () => {
    expect(sanitizeS3KeySegment('/etc/passwd')).toBe('etc/passwd'.replace(/\//g, '-'))
    expect(sanitizeS3KeySegment('///foo')).toBe('foo')
  })

  it('throws on null byte', () => {
    expect(() => sanitizeS3KeySegment('foo\0bar')).toThrow(S3KeyTraversalError)
    expect(() => sanitizeS3KeySegment('\0')).toThrow(S3KeyTraversalError)
  })

  it('throws on ".." traversal segment', () => {
    expect(() => sanitizeS3KeySegment('../etc/passwd')).toThrow(S3KeyTraversalError)
    expect(() => sanitizeS3KeySegment('foo/../bar')).toThrow(S3KeyTraversalError)
    expect(() => sanitizeS3KeySegment('..')).toThrow(S3KeyTraversalError)
  })

  it('throws on single dot traversal segment', () => {
    expect(() => sanitizeS3KeySegment('.')).toThrow(S3KeyTraversalError)
    expect(() => sanitizeS3KeySegment('./foo')).toThrow(S3KeyTraversalError)
  })

  it('collapses embedded slashes into dashes', () => {
    expect(sanitizeS3KeySegment('foo/bar')).toBe('foo-bar')
    expect(sanitizeS3KeySegment('a/b/c')).toBe('a-b-c')
  })

  it('handles URL-encoded traversal (must not bypass)', () => {
    // The raw string should not itself contain ".." after decode — we operate on
    // the raw segment, so %2e%2e stays as-is and is safe (it's not "..")
    expect(sanitizeS3KeySegment('%2e%2e')).toBe('%2e%2e')
  })

  it('rejects traversal error message contains the offending component', () => {
    let message = ''
    try {
      sanitizeS3KeySegment('foo/../secret')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/traversal/)
  })
})

describe('assertAllowedContentType', () => {
  it('accepts all types in the allowlist', () => {
    for (const ct of ALLOWED_CONTENT_TYPES) {
      expect(() => assertAllowedContentType(ct)).not.toThrow()
    }
  })

  it('is case-insensitive', () => {
    expect(() => assertAllowedContentType('TEXT/CSV')).not.toThrow()
    expect(() => assertAllowedContentType('Application/JSON')).not.toThrow()
    expect(() => assertAllowedContentType('TEXT/CSV; CHARSET=UTF-8')).not.toThrow()
  })

  it('rejects HTML (XSS vector)', () => {
    expect(() => assertAllowedContentType('text/html')).toThrow(S3ContentTypeError)
    expect(() => assertAllowedContentType('text/html; charset=utf-8')).toThrow(S3ContentTypeError)
  })

  it('rejects executables', () => {
    expect(() => assertAllowedContentType('application/octet-stream')).toThrow(S3ContentTypeError)
    expect(() => assertAllowedContentType('application/x-msdownload')).toThrow(S3ContentTypeError)
    expect(() => assertAllowedContentType('application/x-executable')).toThrow(S3ContentTypeError)
  })

  it('rejects JavaScript', () => {
    expect(() => assertAllowedContentType('application/javascript')).toThrow(S3ContentTypeError)
    expect(() => assertAllowedContentType('text/javascript')).toThrow(S3ContentTypeError)
  })

  it('rejects XML', () => {
    expect(() => assertAllowedContentType('text/xml')).toThrow(S3ContentTypeError)
    expect(() => assertAllowedContentType('application/xml')).toThrow(S3ContentTypeError)
  })

  it('rejects empty string', () => {
    expect(() => assertAllowedContentType('')).toThrow(S3ContentTypeError)
  })

  it('error message includes the offending content type', () => {
    let message = ''
    try {
      assertAllowedContentType('text/html')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/text\/html/)
  })
})

describe('key traversal guard in export context', () => {
  it('safe job id and filename produce a tenant-prefixed key', () => {
    const jobId = sanitizeS3KeySegment('550e8400-e29b-41d4-a716-446655440000')
    const filename = sanitizeS3KeySegment('export-2030-01-01T00-00-00-000Z.csv')
    const key = `exports/${jobId}/${filename}`
    expect(key).toBe('exports/550e8400-e29b-41d4-a716-446655440000/export-2030-01-01T00-00-00-000Z.csv')
    expect(key.startsWith('exports/')).toBe(true)
  })

  it('traversal in job id is caught before key is built', () => {
    expect(() => sanitizeS3KeySegment('../other-tenant')).toThrow(S3KeyTraversalError)
  })

  it('traversal in filename is caught before key is built', () => {
    expect(() => sanitizeS3KeySegment('../../etc/passwd')).toThrow(S3KeyTraversalError)
  })

  it('leading slash in filename cannot escape the tenant prefix', () => {
    // Leading slashes are stripped, embedded slashes become dashes
    const filename = sanitizeS3KeySegment('/absolute/path/file.csv')
    expect(filename).toBe('absolute-path-file.csv')
    const key = `exports/job-id/${filename}`
    expect(key.startsWith('exports/job-id/')).toBe(true)
  })
})
