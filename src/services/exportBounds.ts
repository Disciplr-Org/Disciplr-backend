import { Readable } from 'node:stream'

export const EXPORT_BOUNDS = {
  MAX_COLUMN_FILTER_BYTES: 16 * 1024,
  MAX_COLUMNS_PER_SECTION: 25,
  DOWNLOAD_CHUNK_BYTES: 512 * 1024,
  MAX_CONCURRENT_REQUESTS_PER_ORG: 2,
  CONCURRENCY_RETRY_AFTER_SECONDS: 1,
} as const

export class ExportRequestGate {
  private readonly activeRequests = new Map<string, number>()

  tryAcquire(key: string, limit = EXPORT_BOUNDS.MAX_CONCURRENT_REQUESTS_PER_ORG): boolean {
    const active = this.activeRequests.get(key) ?? 0
    if (active >= limit) return false
    this.activeRequests.set(key, active + 1)
    return true
  }

  release(key: string): void {
    const active = this.activeRequests.get(key) ?? 0
    if (active <= 1) {
      this.activeRequests.delete(key)
      return
    }
    this.activeRequests.set(key, active - 1)
  }

  active(key: string): number {
    return this.activeRequests.get(key) ?? 0
  }

  reset(): void {
    this.activeRequests.clear()
  }
}

export const exportRequestGate = new ExportRequestGate()

export const streamExportBuffer = (
  res: NodeJS.WritableStream & { send?: (body: Buffer) => unknown },
  buffer: Buffer,
  chunkSize = EXPORT_BOUNDS.DOWNLOAD_CHUNK_BYTES,
): void => {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive integer')
  }

  if (typeof res.write !== 'function') {
    if (typeof res.send === 'function') {
      res.send(buffer)
      return
    }
    throw new TypeError('response must support write() or send()')
  }

  function* chunks(): Generator<Buffer> {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length))
    }
  }

  Readable.from(chunks()).pipe(res)
}

export const isWithinByteLimit = (value: string, maxBytes: number): boolean =>
  Buffer.byteLength(value, 'utf8') <= maxBytes
