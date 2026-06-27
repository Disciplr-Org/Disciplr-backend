import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryParser } from '../services/queryParser.js'

describe('QueryParser injection guards', () => {
  let warn: ReturnType<typeof mock>
  let metricsHook: ReturnType<typeof mock>
  let parser: QueryParser

  beforeEach(() => {
    warn = mock(() => undefined)
    metricsHook = mock(() => undefined)
    parser = new QueryParser({
      allowedColumns: ['id', 'status', 'amount', 'created_at'],
      defaultLimit: 20,
      maxLimit: 50,
      logger: { warn },
      metricsHook,
    })
  })

  it('parses valid filters, operators, sorting, and capped pagination', () => {
    const parsed = parser.parse({
      filter: {
        status: 'active',
        amount: { gte: '10', lt: '20' },
        id: { in: ['vault-a', 'vault-b'] },
      },
      sort: ['created_at:desc', 'amount'],
      limit: '500',
      offset: '3',
    })

    expect(parsed.conditions).toEqual([
      { column: 'status', operator: '=', value: 'active' },
      { column: 'amount', operator: '>=', value: '10' },
      { column: 'amount', operator: '<', value: '20' },
      { column: 'id', operator: 'IN', value: ['vault-a', 'vault-b'] },
    ])
    expect(parsed.sorts).toEqual([
      { column: 'created_at', order: 'desc' },
      { column: 'amount', order: 'asc' },
    ])
    expect(parsed.limit).toBe(50)
    expect(parsed.offset).toBe(3)
  })

  it('rejects prototype-pollution keys before they can alter Object.prototype', () => {
    const query: any = { filter: { status: 'active' } }
    Object.defineProperty(query.filter, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    })

    expect(() => parser.parse(query)).toThrow('Unsafe query key rejected: __proto__')
    expect(({} as any).polluted).toBeUndefined()
  })

  it('rejects constructor and prototype keys at any filter depth', () => {
    expect(() => parser.parse({ filter: { constructor: { eq: 'active' } } })).toThrow(
      'Unsafe query key rejected: constructor',
    )
    expect(() => parser.parse({ filter: { status: { prototype: 'active' } } })).toThrow(
      'Unsafe query key rejected: prototype',
    )
  })

  it('rejects unknown filter fields', () => {
    expect(() => parser.parse({ filter: { organization_id: 'org-b' } })).toThrow(
      'Invalid filter field: organization_id',
    )

    expect(warn).toHaveBeenCalledWith('QueryParser: Restricted column access attempted', {
      column: 'organization_id',
    })
    expect(metricsHook).toHaveBeenCalledWith({
      event: 'restricted_column_access',
      column: 'organization_id',
    })
  })

  it('rejects unsupported filter operators', () => {
    expect(() => parser.parse({ filter: { status: { $ne: 'deleted' } } })).toThrow(
      'Invalid filter operator: $ne',
    )

    expect(warn).toHaveBeenCalledWith('QueryParser: Invalid operator attempted', {
      column: 'status',
      op: '$ne',
    })
    expect(metricsHook).toHaveBeenCalledWith({
      event: 'invalid_operator_attempt',
      column: 'status',
      operator: '$ne',
    })
  })

  it('rejects unknown sort fields', () => {
    expect(() => parser.parse({ sort: 'organization_id:desc' })).toThrow(
      'Invalid sort field: organization_id',
    )

    expect(warn).toHaveBeenCalledWith('QueryParser: Restricted column sort attempted', {
      column: 'organization_id',
    })
    expect(metricsHook).toHaveBeenCalledWith({
      event: 'restricted_sort_access',
      column: 'organization_id',
    })
  })
})
