/**
 * S3 upload and signed-URL helpers for completed export jobs.
 *
 * S3 mode is enabled when both EXPORT_S3_BUCKET and EXPORT_S3_REGION are set.
 * When disabled, the upload function is a no-op and callers fall back to the
 * local buffer already stored on the job.
 */
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

export interface S3Config {
  bucket: string
  region: string
  signedUrlTtlSeconds: number
}

export class S3ObjectValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3ObjectValidationError'
  }
}

const ALLOWED_OBJECT_STORAGE_CONTENT_TYPES = new Set([
  'application/gzip',
  'application/json',
  'application/pdf',
  'application/x-ndjson',
  'image/jpeg',
  'image/png',
  'text/csv',
  'text/plain',
])

const RESPONSE_CONTENT_TYPE_QUERY_PARAMS = [
  'response-content-type',
  'ResponseContentType',
  'responseContentType',
]

function decodeObjectKey(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    throw new S3ObjectValidationError('S3 object key contains invalid percent-encoding')
  }
}

function validateDecodedObjectKey(decodedKey: string): void {
  if (decodedKey.length === 0) {
    throw new S3ObjectValidationError('S3 object key must not be empty')
  }

  if (decodedKey.startsWith('/')) {
    throw new S3ObjectValidationError('S3 object key must not start with a slash')
  }

  if (decodedKey.includes('\\')) {
    throw new S3ObjectValidationError('S3 object key must not contain backslashes')
  }

  const segments = decodedKey.split('/')
  for (const segment of segments) {
    if (segment === '') {
      throw new S3ObjectValidationError('S3 object key must not contain empty path segments')
    }

    if (segment === '.' || segment === '..') {
      throw new S3ObjectValidationError('S3 object key must not contain dot path segments')
    }

    if (segment.includes('\0')) {
      throw new S3ObjectValidationError('S3 object key segment must not contain null bytes')
    }

    if (/[\r\n]/.test(segment)) {
      throw new S3ObjectValidationError('S3 object key segment must not contain line breaks')
    }
  }
}

