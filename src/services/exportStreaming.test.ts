/* global describe, test, expect */
import { Buffer } from 'node:buffer'
import type { Readable as NodeReadable } from 'node:stream'
import { createStreamingExportReadable } from './exportQueue.js'

const vault = (id: string, amount: string) => ({
  id,
  creator: 'user-1',
  amount,
  status: 'active',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-02-01T00:00:00.000Z',
  verifier: 'GVERIFIER',
  successDestination: 'GSUCCESS',
  failureDestination: 'GFAILURE',
  createdAt: '2030-01-01T12:00:00.000Z',
})

const readStream = async (stream: NodeReadable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describe('bounded export streams', () => {
  test('emits an empty CSV with no fabricated rows', async () => {
    const { readable, filename } = createStreamingExportReadable({ vaults: [] }, 'csv')
    const output = (await readStream(readable)).toString('utf8')

    expect(filename).toMatch(/^export-.*\.csv$/)
    expect(output.startsWith('\uFEFF')).toBe(true)
    expect(output).not.toContain('# VAULTS')
  })

  test('emits stable section and row ordering', async () => {
    const { readable } = createStreamingExportReadable({
      analytics: [{ userId: 'user-1', totalVaults: 2 }],
      transactions: [{ id: 'tx-1', amount: '900719925474099312345' }],
      vaults: [vault('v-1', '10'), vault('v-2', '20')],
    }, 'csv')
    const output = (await readStream(readable)).toString('utf8')

    expect(output.indexOf('# VAULTS')).toBeLessThan(output.indexOf('# TRANSACTIONS'))
    expect(output.indexOf('# TRANSACTIONS')).toBeLessThan(output.indexOf('# ANALYTICS'))
    expect(output.indexOf('v-1')).toBeLessThan(output.indexOf('v-2'))
  })

  test('preserves exact amount strings in CSV output', async () => {
    const exact = '900719925474099312345678901234567890'
    const { readable } = createStreamingExportReadable({ vaults: [vault('v-precision', exact)] }, 'csv')
    const output = (await readStream(readable)).toString('utf8')

    expect(output).toContain(exact)
    expect(output).not.toContain('9.007199254740993e+')
  })

  test('preserves exact amount strings in NDJSON output', async () => {
    const exact = '900719925474099312345678901234567890'
    const { readable, filename } = createStreamingExportReadable({
      transactions: [{ id: 'tx-precision', amount: exact }],
    }, 'ndjson')
    const output = await readStream(readable)
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      import('node:zlib').then(({ gunzip }) => gunzip(output, (error, value) => error ? reject(error) : resolve(value)))
    })

    expect(filename).toMatch(/^export-.*\.ndjson\.gz$/)
    expect(decompressed.toString('utf8')).toContain(`"amount":"${exact}"`)
  })

  test('applies column allowlists without materializing a second output buffer', async () => {
    const { readable } = createStreamingExportReadable({ vaults: [vault('v-filtered', '42')] }, 'csv', {
      vaults: ['id', 'amount'],
      transactions: [],
      analytics: [],
    })
    const output = (await readStream(readable)).toString('utf8')

    expect(output).toContain('id,amount')
    expect(output).toContain('v-filtered,42')
    expect(output).not.toContain('successDestination')
  })

  test('mitigates spreadsheet formulas one row at a time', async () => {
    const { readable } = createStreamingExportReadable({
      vaults: [{ ...vault('v-formula', '1'), creator: '=cmd', verifier: '@user' }],
    }, 'csv')
    const output = (await readStream(readable)).toString('utf8')

    expect(output).toContain("'=cmd")
    expect(output).toContain("'@user")
  })

  test('uses backpressure-sized source buffers', () => {
    const { readable } = createStreamingExportReadable({ vaults: [vault('v-buffer', '1')] }, 'csv')
    expect(readable.readableHighWaterMark).toBeLessThanOrEqual(512 * 1024)
  })

  test('handles a large fixture without building one joined string', async () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => vault(`v-${index}`, String(index)))
    const { readable } = createStreamingExportReadable({ vaults: rows }, 'csv')
    const output = await readStream(readable)

    expect(output.length).toBeGreaterThan(2_000)
    expect(output.toString('utf8')).toContain('v-1999')
  })

  test('supports cancellation when a client disconnects', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => vault(`v-${index}`, String(index)))
    const { readable } = createStreamingExportReadable({ vaults: rows }, 'csv')
    const close = new Promise<void>((resolve) => readable.once('close', resolve))

    readable.destroy()
    await close
    expect(readable.destroyed).toBe(true)
  })

  test('does not duplicate headers after the first streamed row', async () => {
    const { readable } = createStreamingExportReadable({ vaults: [vault('v-a', '1'), vault('v-b', '2')] }, 'csv')
    const output = (await readStream(readable)).toString('utf8')
    const header = 'id,creator,amount,status,startDate,endDate,verifier,successDestination,failureDestination,createdAt'

    expect(output.match(new RegExp(header, 'g'))).toHaveLength(1)
  })

  test('streams every requested section independently', async () => {
    const { readable } = createStreamingExportReadable({
      vaults: [vault('v-1', '1')],
      transactions: [{ id: 'tx-1', amount: '2' }],
      analytics: [{ userId: 'user-1', exportedAt: '2030-01-01T00:00:00.000Z' }],
    }, 'ndjson')
    const compressed = await readStream(readable)
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      import('node:zlib').then(({ gunzip }) => gunzip(compressed, (error, value) => error ? reject(error) : resolve(value)))
    })
    const rows = decompressed.toString('utf8').trim().split('\n').map((row) => JSON.parse(row))

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.id ?? row.userId)).toEqual(['v-1', 'tx-1', 'user-1'])
  })
})
