import type { Request } from 'express'
import type {
  PaginationParams,
  CursorPaginationParams,
  SortParams,
  FilterParams,
  PaginatedResponse,
} from '../types/pagination.js'

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

function parsePositiveInteger(value: unknown, fieldName: string): number {
  if (value === undefined || value === null || value === '') {
    return fieldName === 'page' ? DEFAULT_PAGE : DEFAULT_PAGE_SIZE
  }

  if (Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}`)
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return parsed
}

export function parsePaginationParams(req: Request): PaginationParams {
  const page = parsePositiveInteger(req.query.page, 'page')
  const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInteger(req.query.pageSize, 'pageSize'))

  return { page, pageSize }
}

export function parseCursorPaginationParams(req: Request): CursorPaginationParams {
  const cursor = req.query.cursor as string
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInteger(req.query.limit, 'limit'))

  return { cursor, limit }
}

export function encodeCursor(timestamp: Date, id: string): string {
  const str = `${timestamp.toISOString()}|${id}`
  return Buffer.from(str).toString('base64url')
}

export function decodeCursor(cursor: string): { timestamp: Date; id: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const [timestampStr, id] = decoded.split('|')
    if (!timestampStr || !id) throw new Error('Invalid cursor format')
    const timestamp = new Date(timestampStr)
    if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid cursor format')
    return { timestamp, id }
  } catch (error) {
    throw new Error('Invalid cursor')
  }
}

export function parseSortParams(req: Request, allowedFields: string[]): SortParams {
  const sortBy = req.query.sortBy as string | undefined
  const sortOrderValue = req.query.sortOrder as string | undefined
  const sortOrder = sortOrderValue?.toLowerCase() === 'desc'
    ? 'desc'
    : sortOrderValue?.toLowerCase() === 'asc'
      ? 'asc'
      : 'asc'

  if (sortOrderValue && !['asc', 'desc'].includes(sortOrderValue.toLowerCase())) {
    throw new Error('Invalid sort order')
  }

  if (sortBy && !allowedFields.includes(sortBy)) {
    throw new Error(`Invalid sort field. Allowed fields: ${allowedFields.join(', ')}`)
  }

  return {
    sortBy: sortBy && allowedFields.includes(sortBy) ? sortBy : undefined,
    sortOrder,
  }
}

export function parseFilterParams(
  req: Request,
  allowedFields: string[]
): FilterParams {
  const filters: FilterParams = {}

  for (const field of allowedFields) {
    const value = req.query[field]
    if (value !== undefined) {
      filters[field] = value as string | string[]
    }
  }

  return filters
}

/**
 * Filter an in-memory array against a set of key/value pairs.
 *
 * @param items             The array to filter.
 * @param filters           Map of field → value(s) built by parseFilterParams.
 * @param exactMatchFields  Fields that must match with strict equality (case-
 *                          sensitive).  All other fields use a case-insensitive
 *                          substring match.  Pass enum-like fields here (e.g.
 *                          `['status']`) to prevent `status=a` accidentally
 *                          matching 'active', 'cancelled', and 'failed'.
 */
export function applyFilters<T extends Record<string, any>>(
  items: T[],
  filters: FilterParams,
  exactMatchFields: string[] = []
): T[] {
  const exactSet = new Set(exactMatchFields)

  return items.filter((item) => {
    return Object.entries(filters).every(([key, value]) => {
      if (value === undefined) return true

      const itemValue = item[key]
      if (itemValue === undefined) return false

      if (Array.isArray(value)) {
        // Multi-value: always exact-inclusion (already strict)
        return value.includes(String(itemValue))
      }

      if (exactSet.has(key)) {
        // Enum / status fields: strict equality, no substring folding
        return String(itemValue) === String(value)
      }

      return String(itemValue).toLowerCase().includes(String(value).toLowerCase())
    })
  })
}

export function applySort<T extends Record<string, any>>(
  items: T[],
  sortParams: SortParams
): T[] {
  if (!sortParams.sortBy) return items

  return [...items].sort((a, b) => {
    const aVal = a[sortParams.sortBy!]
    const bVal = b[sortParams.sortBy!]

    if (aVal === bVal) return 0

    const comparison = aVal < bVal ? -1 : 1
    return sortParams.sortOrder === 'asc' ? comparison : -comparison
  })
}

export function paginateArray<T>(
  items: T[],
  params: PaginationParams
): PaginatedResponse<T> {
  const { page, pageSize } = params
  const total = items.length
  const totalPages = Math.ceil(total / pageSize)
  const startIndex = (page - 1) * pageSize
  const endIndex = startIndex + pageSize

  const data = items.slice(startIndex, endIndex)

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  }
}