function extractRawUrlPath(referenceUrl: string): string | undefined {
  const schemeIndex = referenceUrl.indexOf('://')
  if (schemeIndex === -1) return undefined

  const authorityStart = schemeIndex + 3
  const pathStart = referenceUrl.indexOf('/', authorityStart)
  if (pathStart === -1) return ''

  const pathAndLater = referenceUrl.slice(pathStart)
  const pathEnd = pathAndLater.search(/[?#]/)
  return pathEnd === -1 ? pathAndLater : pathAndLater.slice(0, pathEnd)
}

function contentDispositionFilename(key: string): string {
  const finalSegment = key.split('/').pop() ?? 'download'
  return finalSegment.replace(/["\\]/g, '_')
}

export function validateS3ObjectKey(key: string): string {
  if (typeof key !== 'string') {
    throw new S3ObjectValidationError('S3 object key must be a string')
  }

  const normalizedKey = key.trim()
  if (normalizedKey.length === 0) {
    throw new S3ObjectValidationError('S3 object key must not be empty')
  }

  if (normalizedKey.startsWith('/')) {
    throw new S3ObjectValidationError('S3 object key must not start with a slash')
  }

  if (/^[A-Za-z]:[\\/]/.test(normalizedKey)) {
    throw new S3ObjectValidationError('S3 object key must not be an absolute filesystem path')
  }

  validateDecodedObjectKey(decodeObjectKey(normalizedKey))
  return normalizedKey
}

export function sanitizeS3KeySegment(segment: string, label = 'S3 object key segment'): string {
  if (typeof segment !== 'string') {
    throw new S3ObjectValidationError(`${label} must be a string`)
  }

  const normalizedSegment = segment.trim()
  if (normalizedSegment.length === 0) {
    throw new S3ObjectValidationError(`${label} must not be empty`)
  }

  const decodedSegment = decodeObjectKey(normalizedSegment)
  if (
    decodedSegment === '.'
    || decodedSegment === '..'
    || decodedSegment.includes('/')
    || decodedSegment.includes('\\')
    || decodedSegment.includes('\0')
    || /[\r\n]/.test(decodedSegment)
  ) {
    throw new S3ObjectValidationError(`${label} contains an unsafe path segment`)
  }

  return normalizedSegment
}

export function buildExportS3Key(userId: string, jobId: string, filename: string): string {
  return validateS3ObjectKey([
    'exports',
    sanitizeS3KeySegment(userId, 'export owner id'),
    sanitizeS3KeySegment(jobId, 'export job id'),
    sanitizeS3KeySegment(filename, 'export filename'),
  ].join('/'))
}

export function assertAllowedS3ContentType(contentType: string): string {
  if (typeof contentType !== 'string') {
    throw new S3ObjectValidationError('S3 object content type must be a string')
  }

  const normalizedContentType = contentType.trim()
  if (normalizedContentType.length === 0) {
    throw new S3ObjectValidationError('S3 object content type must not be empty')
  }

  if (/[\0\r\n]/.test(normalizedContentType)) {
    throw new S3ObjectValidationError('S3 object content type contains unsafe control characters')
  }

  const baseContentType = normalizedContentType.split(';', 1)[0].trim().toLowerCase()
  if (!ALLOWED_OBJECT_STORAGE_CONTENT_TYPES.has(baseContentType)) {
    throw new S3ObjectValidationError(`S3 object content type is not allowed: ${baseContentType}`)
  }

  return normalizedContentType
}

export function validateObjectStorageUrlPath(referenceUrl: string): void {
  let url: URL
  try {
    url = new URL(referenceUrl)
  } catch {
    throw new S3ObjectValidationError('Object-storage URL must be a valid URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new S3ObjectValidationError('Object-storage URL must use http or https')
  }

  const rawPath = extractRawUrlPath(referenceUrl) ?? url.pathname
  if (rawPath === '' || rawPath === '/') {
    throw new S3ObjectValidationError('Object-storage URL path must include an object key')
  }

  if (rawPath.startsWith('//')) {
    throw new S3ObjectValidationError('Object-storage URL path must not start with an empty segment')
  }

  validateS3ObjectKey(rawPath.startsWith('/') ? rawPath.slice(1) : rawPath)
}

export function validateObjectStorageResponseContentType(referenceUrl: string): void {
  let url: URL
  try {
    url = new URL(referenceUrl)
  } catch {
    throw new S3ObjectValidationError('Object-storage URL must be a valid URL')
  }

  const responseContentType = RESPONSE_CONTENT_TYPE_QUERY_PARAMS
    .map((param) => url.searchParams.get(param))
    .find((value): value is string => typeof value === 'string' && value.trim() !== '')

  if (responseContentType) {
    assertAllowedS3ContentType(responseContentType)
  }
}

/** Resolve S3 config from environment.  Returns undefined when not configured. */
export function resolveS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | undefined {
  const bucket = env.EXPORT_S3_BUCKET
  const region = env.EXPORT_S3_REGION
  if (!bucket || !region) return undefined
  const ttl = Number.parseInt(env.EXPORT_SIGNED_URL_TTL_S ?? '3600', 10)
  return { bucket, region, signedUrlTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 3600 }
}

/** Overridable factory – replaced in tests to inject a stub client. */
let _clientFactory: (region: string) => S3Client = (region) => new S3Client({ region } satisfies S3ClientConfig)

export function setS3ClientFactory(factory: (region: string) => S3Client): void {
  _clientFactory = factory
}

export function resetS3ClientFactory(): void {
  _clientFactory = (region) => new S3Client({ region })
}

type Presigner = (client: S3Client, command: GetObjectCommand, options: { expiresIn: number }) => Promise<string>

/** Overridable presigner – replaced in tests to avoid real AWS SDK signing. */
let _presigner: Presigner = (client, command, options) => getSignedUrl(client, command, options)

export function setPresigner(presigner: Presigner): void {
  _presigner = presigner
}

export function resetPresigner(): void {
  _presigner = (client, command, options) => getSignedUrl(client, command, options)
}

/**
 * Stream-upload `buffer` to S3 under `key`.
 * Uses @aws-sdk/lib-storage for multipart-safe, streaming uploads.
 */
export async function uploadToS3(config: S3Config, key: string, data: Buffer | Readable, contentType: string): Promise<void> {
  const safeKey = validateS3ObjectKey(key)
  const safeContentType = assertAllowedS3ContentType(contentType)
  const client = _clientFactory(config.region)
  const upload = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: safeKey,
      Body: data instanceof Buffer ? Readable.from(data) : data,
      ContentType: safeContentType,
      ContentDisposition: `attachment; filename="${contentDispositionFilename(safeKey)}"`,
    },
  })
  await upload.done()
}

/**
 * Return a pre-signed GET URL valid for `ttlSeconds`.
 */
export async function getExportSignedUrl(config: S3Config, key: string): Promise<string> {
  const safeKey = validateS3ObjectKey(key)
  const client = _clientFactory(config.region)
  return _presigner(client, new GetObjectCommand({ Bucket: config.bucket, Key: safeKey }), {
    expiresIn: config.signedUrlTtlSeconds,
  })
}
