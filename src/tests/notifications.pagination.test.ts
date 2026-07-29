import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { Notification } from '../types/notification.js'

type Predicate = (row: Notification) => boolean

let notifications: Notification[] = []

const compareValues = (left: unknown, operator: string, right: unknown): boolean => {
  const leftValue = left instanceof Date ? left.getTime() : new Date(String(left)).getTime() || String(left)
  const rightValue = right instanceof Date ? right.getTime() : new Date(String(right)).getTime() || String(right)

  switch (operator) {
    case '<':
      return leftValue < rightValue
    case '=':
      return leftValue === rightValue
    default:
      throw new Error(`Unsupported operator ${operator}`)
  }
}

class PredicateGroup {
  private predicates: Predicate[] = []

  where(column: keyof Notification, operator: string, value: unknown): this
  where(callback: (this: PredicateGroup) => void): this
  where(arg1: keyof Notification | ((this: PredicateGroup) => void), operator?: string, value?: unknown): this {
    if (typeof arg1 === 'function') {
      arg1.call(this)
      return this
    }
    this.predicates.push((row) => compareValues(row[arg1], operator!, value))
    return this
  }

  andWhere(column: keyof Notification, operator: string, value: unknown): this {
    return this.where(column, operator, value)
  }

  orWhere(callback: (this: PredicateGroup) => void): this {
    const group = new PredicateGroup()
    callback.call(group)
    const current = this.toPredicate()
    const next = group.toPredicate()
    this.predicates = [(row) => current(row) || next(row)]
    return this
  }

  toPredicate(): Predicate {
    const predicates = [...this.predicates]
    return (row) => predicates.every((predicate) => predicate(row))
  }
}

class NotificationQuery {
  private predicates: Predicate[] = []
  private orderings: Array<{ column: keyof Notification; direction: 'asc' | 'desc' }> = []
  private limitValue: number | undefined

  where(values: Partial<Notification>): this
  where(callback: (this: PredicateGroup) => void): this
  where(arg: Partial<Notification> | ((this: PredicateGroup) => void)): this {
    if (typeof arg === 'function') {
      const group = new PredicateGroup()
      arg.call(group)
      this.predicates.push(group.toPredicate())
      return this
    }

    this.predicates.push((row) =>
      Object.entries(arg).every(([key, value]) => row[key as keyof Notification] === value),
    )
    return this
  }

  whereNull(column: keyof Notification): this {
    this.predicates.push((row) => row[column] === null)
    return this
  }

  whereNotNull(column: keyof Notification): this {
    this.predicates.push((row) => row[column] !== null)
    return this
  }

  modify(callback: (builder: this) => void): this {
    callback(this)
    return this
  }

  orderBy(column: keyof Notification, direction: 'asc' | 'desc'): this {
    this.orderings.push({ column, direction })
    return this
  }

  limit(limit: number): this {
    this.limitValue = limit
    return this
  }

  async select(): Promise<Notification[]> {
    const rows = notifications
      .filter((row) => this.predicates.every((predicate) => predicate(row)))
      .sort((a, b) => {
        for (const ordering of this.orderings) {
          const left = a[ordering.column]
          const right = b[ordering.column]
          if (left === right) continue
          const result = String(left).localeCompare(String(right))
          return ordering.direction === 'asc' ? result : -result
        }
        return 0
      })

    return typeof this.limitValue === 'number' ? rows.slice(0, this.limitValue) : rows
  }
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: (table: string) => {
    if (table !== 'notifications') throw new Error(`Unexpected table ${table}`)
    return new NotificationQuery()
  },
}))

const { listUserNotifications } = await import('../services/notification.js')

const notification = (
  id: string,
  userId: string,
  createdAt: string,
  overrides: Partial<Notification> = {},
): Notification => ({
  id,
  user_id: userId,
  type: 'vault_failure',
  title: `Notification ${id}`,
  message: `Message ${id}`,
  data: null,
  idempotency_key: null,
  read_at: null,
  archived_at: null,
  created_at: createdAt,
  ...overrides,
})

describe('notification cursor pagination', () => {
  beforeEach(() => {
    notifications = [
      notification('n5', 'user-a', '2026-06-28T10:04:00.000Z'),
      notification('n4', 'user-a', '2026-06-28T10:03:00.000Z'),
      notification('n3', 'user-a', '2026-06-28T10:02:00.000Z'),
      notification('n2', 'user-a', '2026-06-28T10:01:00.000Z'),
      notification('n1', 'user-a', '2026-06-28T10:00:00.000Z'),
      notification('other-1', 'user-b', '2026-06-28T10:05:00.000Z'),
    ]
  })

  it('paginates by created_at and id without overlap', async () => {
    const first = await listUserNotifications('user-a', { limit: 2, readStatus: 'all' })
    const second = await listUserNotifications('user-a', {
      limit: 2,
      cursor: first.pagination.next_cursor,
      readStatus: 'all',
    })

    expect(first.data.map((item) => item.id)).toEqual(['n5', 'n4'])
    expect(second.data.map((item) => item.id)).toEqual(['n3', 'n2'])
    expect(first.pagination.has_more).toBe(true)
    expect(second.pagination.cursor).toBe(first.pagination.next_cursor)
  })

  it('does not skip or duplicate older rows when a newer notification arrives mid-scroll', async () => {
    const first = await listUserNotifications('user-a', { limit: 2, readStatus: 'all' })
    notifications.push(notification('n6', 'user-a', '2026-06-28T10:06:00.000Z'))

    const second = await listUserNotifications('user-a', {
      limit: 2,
      cursor: first.pagination.next_cursor,
      readStatus: 'all',
    })

    expect(second.data.map((item) => item.id)).toEqual(['n3', 'n2'])
  })

  it('omits next_cursor on the last page', async () => {
    const first = await listUserNotifications('user-a', { limit: 4, readStatus: 'all' })
    const last = await listUserNotifications('user-a', {
      limit: 4,
      cursor: first.pagination.next_cursor,
      readStatus: 'all',
    })

    expect(last.data.map((item) => item.id)).toEqual(['n1'])
    expect(last.pagination.has_more).toBe(false)
    expect(last.pagination.next_cursor).toBeUndefined()
  })

  it('returns an empty page with cursor metadata for users without notifications', async () => {
    const page = await listUserNotifications('missing-user', { limit: 2, readStatus: 'all' })

    expect(page).toEqual({
      data: [],
      pagination: {
        limit: 2,
        cursor: null,
        next_cursor: undefined,
        has_more: false,
        count: 0,
      },
    })
  })

  it('keeps pagination scoped to the authenticated user', async () => {
    const page = await listUserNotifications('user-b', { limit: 10, readStatus: 'all' })

    expect(page.data.map((item) => item.id)).toEqual(['other-1'])
  })

  it('applies read-status and archived filters before pagination', async () => {
    notifications = [
      notification('unread-visible', 'user-a', '2026-06-28T10:03:00.000Z'),
      notification('read-visible', 'user-a', '2026-06-28T10:02:00.000Z', {
        read_at: '2026-06-28T10:02:30.000Z',
      }),
      notification('unread-archived', 'user-a', '2026-06-28T10:01:00.000Z', {
        archived_at: '2026-06-28T10:01:30.000Z',
      }),
    ]

    const page = await listUserNotifications('user-a', {
      limit: 10,
      readStatus: 'unread',
      includeArchived: false,
    })

    expect(page.data.map((item) => item.id)).toEqual(['unread-visible'])
  })
})
