import { db } from '../db/index.js'
import { UserRole, UserStatus, User } from '../types/user.js'

export interface UserFilters {
  role?: UserRole
  status?: UserStatus
  search?: string
  limit?: number
  offset?: number
}

export interface PaginatedUsers {
  data: User[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

export class UserService {
  async listUsers(filters: UserFilters = {}): Promise<PaginatedUsers> {
    const { role, status, search, limit = 20, offset = 0 } = filters

    let query = db('users')

    // Apply filters
    if (role) {
      query = query.where('role', role)
    }

    if (status) {
      query = query.where('status', status)
    }

    if (search) {
      query = query.where(function() {
        this.where('email', 'ilike', `%${search}%`)
          .orWhere('id', 'ilike', `%${search}%`)
      })
    }

    // Get total count
    const countQuery = query.clone().clearSelect().clearOrder().count('* as total')
    const [{ total }] = await countQuery

    // Apply pagination and ordering
    const users = await query
      .select(
        'id',
        'email',
        'role',
        'status',
        'createdAt',
        'updatedAt',
        'lastLoginAt'
      )
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .offset(offset)

    return {
      data: users.map(user => ({
        ...user,
        createdAt: new Date(user.createdAt).toISOString(),
        updatedAt: new Date(user.updatedAt).toISOString(),
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : undefined
      })),
      pagination: {
        limit,
        offset,
        total: Number(total),
        hasMore: offset + limit < Number(total)
      }
    }
  }

  async getUserById(id: string): Promise<User | null> {
    const user = await db('users')
      .where('id', id)
      .first(
        'id',
        'email',
        'role',
        'status',
        'createdAt',
        'updatedAt',
        'lastLoginAt'
      )

    if (!user) return null

    return {
      ...user,
      createdAt: new Date(user.createdAt).toISOString(),
      updatedAt: new Date(user.updatedAt).toISOString(),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : undefined
    }
  }

  async updateUserRole(id: string, role: UserRole): Promise<User | null> {
    await db('users')
      .where('id', id)
      .update({
        role,
        updatedAt: new Date()
      })

    return this.getUserById(id)
  }

  async updateUserStatus(id: string, status: UserStatus): Promise<User | null> {
    await db('users')
      .where('id', id)
      .update({
        status,
        updatedAt: new Date()
      })

    return this.getUserById(id)
  }
}

export const userService = new UserService()
