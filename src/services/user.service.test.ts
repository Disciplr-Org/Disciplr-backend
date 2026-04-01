import { db } from '../db/index.js'
import { UserService } from '../services/user.service.js'
import { UserRole, UserStatus } from '../types/user.js'

describe('UserService Delete Policy', () => {
  const userService = new UserService()
  let testUserId: string

  beforeEach(async () => {
    testUserId = `test-delete-${Date.now()}`
    await db('users').insert({
      id: testUserId,
      email: `${testUserId}@example.com`,
      passwordHash: 'hashed-password',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  })

  afterEach(async () => {
    await db('users').where('id', testUserId).del()
  })

  afterAll(async () => {
    await db.destroy()
  })

  describe('softDeleteUser', () => {
    test('should set deletedAt timestamp on soft delete', async () => {
      const result = await userService.softDeleteUser(testUserId)

      expect(result).not.toBeNull()
      expect(result!.success).toBe(true)
      expect(result!.deletionType).toBe('soft')
      expect(result!.deletedAt).toBeDefined()
    })

    test('should return null for non-existent user', async () => {
      const result = await userService.softDeleteUser('non-existent-id')
      expect(result).toBeNull()
    })

    test('should return success false for already deleted user', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.softDeleteUser(testUserId)

      expect(result).not.toBeNull()
      expect(result!.success).toBe(false)
      expect(result!.deletedAt).toBeDefined()
    })

    test('should exclude soft-deleted user from getUserById by default', async () => {
      await userService.softDeleteUser(testUserId)
      const user = await userService.getUserById(testUserId)
      expect(user).toBeNull()
    })

    test('should return soft-deleted user when includeDeleted is true', async () => {
      await userService.softDeleteUser(testUserId)
      const user = await userService.getUserById(testUserId, true)

      expect(user).not.toBeNull()
      expect(user!.deletedAt).toBeDefined()
    })

    test('should exclude soft-deleted users from listUsers by default', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.listUsers({ search: testUserId })

      const found = result.data.find(u => u.id === testUserId)
      expect(found).toBeUndefined()
    })

    test('should include soft-deleted users when includeDeleted is true', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.listUsers({ search: testUserId, includeDeleted: true })

      const found = result.data.find(u => u.id === testUserId)
      expect(found).toBeDefined()
      expect(found!.deletedAt).toBeDefined()
    })
  })

  describe('hardDeleteUser', () => {
    test('should permanently remove user from database', async () => {
      const result = await userService.hardDeleteUser(testUserId)

      expect(result).not.toBeNull()
      expect(result!.success).toBe(true)
      expect(result!.deletionType).toBe('hard')

      const userCheck = await db('users').where('id', testUserId).first()
      expect(userCheck).toBeUndefined()
    })

    test('should return null for non-existent user', async () => {
      const result = await userService.hardDeleteUser('non-existent-id')
      expect(result).toBeNull()
    })

    test('should hard delete even soft-deleted users', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.hardDeleteUser(testUserId)

      expect(result).not.toBeNull()
      expect(result!.success).toBe(true)
      expect(result!.deletionType).toBe('hard')
    })
  })

  describe('restoreUser', () => {
    test('should clear deletedAt on restore', async () => {
      await userService.softDeleteUser(testUserId)
      const restored = await userService.restoreUser(testUserId)

      expect(restored).not.toBeNull()
      expect(restored!.deletedAt).toBeUndefined()
    })

    test('should return null for non-existent user', async () => {
      const result = await userService.restoreUser('non-existent-id')
      expect(result).toBeNull()
    })

    test('should return user as-is if not deleted', async () => {
      const result = await userService.restoreUser(testUserId)

      expect(result).not.toBeNull()
      expect(result!.id).toBe(testUserId)
    })

    test('should make user visible in default queries after restore', async () => {
      await userService.softDeleteUser(testUserId)
      await userService.restoreUser(testUserId)

      const user = await userService.getUserById(testUserId)
      expect(user).not.toBeNull()
    })
  })

  describe('updateUserRole with soft-deleted users', () => {
    test('should not update role of soft-deleted user', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.updateUserRole(testUserId, UserRole.VERIFIER)
      expect(result).toBeNull()
    })
  })

  describe('updateUserStatus with soft-deleted users', () => {
    test('should not update status of soft-deleted user', async () => {
      await userService.softDeleteUser(testUserId)
      const result = await userService.updateUserStatus(testUserId, UserStatus.SUSPENDED)
      expect(result).toBeNull()
    })
  })
})
