import type { Request, Response, NextFunction } from 'express'
import {
  parsePaginationParams,
  parseSortParams,
  parseFilterParams,
} from '../utils/pagination.js'

export interface QueryParserOptions {
  allowedSortFields?: string[]
  allowedFilterFields?: string[]
}

export function queryParser(options: QueryParserOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse pagination
      req.pagination = parsePaginationParams(req)

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
      sort?: ReturnType<typeof parseSortParams>
      filters?: ReturnType<typeof parseFilterParams>
    }
  }
}
