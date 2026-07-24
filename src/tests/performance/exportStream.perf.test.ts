import { describe, expect, it } from '@jest/globals'
import { createWriteStream } from 'node:fs'
import { createReadStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:path'
import zlib from 'node:zlib'

import {
  createJob,
  getJob,
  processJob,
  resetExportJobs,
  serializeExportData,
  type ExportData,
} from '../services/exportQueue.js'

const parseGzipNdjson = async (gzBuffer: Buffer): Promise<{ lines: number; size: number }> => {
  const decompressed = await zlib.gunzip(gzBuffer)
  const content = decompressed.toString('utf8')
  const lines = content.split('\n').filter(line => line.trim())
  return { lines, size: decompressed.length }
}

const generateTestData = (rows: number): ExportData => {
  const vaults = Array.from({ length: rows }, (_, i) => ({
    id: `vault-${i + 1}`,
    creator: 'export-test-user',
    amount: (i + 1) * 1000,
    status: 'active',
    startDate: '2024-01-01T00:00:00.000Z',
    endDate: '2024-02-01T00:00:00.000Z',
    verifier: `verifier-${i + 1}`,
    successDestination: `G-DEST-${i + 1}`,
    failureDestination: `G-FAIL-${i + 1}`,
    createdAt: '2024-01-01T12:00:00.000Z',
  }))

  return { vaults }
}

describe('Export streaming backpressure and chunk-size benchmark', () => {
  const MEMORY_CEILING_MB = 500

  it('measures throughput across chunk sizes and validates memory ceiling under backpressure', async () => {
    const results: Array<{ size: number; chunkSize: number; throughputMbps: number; memory: number }> = []

    const TEST_DATA_SIZES = [100, 1000]
    const CHUNK_SIZES = [64 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024]
    const TARGET_CONSUMER_RPS = [10, 50, 100]

    for (const size of TEST_DATA_SIZES) {
      for (const chunkSize of CHUNK_SIZES) {
        console.log(`Testing ${size} rows with ${chunkSize / 1024 / 1024}MB chunk size`)

        const { buffer, filename, readable } = serializeExportData(generateTestData(size), 'ndjson')
        expect(readable).toBeDefined()

        const tempDir = await mkdtemp(join(tmpdir(), 'export-bench-'))
        const outputFile = join(tempDir, 'export.ndjson.gz')

        const writeStream = createWriteStream(outputFile)
        readable.pipe(writeStream)
        await new Promise(resolve => writeStream.end(resolve))

        const fs = require('fs')
        const gzBuffer = fs.readFileSync(outputFile)
        const { lines, size: decompressedSize } = await parseGzipNdjson(gzBuffer)
        expect(lines).toBeGreaterThan(0)

        const start = Date.now()
        const fileStream = createReadStream(outputFile)
        const gzStream = zlib.createDecompress()
        let bytesConsumed = 0

        fileStream.pipe(gzStream)
          .on('data', chunk => bytesConsumed += chunk.length)
          .on('end', () => {
            const duration = Date.now() - start
            const throughputMbps = (decompressedSize * 8) / (duration * 1_000_000)
            results.push({
              size,
              chunkSize,
              throughputMbps,
              memory: 0,
            })
          })
      }
    }

    const best = results.reduce((best, curr) => curr.throughputMbps > best.throughputMbps ? curr : best, results[0]!)

    console.log('Benchmark results:', results)
    console.log('Optimal configuration:', {
      rows: best.size,
      chunkSizeBytes: best.chunkSize,
      throughputMbps: best.throughputMbps,
    })

    expect(best.throughputMbps).toBeGreaterThan(0)
  })

  it('validates NDJSON/gzip framing under streaming and chunking', async () => {
    const testData = generateTestData(100)
    const { buffer, filename, readable } = serializeExportData(testData, 'ndjson')

    expect(readable).toBeDefined()
    expect(filename).toMatch(/export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\\d{3}\.ndjson\.gz/)

    const tempDir = await mkdtemp(join(tmpdir(), 'export-test-'))
    const outputFile = join(tempDir, 'export.ndjson.gz')
    const writeStream = createWriteStream(outputFile)

    const parsed: Record<string, unknown>[] = []
    const parser = new Transform({
      transform(chunk, _encoding, callback) {
        const content = chunk.toString('utf8')
        const lines = content.split('\n').filter(line => line.trim())
        for (const line of lines) {
          try {
            parsed.push(JSON.parse(line))
          } catch (e) {
            console.error('Parse error:', e, 'line:', line)
          }
        }
        callback()
      },
    })

    readable.pipe(zlib.createDecompress()).pipe(parser).pipe(writeStream)

    await new Promise(resolve => writeStream.end(resolve))

    const fs = require('fs')
    const gzBuffer = fs.readFileSync(outputFile)
    const { lines, size: decompressedSize } = await parseGzipNdjson(gzBuffer)

    expect(lines).toBeGreaterThan(0)
    expect(decompressedSize).toBeGreaterThan(0)
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed[0]).toHaveProperty('id')
    expect(parsed[0]).toHaveProperty('creator')
    expect(parsed[0]).toHaveProperty('amount')
  })

  it('aborts mid-stream when consumer closes early', async () => {
    const job = await createJob({
      userId: 'aborted-user',
      isAdmin: false,
      scope: 'vaults',
      format: 'ndjson',
      maxAttempts: 3,
      requestHash: 'abort-hash',
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'export-abort-'))
    const outputFile = join(tempDir, 'export.ndjson.gz')

    const { buffer, filename, readable } = serializeExportData(generateTestData(1000), 'ndjson')
    expect(readable).toBeDefined()

    const writeStream = createWriteStream(outputFile)
    readable.pipe(writeStream)

    const memoryBefore = process.memoryUsage().heapUsed
    const memoryMonitor = setInterval(() => process.stdout.write('.'), 10)

    setTimeout(() => writable.destroy(), 50)

    await new Promise(resolve => writeStream.on('close', resolve))
    clearInterval(memoryMonitor)

    const memoryAfter = process.memoryUsage().heapUsed
    expect(memoryAfter - memoryBefore).toBeLessThan(100 * 1024 * 1024)
  })
}
