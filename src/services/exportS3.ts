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

