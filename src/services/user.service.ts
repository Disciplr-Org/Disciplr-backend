import { db } from '../db/index.js'
import { UserRole, UserStatus, User } from '../types/user.js'
import { prisma } from '../lib/prisma.js'

export interface UserFilters {
  role?: UserRole
  status?: UserStatus
  search?: string
  limit?: number
  offset?: number
  includeDeleted?: boolean
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

export interface DeleteResult {
  success: boolean
  userId: string
  deletionType: 'soft' | 'hard'
  deletedAt?: string
}

export class UserService {
  async listUsers(filters: UserFilters = {}): Promise<PaginatedUsers> {
    const { role, status, search, limit = 20, offset = 0, includeDeleted = false } = filters

    let query = db('users')

    if (!includeDeleted) {
      query = query.whereNull('deleted_at')
    }

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

    const countQuery = query.clone().clearSelect().clearOrder().count('* as total')
    const [{ total }] = await countQuery

    const users = await query
      .select(
        'id',
        'email',
        'role',
        'status',
        'createdAt',
        'updatedAt',
        'lastLoginAt',
        'deleted_at as deletedAt'
      )
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .offset(offset)

    return {
      data: users.map(user => ({
        ...user,
        createdAt: new Date(user.createdAt).toISOString(),
        updatedAt: new Date(user.updatedAt).toISOString(),
        lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : undefined,
        deletedAt: user.deletedAt ? new Date(user.deletedAt).toISOString() : undefined
      })),
      pagination: {
        limit,
        offset,
        total: Number(total),
        hasMore: offset + limit < Number(total)
      }
    }
  }

  async getUserById(id: string, includeDeleted = false): Promise<User | null> {
    let query = db('users').where('id', id)

    if (!includeDeleted) {
      query = query.whereNull('deleted_at')
    }

    const user = await query.first(
      'id',
      'email',
      'role',
      'status',
      'createdAt',
      'updatedAt',
      'lastLoginAt',
      'deleted_at as deletedAt'
    )

    if (!user) return null

    return {
      ...user,
      createdAt: new Date(user.createdAt).toISOString(),
      updatedAt: new Date(user.updatedAt).toISOString(),
      lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : undefined,
      deletedAt: user.deletedAt ? new Date(user.deletedAt).toISOString() : undefined
    }
  }

  async updateUserRole(id: string, role: UserRole): Promise<User | null> {
    await db('users')
      .where('id', id)
      .whereNull('deleted_at')
      .update({
        role,
        updatedAt: new Date()
      })

    return this.getUserById(id)
  }

  async updateUserStatus(id: string, status: UserStatus): Promise<User | null> {
    await db('users')
      .where('id', id)
      .whereNull('deleted_at')
      .update({
        status,
        updatedAt: new Date()
      })

    return this.getUserById(id)
  }

  async softDeleteUser(id: string): Promise<DeleteResult | null> {
    const user = await this.getUserById(id, true)
    if (!user) {
      return null
    }

    if (user.deletedAt) {
      return {
        success: false,
        userId: id,
        deletionType: 'soft',
        deletedAt: user.deletedAt
      }
    }

    const deletedAt = new Date()

    await db('users')
      .where('id', id)
      .update({
        deleted_at: deletedAt,
        updatedAt: deletedAt
      })

    await prisma.refreshToken.updateMany({
      where: { userId: id },
      data: { revokedAt: deletedAt }
    })

    return {
      success: true,
      userId: id,
      deletionType: 'soft',
      deletedAt: deletedAt.toISOString()
    }
  }

  async hardDeleteUser(id: string): Promise<DeleteResult | null> {
    const user = await this.getUserById(id, true)
    if (!user) {
      return null
    }

    await prisma.refreshToken.deleteMany({
      where: { userId: id }
    })

    await prisma.vault.deleteMany({
      where: { creatorId: id }
    })

    const deleted = await db('users')
      .where('id', id)
      .del()

    if (deleted === 0) {
      return null
    }

    return {
      success: true,
      userId: id,
      deletionType: 'hard'
    }
  }

  async restoreUser(id: string): Promise<User | null> {
    const user = await this.getUserById(id, true)
    if (!user) {
      return null
    }

    if (!user.deletedAt) {
      return user
    }

    await db('users')
      .where('id', id)
      .update({
        deleted_at: null,
        updatedAt: new Date()
      })

    return this.getUserById(id)
  }
}

export const userService = new UserService()
