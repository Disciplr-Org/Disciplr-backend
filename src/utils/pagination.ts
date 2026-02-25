import type { Request } from 'express'
import type {
  PaginationParams,
  SortParams,
  FilterParams,
  PaginatedResponse,
} from '../types/pagination.js'

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

export function parsePaginationParams(req: Request): PaginationParams {
  const page = Math.max(1, parseInt(req.query.page as string) || DEFAULT_PAGE)
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(req.query.pageSize as string) || DEFAULT_PAGE_SIZE)
  )

  return { page, pageSize }
}

export function parseSortParams(req: Request, allowedFields: string[]): SortParams {
  const sortBy = req.query.sortBy as string
  const sortOrder = (req.query.sortOrder as string)?.toLowerCase() === 'desc' ? 'desc' : 'asc'

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

export function applyFilters<T extends Record<string, any>>(
  items: T[],
  filters: FilterParams
): T[] {
  return items.filter((item) => {
    return Object.entries(filters).every(([key, value]) => {
      if (value === undefined) return true

      const itemValue = item[key]
      if (itemValue === undefined) return false

      if (Array.isArray(value)) {
        return value.includes(String(itemValue))
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
