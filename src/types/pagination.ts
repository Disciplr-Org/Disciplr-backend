export interface PaginationParams {
  page: number
  pageSize: number
}

export interface CursorPaginationParams {
  cursor?: string
  limit: number
}

export interface SortParams {
  sortBy?: string
  sortOrder: 'asc' | 'desc'
}

export interface FilterParams {
  [key: string]: string | string[] | undefined
}

export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

export interface CursorPaginatedResponse<T> {
  data: T[]
  pagination: {
    cursor?: string
    nextCursor?: string
    prevCursor?: string
    limit: number
    hasNext: boolean
    hasPrev: boolean
  }
}
