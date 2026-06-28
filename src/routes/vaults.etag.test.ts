import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import request from 'supertest'
import { app } from '../app.js'
import { setVaults } from './vaults.js'
import * as vaultStore from '../services/vaultStore.js'
import { computeWeakETag, etagMatches, isValidETag, compareETags } from '../utils/etag.js'

describe('ETag and Conditional GET Support - GET /api/vaults/:id', () => {
  const mockVault = {
    id: 'vault-123',
    creator: 'G1234567890123456789012345678901234567890123456789012345',
    amount: '1000.00',
    status: 'active' as const,
    startDate: '2026-02-26T12:00:00Z',
    endDate: '2026-03-26T12:00:00Z',
    successDestination: 'G9999999999999999999999999999999999999999999999999999999',
    failureDestination: 'G8888888888888888888888888888888888888888888888888888888',
    verifier: 'G7777777777777777777777777777777777777777777777777777777',
    createdAt: '2026-02-26T12:00:00Z',
    lateCheckInWindowSecs: 0,
    milestones: [],
  }

  beforeEach(() => {
    setVaults([mockVault])
    jest.clearAllMocks()
  })

  afterEach(() => {
    setVaults([])
  })

  describe('ETag Utility Functions', () => {
    describe('computeWeakETag', () => {
      it('should generate weak ETag with version number', () => {
        const etag = computeWeakETag('123')
        expect(etag).toBe('W/"-123"')
      })

      it('should handle string versions', () => {
        const etag = computeWeakETag('abc-xyz-456')
        expect(etag).toBe('W/"-abc-xyz-456"')
      })

      it('should handle numeric versions', () => {
        const etag = computeWeakETag(789)
        expect(etag).toBe('W/"-789"')
      })
    })

    describe('etagMatches', () => {
      it('should return true when If-None-Match matches ETag exactly', () => {
        const result = etagMatches('W/"-123"', 'W/"-123"')
        expect(result).toBe(true)
      })

      it('should return true when If-None-Match is wildcard', () => {
        const result = etagMatches('*', 'W/"-123"')
        expect(result).toBe(true)
      })

      it('should return false when If-None-Match does not match', () => {
        const result = etagMatches('W/"-456"', 'W/"-123"')
        expect(result).toBe(false)
      })

      it('should handle multiple ETags in If-None-Match (comma-separated)', () => {
        const result = etagMatches('W/"-456", W/"-789", W/"-123"', 'W/"-123"')
        expect(result).toBe(true)
      })

      it('should return false when multiple ETags do not match', () => {
        const result = etagMatches('W/"-456", W/"-789"', 'W/"-123"')
        expect(result).toBe(false)
      })

      it('should ignore whitespace in If-None-Match', () => {
        const result = etagMatches('  W/"-123"  , W/"-456"  ', 'W/"-123"')
        expect(result).toBe(true)
      })

      it('should return false for undefined If-None-Match', () => {
        const result = etagMatches(undefined, 'W/"-123"')
        expect(result).toBe(false)
      })

      it('should return false for empty If-None-Match', () => {
        const result = etagMatches('', 'W/"-123"')
        expect(result).toBe(false)
      })

      it('should handle weak ETag comparison (strip W/ prefix)', () => {
        const result = etagMatches('W/"-123"', 'W/"-123"')
        expect(result).toBe(true)
      })
    })

    describe('isValidETag', () => {
      it('should accept weak ETags', () => {
        expect(isValidETag('W/"-123"')).toBe(true)
        expect(isValidETag('W/"-abc-xyz"')).toBe(true)
      })

      it('should accept strong ETags', () => {
        expect(isValidETag('"123"')).toBe(true)
        expect(isValidETag('"abc-xyz"')).toBe(true)
      })

      it('should reject invalid ETag formats', () => {
        expect(isValidETag('123')).toBe(false)
        expect(isValidETag('abc-xyz')).toBe(false)
        expect(isValidETag('W/-123')).toBe(false)  // Missing quotes
        expect(isValidETag('-123-')).toBe(false)
      })
    })

    describe('compareETags', () => {
      it('should compare weak ETags as equivalent', () => {
        expect(compareETags('W/"-123"', 'W/"-123"', true)).toBe(true)
      })

      it('should treat weak and strong ETags as equivalent in weak comparison', () => {
        expect(compareETags('W/"-123"', '"-123"', true)).toBe(true)
      })

      it('should distinguish weak and strong ETags in strong comparison', () => {
        expect(compareETags('W/"-123"', '"-123"', false)).toBe(false)
      })

      it('should require exact match in strong comparison mode', () => {
        expect(compareETags('"123"', '"123"', false)).toBe(true)
        expect(compareETags('"123"', '"456"', false)).toBe(false)
      })

      it('should return false for invalid ETags', () => {
        expect(compareETags('invalid', 'W/"-123"')).toBe(false)
        expect(compareETags('W/"-123"', 'invalid')).toBe(false)
      })
    })
  })

  describe('GET /api/vaults/:id with ETag support', () => {
    // Mock getVaultETag to return consistent values for testing
    beforeEach(() => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValue('W/"-12345"')
    })

    it('should return 200 with vault and ETag header on first request', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      expect(response.body).toEqual(mockVault)
      expect(response.headers['etag']).toBe('W/"-12345"')
      expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate')
    })

    it('should return 304 Not Modified when If-None-Match matches ETag', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-12345"')
        .expect(304)

      // 304 responses should have no body
      expect(response.body).toEqual({})
      expect(response.headers['etag']).toBe('W/"-12345"')
    })

    it('should return 200 with body when If-None-Match does not match', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-99999"')
        .expect(200)

      expect(response.body).toEqual(mockVault)
      expect(response.headers['etag']).toBe('W/"-12345"')
    })

    it('should return 304 when If-None-Match is wildcard', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', '*')
        .expect(304)

      expect(response.body).toEqual({})
    })

    it('should return 304 when If-None-Match contains matching ETag in list', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-99999", W/"-12345", W/"-88888"')
        .expect(304)

      expect(response.body).toEqual({})
    })

    it('should set appropriate cache headers', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate')
      expect(response.headers['etag']).toBeDefined()
    })

    it('should return 404 for non-existent vault', async () => {
      const response = await request(app)
        .get('/api/vaults/non-existent')
        .set('Authorization', 'Bearer valid-token')
        .expect(404)

      expect(response.body).toEqual({ error: 'Vault not found' })
    })

    it('should ignore If-None-Match when vault does not exist', async () => {
      const response = await request(app)
        .get('/api/vaults/non-existent')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-12345"')
        .expect(404)

      expect(response.body).toEqual({ error: 'Vault not found' })
    })

    it('should handle getVaultETag returning null gracefully', async () => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValueOnce(null)

      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      expect(response.body).toEqual(mockVault)
      expect(response.headers['etag']).toBeUndefined()
    })
  })

  describe('ETag behavior with vault updates', () => {
    it('should return different ETags after vault is modified', async () => {
      jest.spyOn(vaultStore, 'getVaultETag')
        .mockResolvedValueOnce('W/"-123"')
        .mockResolvedValueOnce('W/"-456"')

      const response1 = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')

      const response2 = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')

      expect(response1.headers['etag']).toBe('W/"-123"')
      expect(response2.headers['etag']).toBe('W/"-456"')
    })

    it('should invalidate cache when ETag changes', async () => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValueOnce('W/"-123"')

      // First request gets old ETag
      const response1 = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')

      const oldETag = response1.headers['etag']

      // Update mock to return new ETag
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValueOnce('W/"-456"')

      // Second request with old ETag should not get 304
      const response2 = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', oldETag)

      expect(response2.status).toBe(200)  // Should be 200, not 304
      expect(response2.headers['etag']).toBe('W/"-456"')
    })
  })

  describe('Edge cases and HTTP semantics', () => {
    beforeEach(() => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValue('W/"-12345"')
    })

    it('should handle If-None-Match with only whitespace', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', '   ')
        .expect(200)

      expect(response.body).toEqual(mockVault)
    })

    it('should preserve ETag header in 304 response', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-12345"')
        .expect(304)

      expect(response.headers['etag']).toBe('W/"-12345"')
    })

    it('should return 304 for authenticated requests only', async () => {
      // Without auth header, should fail before ETag logic
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('If-None-Match', 'W/"-12345"')
        .expect(401)  // Unauthorized before reaching vault logic
    })

    it('should handle concurrent requests with same If-None-Match', async () => {
      const requests = [
        request(app)
          .get('/api/vaults/vault-123')
          .set('Authorization', 'Bearer valid-token')
          .set('If-None-Match', 'W/"-12345"'),
        request(app)
          .get('/api/vaults/vault-123')
          .set('Authorization', 'Bearer valid-token')
          .set('If-None-Match', 'W/"-12345"'),
        request(app)
          .get('/api/vaults/vault-123')
          .set('Authorization', 'Bearer valid-token')
          .set('If-None-Match', 'W/"-12345"'),
      ]

      const responses = await Promise.all(requests)
      responses.forEach((response) => {
        expect(response.status).toBe(304)
      })
    })
  })

  describe('RFC 7232 Compliance', () => {
    beforeEach(() => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValue('W/"-12345"')
    })

    it('RFC 7232 Section 2.3: Should use weak ETag format W/"..."', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      const etag = response.headers['etag']
      expect(etag).toMatch(/^W\/"-[^"]*"$/)  // Matches weak ETag format
    })

    it('RFC 7232 Section 3.2: Should honor If-None-Match for conditional GET', async () => {
      // Should return 304 for matching ETag
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-12345"')

      expect(response.status).toBe(304)
      expect(response.body).toEqual({})  // 304 has no message body
    })

    it('RFC 7232 Section 2.4: Should support Cache-Control header', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      expect(response.headers['cache-control']).toContain('must-revalidate')
    })
  })

  describe('Response structure validation', () => {
    beforeEach(() => {
      jest.spyOn(vaultStore, 'getVaultETag').mockResolvedValue('W/"-12345"')
    })

    it('should return valid vault object on 200 response', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .expect(200)

      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('creator')
      expect(response.body).toHaveProperty('amount')
      expect(response.body).toHaveProperty('status')
      expect(response.body).toHaveProperty('createdAt')
    })

    it('should return empty body on 304 response', async () => {
      const response = await request(app)
        .get('/api/vaults/vault-123')
        .set('Authorization', 'Bearer valid-token')
        .set('If-None-Match', 'W/"-12345"')
        .expect(304)

      // Supertest's response.body is empty for 304
      expect(Object.keys(response.body).length).toBe(0)
    })
  })
})
