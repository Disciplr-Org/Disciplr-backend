import { Readable } from 'node:stream'

export const EXPORT_BOUNDS = {
  MAX_COLUMN_FILTER_BYTES: 16 * 1024,
  MAX_COLUMNS_PER_SECTION: 25,
  DOWNLOAD_CHUNK_BYTES: 512 * 1024,
  MAX_CONCURRENT_REQUESTS_PER_ORG: 2,
  CONCURRENCY_RETRY_AFTER_SECONDS: 1,
} as const

/**
 * Process-local admission gate for export creation requests.
 *
 * The daily quota remains the authoritative cross-process limit. This gate is
 * deliberately smaller and short-lived: it protects the HTTP boundary from a
 * burst of simultaneous enqueue work without pretending to be a distributed
 * concurrency controller.
 */
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

/**
 * Stream an already-materialized export without handing the whole Buffer to
 * Express in one write. Readable handles backpressure and the generator keeps
 * only one bounded chunk live at a time.
 */
export const streamExportBuffer = (
  res: NodeJS.WritableStream,
  buffer: Buffer,
  chunkSize = EXPORT_BOUNDS.DOWNLOAD_CHUNK_BYTES,
): void => {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive integer')
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
