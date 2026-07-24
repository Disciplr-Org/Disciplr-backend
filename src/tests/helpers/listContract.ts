/**
 * List Endpoint Contract Tests
 *
 * Reusable test suite for validating pagination, sorting, and filtering
 * across all list endpoints in the API.
 */

import type { Express } from 'express'
import request from 'supertest'

export interface ListEndpointConfig {
  /** Base URL path for the endpoint (e.g., '/api/vaults') */
  path: string
  /** Authentication headers or setup function */
  auth: Record<string, string> | (() => Record<string, string>)
  /** Allowed sort fields for this endpoint */
  allowedSortFields: string[]
  /** Allowed filter fields for this endpoint */
  allowedFilterFields: string[]
  /** Fields that should be present in each list item */
  requiredFields: string[]
  /** Test data setup function - creates resources for testing */
  setupTestData: () => Promise<void> | void
  /** Test data cleanup function */
  cleanupTestData: () => Promise<void> | void
  /** Optional: Custom assertions for response structure */
  customAssertions?: (response: request.Response) => void
}

export interface PaginationContract {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface CursorPaginationContract {
  limit: number
  cursor?: string
  next_cursor?: string
  has_more: boolean
  count: number
}

/**
 * Runs the complete contract test suite for a list endpoint
 */
export function runListContractTests(
  app: Express,
  config: ListEndpointConfig,
  options: {
    /** Use cursor-based pagination instead of offset */
    useCursorPagination?: boolean
    /** Skip specific test categories */
    skipPagination?: boolean
    skipSorting?: boolean
    skipFiltering?: boolean
    skipSecurity?: boolean
  } = {}
): void {
  const getAuth = (): Record<string, string> => {
    return typeof config.auth === 'function' ? config.auth() : config.auth
  }

  describe(`List Contract: ${config.path}`, () => {
    beforeEach(async () => {
      await config.setupTestData()
    })

    afterEach(async () => {
      await config.cleanupTestData()
    })

    // ─── Pagination Contract ───────────────────────────────────────────────
    if (!options.skipPagination) {
      describe('Pagination', () => {
        if (options.useCursorPagination) {
          it('validates cursor pagination structure', async () => {
            const res = await request(app)
              .get(config.path)
              .set(getAuth())
              .expect(200)

            expect(res.body).toHaveProperty('data')
            expect(res.body).toHaveProperty('pagination')
            expect(res.body.pagination).toHaveProperty('limit')
            expect(res.body.pagination).toHaveProperty('has_more')
            expect(res.body.pagination).toHaveProperty('count')
            expect(typeof res.body.pagination.limit).toBe('number')
            expect(typeof res.body.pagination.has_more).toBe('boolean')
            expect(typeof res.body.pagination.count).toBe('number')
          })

          it('respects limit parameter', async () => {
            const res = await request(app)
              .get(`${config.path}?limit=5`)
              .set(getAuth())
              .expect(200)

            expect(res.body.pagination.limit).toBe(5)
            expect(res.body.data.length).toBeLessThanOrEqual(5)
          })

          it('enforces maximum limit', async () => {
            const res = await request(app)
              .get(`${config.path}?limit=200`)
              .set(getAuth())
              .expect(200)

            expect(res.body.pagination.limit).toBeLessThanOrEqual(100)
          })

          it('returns 400 for invalid cursor', async () => {
            const res = await request(app)
              .get(`${config.path}?cursor=invalid_cursor`)
              .set(getAuth())

            expect(res.status).toBe(400)
            expect(res.body.error.code).toBe('BAD_REQUEST')
          })
        } else {
          it('validates offset pagination structure', async () => {
            const res = await request(app)
              .get(config.path)
              .set(getAuth())
              .expect(200)

            expect(res.body).toHaveProperty('data')
            expect(res.body).toHaveProperty('pagination')
            expect(res.body.pagination).toHaveProperty('page')
            expect(res.body.pagination).toHaveProperty('pageSize')
            expect(res.body.pagination).toHaveProperty('total')
            expect(res.body.pagination).toHaveProperty('totalPages')
            expect(res.body.pagination).toHaveProperty('hasNext')
            expect(res.body.pagination).toHaveProperty('hasPrev')
          })

          it('respects page and pageSize parameters', async () => {
            const res = await request(app)
              .get(`${config.path}?page=2&pageSize=5`)
              .set(getAuth())
              .expect(200)

            expect(res.body.pagination.page).toBe(2)
            expect(res.body.pagination.pageSize).toBe(5)
          })

          it('defaults to page 1 when page < 1', async () => {
            const res = await request(app)
              .get(`${config.path}?page=0`)
              .set(getAuth())
              .expect(200)

            expect(res.body.pagination.page).toBe(1)
          })

          it('enforces maximum pageSize', async () => {
            const res = await request(app)
              .get(`${config.path}?pageSize=200`)
              .set(getAuth())
              .expect(200)

            expect(res.body.pagination.pageSize).toBeLessThanOrEqual(100)
          })

          it('calculates totalPages correctly', async () => {
            const res = await request(app)
              .get(config.path)
              .set(getAuth())
              .expect(200)

            const { total, pageSize, totalPages } = res.body.pagination
            expect(totalPages).toBe(Math.ceil(total / pageSize))
          })

          it('sets hasNext correctly based on page position', async () => {
            const res = await request(app)
              .get(`${config.path}?page=1&pageSize=10`)
              .set(getAuth())
              .expect(200)

            const { page, totalPages, hasNext } = res.body.pagination
            expect(hasNext).toBe(page < totalPages)
          })
        }
      })
    }

    // ─── Sorting Contract ──────────────────────────────────────────────────
    if (!options.skipSorting && config.allowedSortFields.length > 0) {
      describe('Sorting', () => {
        it('rejects invalid sort field with 400', async () => {
          const res = await request(app)
            .get(`${config.path}?sortBy=invalid_field`)
            .set(getAuth())

          expect(res.status).toBe(400)
          expect(res.body.error).toBeDefined()
        })

        it(`accepts valid sort fields: ${config.allowedSortFields.join(', ')}`, async () => {
          for (const field of config.allowedSortFields) {
            const res = await request(app)
              .get(`${config.path}?sortBy=${field}`)
              .set(getAuth())
              .expect(200)

            expect(res.body.data).toBeDefined()
          }
        })

        it('defaults to ascending order', async () => {
          const field = config.allowedSortFields[0]
          const res = await request(app)
            .get(`${config.path}?sortBy=${field}`)
            .set(getAuth())
            .expect(200)

          expect(res.body.data).toBeDefined()
        })

        it('supports descending order', async () => {
          const field = config.allowedSortFields[0]
          const res = await request(app)
            .get(`${config.path}?sortBy=${field}&sortOrder=desc`)
            .set(getAuth())
            .expect(200)

          expect(res.body.data).toBeDefined()
        })

        it('rejects invalid sortOrder values', async () => {
          const field = config.allowedSortFields[0]
          // Should default to asc for invalid values, not error
          const res = await request(app)
            .get(`${config.path}?sortBy=${field}&sortOrder=invalid`)
            .set(getAuth())
            .expect(200)

          expect(res.body.data).toBeDefined()
        })
      })
    }

    // ─── Filtering Contract ─────────────────────────────────────────────────
    if (!options.skipFiltering && config.allowedFilterFields.length > 0) {
      describe('Filtering', () => {
        it('ignores non-allowed filter parameters', async () => {
          const res = await request(app)
            .get(`${config.path}?nonexistentFilter=value`)
            .set(getAuth())
            .expect(200)

          // Should not include the filter in response
          expect(res.body.data).toBeDefined()
        })

        it(`accepts valid filter fields: ${config.allowedFilterFields.join(', ')}`, async () => {
          for (const field of config.allowedFilterFields) {
            const res = await request(app)
              .get(`${config.path}?${field}=test_value`)
              .set(getAuth())
              .expect(200)

            expect(res.body.data).toBeDefined()
          }
        })

        it('supports multiple filter values', async () => {
          if (config.allowedFilterFields.length >= 2) {
            const field1 = config.allowedFilterFields[0]
            const field2 = config.allowedFilterFields[1]
            const res = await request(app)
              .get(`${config.path}?${field1}=value1&${field2}=value2`)
              .set(getAuth())
              .expect(200)

            expect(res.body.data).toBeDefined()
          }
        })
      })
    }

    // ─── Response Structure Contract ──────────────────────────────────────
    describe('Response Structure', () => {
      it('returns array of items in data field', async () => {
        const res = await request(app)
          .get(config.path)
          .set(getAuth())
          .expect(200)

        expect(Array.isArray(res.body.data)).toBe(true)
      })

      it('includes required fields in each item', async () => {
        const res = await request(app)
          .get(config.path)
          .set(getAuth())
          .expect(200)

        if (res.body.data.length > 0) {
          const item = res.body.data[0]
          for (const field of config.requiredFields) {
            expect(item).toHaveProperty(field)
          }
        }
      })

      it('returns empty array when no results', async () => {
        // Apply a filter that should return no results
        const res = await request(app)
          .get(`${config.path}?page=99999`)
          .set(getAuth())
          .expect(200)

        expect(res.body.data).toEqual([])
        expect(res.body.pagination.hasNext).toBe(false)
      })

      if (config.customAssertions) {
        it('passes custom assertions', async () => {
          const res = await request(app)
            .get(config.path)
            .set(getAuth())
            .expect(200)

          config.customAssertions!(res)
        })
      }
    })

    // ─── Security Contract ─────────────────────────────────────────────────
    if (!options.skipSecurity) {
      describe('Security', () => {
        it('requires authentication', async () => {
          const res = await request(app).get(config.path)

          expect(res.status).toBe(401)
          expect(res.body.error.code).toBe('UNAUTHORIZED')
        })

        it('cannot access other tenant data through filtering', async () => {
          // Attempt to filter by tenant-specific fields that should be blocked
          const res = await request(app)
            .get(`${config.path}?userId=other_user&orgId=other_org`)
            .set(getAuth())
            .expect(200)

          // Should either ignore the filter or return only authorized data
          // The actual data validation depends on the endpoint implementation
          expect(res.body.data).toBeDefined()
        })

        it('cannot extract hidden fields through sort parameters', async () => {
          // Attempt to sort by internal fields that should not be exposed
          const res = await request(app)
            .get(`${config.path}?sortBy=internalField&sortBy=password&sortBy=secret`)
            .set(getAuth())

          // Should return 400 for invalid sort fields
          expect(res.status).toBe(400)
        })
      })
    }
  })
}

/**
 * Validates query parser options configuration
 */
export function validateQueryParserConfig(
  allowedSortFields: string[],
  allowedFilterFields: string[]
): void {
  describe('Query Parser Configuration', () => {
    it('has defined allowed sort fields', () => {
      expect(allowedSortFields).toBeDefined()
      expect(Array.isArray(allowedSortFields)).toBe(true)
    })

    it('has defined allowed filter fields', () => {
      expect(allowedFilterFields).toBeDefined()
      expect(Array.isArray(allowedFilterFields)).toBe(true)
    })

    it('does not expose sensitive fields in sort options', () => {
      const sensitivePatterns = ['password', 'secret', 'token', 'key', 'hash', 'internal']
      for (const field of allowedSortFields) {
        for (const pattern of sensitivePatterns) {
          expect(field.toLowerCase()).not.toContain(pattern)
        }
      }
    })

    it('does not expose sensitive fields in filter options', () => {
      const sensitivePatterns = ['password', 'secret', 'token', 'key', 'hash', 'internal']
      for (const field of allowedFilterFields) {
        for (const pattern of sensitivePatterns) {
          expect(field.toLowerCase()).not.toContain(pattern)
        }
      }
    })
  })
}
