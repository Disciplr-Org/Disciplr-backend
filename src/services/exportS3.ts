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

/**
 * Content types permitted for evidence and export uploads.
 * Executables, HTML (XSS vector when served directly), and other active content
 * are excluded. Extend this list only after a security review.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'text/csv',
  'text/csv; charset=utf-8',
  'application/json',
  'application/json; charset=utf-8',
  'application/x-ndjson',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

export class S3KeyTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3KeyTraversalError'
  }
}

export class S3ContentTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3ContentTypeError'
  }
}

/**
 * Sanitise a single user-supplied S3 key segment.
 *
 * Rules:
 * - Rejects null bytes (path confusion in some storage layers)
 * - Rejects segments that are or resolve to ".." (directory traversal)
 * - Strips leading slashes so the tenant prefix always dominates
 * - Collapses any embedded slash sequences to a single dash so the segment
 *   stays within its single path component
 *
 * @throws {S3KeyTraversalError} if the segment contains a traversal attempt.
 */
export function sanitizeS3KeySegment(segment: string): string {
  if (segment.includes('\0')) {
    throw new S3KeyTraversalError('S3 key segment contains a null byte')
  }

  // Strip leading slashes
  const stripped = segment.replace(/^\/+/, '')

  // Reject ".." traversal in any slash-delimited component
  const parts = stripped.split('/')
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new S3KeyTraversalError(`S3 key segment contains a traversal component: "${part}"`)
    }
  }

  // Collapse embedded slashes to a dash to keep it a single segment
  return stripped.replace(/\/+/g, '-')
}

/**
 * Assert that `contentType` is in the allowlist.
 *
 * @throws {S3ContentTypeError} if the content type is not permitted.
 */
export function assertAllowedContentType(contentType: string): void {
  // Normalise: lowercase and trim
  const normalised = contentType.toLowerCase().trim()
  if (!ALLOWED_CONTENT_TYPES.has(normalised)) {
    throw new S3ContentTypeError(`Content type not allowed: "${contentType}"`)
  }
}

export interface S3Config {
  bucket: string
  region: string
  signedUrlTtlSeconds: number
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
 *
 * @throws {S3ContentTypeError} if `contentType` is not in ALLOWED_CONTENT_TYPES.
 */
export async function uploadToS3(config: S3Config, key: string, data: Buffer | Readable, contentType: string): Promise<void> {
  assertAllowedContentType(contentType)
  const client = _clientFactory(config.region)
  const upload = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: data instanceof Buffer ? Readable.from(data) : data,
      ContentType: contentType,
      ContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    },
  })
  await upload.done()
}

/**
 * Return a pre-signed GET URL valid for `ttlSeconds`.
 */
export async function getExportSignedUrl(config: S3Config, key: string, overrideTtlSeconds?: number): Promise<string> {
  const client = _clientFactory(config.region)
  return _presigner(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
    expiresIn: overrideTtlSeconds ?? config.signedUrlTtlSeconds,
  })
}

