import express, { Request, Response } from 'express'
import request from 'supertest'
import { describe, it, expect } from '@jest/globals'
import { queryParser } from '../middleware/queryParser.js'

const app = express()
app.use(express.json())

app.get(
  '/parse',
  queryParser({ allowedSortFields: ['createdAt', 'status'], allowedFilterFields: ['status', 'creator'] }),
  (req: Request, res: Response) => {
    res.json({
      filters: req.filters,
      sort: req.sort,
      pagination: req.pagination,
      cursorPagination: req.cursorPagination,
    })
  },
)

describe('queryParser injection guards', () => {
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

  it('rejects protected keys regardless of casing', async () => {
    const res = await request(app)
      .get('/parse')
      .query({ __PROTO__: 'active' })

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

  it('rejects a sort field that is not in the allowlist', async () => {
    const res = await request(app)
      .get('/parse')
      .query({ sortBy: 'email', sortOrder: 'asc' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid sort field/i)
  })

  it('rejects an unsupported sort order', async () => {
    const res = await request(app)
      .get('/parse')
      .query({ sortBy: 'createdAt', sortOrder: 'sideways' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid sort order/i)
  })

  it('rejects a non-integer page size', async () => {
    const res = await request(app)
      .get('/parse')
      .query({ page: '1', pageSize: 'lots' })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid pageSize/i)
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
    expect(res.body.cursorPagination).toEqual({ cursor: undefined, limit: 20 })
  })
})
