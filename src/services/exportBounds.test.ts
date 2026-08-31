import { describe, expect, it, beforeEach } from '@jest/globals'
import { Writable } from 'node:stream'
import {
  EXPORT_BOUNDS,
  ExportRequestGate,
  isWithinByteLimit,
  streamExportBuffer,
} from './exportBounds.js'

describe('ExportRequestGate', () => {
  let gate: ExportRequestGate

  beforeEach(() => {
    gate = new ExportRequestGate()
  })

  it('admits requests up to the configured concurrency bound', () => {
    expect(gate.tryAcquire('org-a')).toBe(true)
    expect(gate.tryAcquire('org-a')).toBe(true)
    expect(gate.tryAcquire('org-a')).toBe(false)
    expect(gate.active('org-a')).toBe(EXPORT_BOUNDS.MAX_CONCURRENT_REQUESTS_PER_ORG)
  })

  it('isolates concurrency between organizations', () => {
    expect(gate.tryAcquire('org-a')).toBe(true)
    expect(gate.tryAcquire('org-a')).toBe(true)
    expect(gate.tryAcquire('org-b')).toBe(true)
    expect(gate.active('org-a')).toBe(2)
    expect(gate.active('org-b')).toBe(1)
  })

  it('release is idempotent at zero and allows recovery', () => {
    gate.release('missing')
    expect(gate.active('org-a')).toBe(0)

    expect(gate.tryAcquire('org-a')).toBe(true)
    expect(gate.tryAcquire('org-a')).toBe(true)
    gate.release('org-a')
    expect(gate.active('org-a')).toBe(1)
    expect(gate.tryAcquire('org-a')).toBe(true)
  })

  it('supports explicit limits for adversarial boundary tests', () => {
    expect(gate.tryAcquire('org-a', 0)).toBe(false)
    expect(gate.tryAcquire('org-a', 1)).toBe(true)
    expect(gate.tryAcquire('org-a', 1)).toBe(false)
  })
})

describe('export input byte bounds', () => {
  it('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(isWithinByteLimit('a'.repeat(16), 16)).toBe(true)
    expect(isWithinByteLimit('€'.repeat(6), 16)).toBe(false)
  })
})

describe('streamExportBuffer', () => {
  it('writes the complete payload in bounded chunks', async () => {
    const payload = Buffer.from('abcdefghij')
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })

    streamExportBuffer(sink, payload, 3)
    await new Promise<void>((resolve, reject) => {
      sink.once('finish', resolve)
      sink.once('error', reject)
    })

    expect(chunks.map(chunk => chunk.length)).toEqual([3, 3, 3, 1])
    expect(Buffer.concat(chunks)).toEqual(payload)
  })

  it('rejects invalid chunk sizes', () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    expect(() => streamExportBuffer(sink, Buffer.from('x'), 0)).toThrow(RangeError)
    expect(() => streamExportBuffer(sink, Buffer.from('x'), 1.5)).toThrow(RangeError)
  })
})
