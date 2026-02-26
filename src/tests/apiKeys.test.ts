import { createApiKey, listApiKeysForUser, revokeApiKey, validateApiKey } from '../services/apiKeys.js'
import { setupTestEnvironment } from './setup.js'

setupTestEnvironment()

describe('apiKeys service', () => {
  describe('createApiKey', () => {
    it('creates valid API key with correct format', () => {
      const { apiKey, record } = createApiKey({
        userId: 'user-123',
        label: 'Test Key',
        scopes: ['read', 'write'],
      })

      expect(apiKey).toMatch(/^dsk_[^\.]+\..+$/)
      expect(record.userId).toBe('user-123')
      expect(record.label).toBe('Test Key')
      expect(record.scopes).toEqual(['read', 'write'])
      expect(record.revokedAt).toBeNull()
    })

    it('normalizes and deduplicates scopes', () => {
      const { record } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['write', 'read', 'write', ' read '],
      })

      expect(record.scopes).toEqual(['read', 'write'])
    })
  })

  describe('validateApiKey', () => {
    it('validates correct API key', () => {
      const { apiKey } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['read'],
      })

      const result = validateApiKey(apiKey)

      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.context.userId).toBe('user-123')
        expect(result.context.scopes).toContain('read')
      }
    })

    it('rejects malformed API key', () => {
      const result = validateApiKey('invalid-key')

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.reason).toBe('malformed')
      }
    })

    it('rejects revoked API key', () => {
      const { apiKey, record } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['read'],
      })

      revokeApiKey(record.id, 'user-123')
      const result = validateApiKey(apiKey)

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.reason).toBe('revoked')
      }
    })

    it('rejects when missing required scope', () => {
      const { apiKey } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['read'],
      })

      const result = validateApiKey(apiKey, ['write'])

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.reason).toBe('forbidden')
      }
    })
  })

  describe('listApiKeysForUser', () => {
    it('returns only keys for specified user', () => {
      createApiKey({ userId: 'user-1', label: 'Key 1', scopes: ['read'] })
      createApiKey({ userId: 'user-2', label: 'Key 2', scopes: ['read'] })
      createApiKey({ userId: 'user-1', label: 'Key 3', scopes: ['write'] })

      const keys = listApiKeysForUser('user-1')

      expect(keys).toHaveLength(2)
      expect(keys.every((k) => k.userId === 'user-1')).toBe(true)
    })
  })

  describe('revokeApiKey', () => {
    it('revokes API key for correct user', () => {
      const { record } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['read'],
      })

      const revoked = revokeApiKey(record.id, 'user-123')

      expect(revoked).not.toBeNull()
      expect(revoked?.revokedAt).not.toBeNull()
    })

    it('returns null for wrong user', () => {
      const { record } = createApiKey({
        userId: 'user-123',
        label: 'Test',
        scopes: ['read'],
      })

      const revoked = revokeApiKey(record.id, 'wrong-user')

      expect(revoked).toBeNull()
    })
  })
})
