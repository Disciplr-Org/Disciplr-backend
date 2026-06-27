import { describe, expect, it } from 'bun:test'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gunzipSync } from 'node:zlib'
import {
  DEFAULT_NDJSON_EXPORT_CHUNK_ROWS,
  serializeExportData,
} from '../../services/exportQueue.js'

const MEMORY_CEILING_BYTES = 24 * 1024 * 1024

function makeVaultRows(rowCount: number) {
  return Array.from({ length: rowCount }, (_, index) => ({
    id: `vault-${index}`,
    creator: `user-${index % 17}`,
    amount: String(1000 + index),
    status: index % 3 === 0 ? 'completed' : 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    verifier: `verifier-${index % 11}`,
    successDestination: `success-${index}`,
    failureDestination: `failure-${index}`,
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
  }))
}

function ndjsonReadable(rowCount: number, chunkRows = DEFAULT_NDJSON_EXPORT_CHUNK_ROWS) {
  const { readable } = serializeExportData(
    { vaults: makeVaultRows(rowCount) },
    'ndjson',
    { ndjsonChunkRows: chunkRows },
  )

  if (!readable) {
    throw new Error('Expected ndjson export to return a readable stream')
  }

  return readable
}

async function collectBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

class SlowCountingSink extends Writable {
  bytes = 0
  peakHeapUsed = process.memoryUsage().heapUsed

  constructor(private readonly delayMs: number) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.bytes += chunk.length
    this.peakHeapUsed = Math.max(this.peakHeapUsed, process.memoryUsage().heapUsed)
    setTimeout(callback, this.delayMs)
  }
}

async function drainWithBackpressure(readable: NodeJS.ReadableStream, delayMs: number) {
  const startHeap = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  const sink = new SlowCountingSink(delayMs)

  await pipeline(readable, sink)

  return {
    bytes: sink.bytes,
    durationMs: performance.now() - startedAt,
    peakHeapDeltaBytes: Math.max(0, sink.peakHeapUsed - startHeap),
  }
}

describe('export NDJSON gzip streaming benchmark', () => {
  it('keeps memory bounded under a slow consumer', async () => {
    const result = await drainWithBackpressure(ndjsonReadable(8_000), 1)

    expect(result.bytes).toBeGreaterThan(0)
    expect(result.peakHeapDeltaBytes).toBeLessThan(MEMORY_CEILING_BYTES)
  })

  it('preserves gzip and NDJSON framing under chunking', async () => {
    const compressed = await collectBuffer(ndjsonReadable(513, 17))
    const text = gunzipSync(compressed).toString('utf8')
    const lines = text.trimEnd().split('\n')

    expect(lines).toHaveLength(513)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'vault-0' })
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ id: 'vault-512' })
    expect(text.endsWith('\n')).toBe(true)
  })

  it('measures throughput across chunk sizes and keeps the default competitive', async () => {
    const rowCount = 3_000
    const chunkSizes = [1, 64, DEFAULT_NDJSON_EXPORT_CHUNK_ROWS, 512]
    const results = []

    for (const chunkRows of chunkSizes) {
      const result = await drainWithBackpressure(ndjsonReadable(rowCount, chunkRows), 0)
      results.push({
        chunkRows,
        rowsPerSecond: rowCount / Math.max(result.durationMs / 1000, 0.001),
      })
    }

    const best = Math.max(...results.map((result) => result.rowsPerSecond))
    const defaultResult = results.find((result) => result.chunkRows === DEFAULT_NDJSON_EXPORT_CHUNK_ROWS)

    expect(defaultResult).toBeDefined()
    expect(defaultResult!.rowsPerSecond).toBeGreaterThan(0)
    expect(defaultResult!.rowsPerSecond).toBeGreaterThan(best * 0.35)
  })

  it('allows a slow client to abort mid-stream without completing the export body', async () => {
    const readable = ndjsonReadable(5_000, 16)
    let chunksSeen = 0
    let aborted = false

    try {
      for await (const _chunk of readable) {
        chunksSeen += 1
        if (chunksSeen === 2) {
          readable.destroy(new Error('client aborted'))
        }
      }
    } catch (error) {
      aborted = error instanceof Error && error.message === 'client aborted'
    }

    expect(chunksSeen).toBeGreaterThan(0)
    expect(aborted).toBe(true)
  })
})
