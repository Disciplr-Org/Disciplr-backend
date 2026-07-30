import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { describe, it, expect } from '@jest/globals'
import { queryParser } from '../middleware/queryParser.js'
import { QueryParser } from '../services/queryParser.js'

const app = express()
app.use(express.json())

app.get(
  '/parse',
  queryParser({ allowedSortFields: ['createdAt', 'status'], allowedFilterFields: ['status', 'creator'] }),
  (req: Request, res: Response) => {
    res.json({ filters: req.filters, sort: req.sort, pagination: req.pagination })
  },
)

describe('queryParser injection guards', () => {
  it('ignores prototype pollution and unsupported operators in the service parser', () => {
    const parser = new QueryParser({ allowedColumns: ['status', 'creator'] })

    const parsed = parser.parse({
      filter: {
        status: { eq: 'active' },
        creator: { nope: 'alice' },
        __proto__: { eq: 'polluted' },
        constructor: { eq: 'polluted' },
        prototype: { eq: 'polluted' },
        unknown: { eq: 'ignored' },
      },
      limit: '10',
      offset: '2',
      sort: 'status:desc',
    })

    expect(parsed.conditions).toEqual([{ column: 'status', operator: '=', value: 'active' }])
    expect(parsed.limit).toBe(10)
    expect(parsed.offset).toBe(2)
    expect(parsed.sorts).toEqual([{ column: 'status', order: 'desc' }])
  })

  it('rejects prototype pollution keys such as __proto__, constructor, and prototype', async () => {
    const res = await request(app)
      .get('/parse')
      .query({
        __proto__: { status: 'active' },
        constructor: { status: 'active' },
        prototype: { status: 'active' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid query/i)
  })

  it('rejects unsupported operators and unknown fields', async () => {
    const res = await request(app)
      .get('/parse')
      .query({
        status: 'active',
        creator: 'alice',
        filter: 'status:active',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        foo: 'bar',
        status__gt: 'active',
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid query/i)
  })

  it('accepts valid filters and sort params', async () => {
    const res = await request(app)
      .get('/parse')
      .query({
        status: 'active',
        creator: 'alice',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        page: '2',
        pageSize: '10',
      })

    expect(res.status).toBe(200)
    expect(res.body.filters).toEqual({ status: 'active', creator: 'alice' })
    expect(res.body.sort).toEqual({ sortBy: 'createdAt', sortOrder: 'desc' })
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 10 })
  })
})
