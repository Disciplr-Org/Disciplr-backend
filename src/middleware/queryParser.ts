import type { Request, Response, NextFunction } from 'express'
import {
  parsePaginationParams,
  parseCursorPaginationParams,
  parseSortParams,
  parseFilterParams,
} from '../utils/pagination.js'

export interface QueryParserOptions {
  allowedSortFields?: string[]
  allowedFilterFields?: string[]
}

const PROTECTED_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const RESERVED_QUERY_KEYS = new Set(['page', 'pageSize', 'cursor', 'limit', 'sortBy', 'sortOrder'])

function validateQueryParams(req: Request, options: QueryParserOptions) {
  const allowedFilterFields = options.allowedFilterFields ?? []
  const allowedSortFields = options.allowedSortFields ?? []
  const allowedKeys = new Set([...RESERVED_QUERY_KEYS, ...allowedFilterFields, ...allowedSortFields])

  for (const key of Object.keys(req.query)) {
    const normalizedKey = key.toLowerCase()

    if (PROTECTED_QUERY_KEYS.has(normalizedKey)) {
      throw new Error('Invalid query parameters')
    }

    if (key.includes('__') || key.includes(':')) {
      throw new Error('Invalid query parameters')
    }

    if (!allowedKeys.has(key)) {
      throw new Error('Invalid query parameters')
    }
  }
}

export function queryParser(options: QueryParserOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      validateQueryParams(req, options)

      // Parse pagination
      req.pagination = parsePaginationParams(req)
      req.cursorPagination = parseCursorPaginationParams(req)

      // Parse sorting if allowed fields are specified
      if (options.allowedSortFields && options.allowedSortFields.length > 0) {
        req.sort = parseSortParams(req, options.allowedSortFields)
      }

      // Parse filters if allowed fields are specified
      if (options.allowedFilterFields && options.allowedFilterFields.length > 0) {
        req.filters = parseFilterParams(req, options.allowedFilterFields)
      }

      next()
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid query parameters',
      })
    }
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      pagination?: ReturnType<typeof parsePaginationParams>
      cursorPagination?: ReturnType<typeof parseCursorPaginationParams>
      sort?: ReturnType<typeof parseSortParams>
      filters?: ReturnType<typeof parseFilterParams>
    }
  }
}
