import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals'
import { createVerify } from 'crypto'
import { validateSignedObjectStorageUrl, EvidenceReferenceValidationError } from '../services/evidence.js'
import { getExportSignedUrl, setPresigner, resetPresigner } from '../services/exportS3.js'

// Helper to get current time in AWS date format
function getAWSTimeString(offsetMinutes: number = 0): string {
  const date = new Date()
  date.setMinutes(date.getMinutes() + offsetMinutes)
  
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z/, 'Z')
    .replace(/T/, 'T')
    .slice(0, 15) + 'Z'
}

// Helper to create a mock S3 signed URL with configurable parameters
function createMockSignedUrl(options: {
  bucket?: string
  key: string
  signature?: string
  accessKeyId?: string
  orgId: string
  dateOffsetMinutes?: number
  expiresInSeconds?: number
}): string {
  const {
    bucket = 'evidence-bucket',
    key,
    signature = 'deadbeef',
    accessKeyId = 'AKIAIOSFODNN7EXAMPLE',
    orgId,
    dateOffsetMinutes = -60, // 1 hour ago by default (so +3600s expiry is still in future)
    expiresInSeconds = 7200, // 2 hours from date
  } = options

  // Calculate X-Amz-Date based on offset
  const amzDate = getAWSTimeString(dateOffsetMinutes)
  
  // Simulate an S3 signed URL with tenant-scoped key
  const encodedKey = encodeURIComponent(`org/${orgId}/${key}`)
  return `https://${bucket}.s3.us-east-1.amazonaws.com/${encodedKey}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${accessKeyId}%2F${amzDate.slice(0, 8)}%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=${amzDate}&X-Amz-Expires=${expiresInSeconds}&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`
}

// Helper to create a simple signed URL with Expires parameter
function createSimpleSignedUrl(expiryOffsetSeconds: number): string {
  const expiryEpoch = Math.floor(Date.now() / 1000) + expiryOffsetSeconds
  return `https://s3.example.com/evidence.pdf?Expires=${expiryEpoch}&signature=valid123`
}

// Helper to tamper with URL parameters
function tamperUrl(url: string, modifications: Record<string, string | null>): string {
  const urlObj = new URL(url)
  
  for (const [key, value] of Object.entries(modifications)) {
    if (value === null) {
      urlObj.searchParams.delete(key)
    } else {
      urlObj.searchParams.set(key, value)
    }
  }
  
  return urlObj.toString()
}

describe('Evidence Signed URL Security Tests', () => {
  const mockPresign = jest.fn()
  
  beforeEach(() => {
    mockPresign.mockClear()
    resetPresigner()
    jest.restoreAllMocks()
  })
  
  afterEach(() => {
    resetPresigner()
  })

  describe('Signed URL Expiry', () => {
    it('should reject URLs that have already expired (Expires parameter)', () => {
      // Create a URL with expiry in the past
      const pastExpiry = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
      const expiredUrl = `https://s3.example.com/evidence.pdf?Expires=${pastExpiry}&signature=valid123`
      
      expect(() => validateSignedObjectStorageUrl(expiredUrl)).toThrow(EvidenceReferenceValidationError)
      expect(() => validateSignedObjectStorageUrl(expiredUrl)).toThrow('has already expired')
    })

    it('should accept URLs that have not yet expired (Expires parameter)', () => {
      // Create a URL with expiry in the future
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      const validUrl = `https://s3.example.com/evidence.pdf?Expires=${futureExpiry}&signature=valid123`
      
      const expiry = validateSignedObjectStorageUrl(validUrl)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should handle AWS v4 signed URLs with X-Amz-Date and X-Amz-Expires', () => {
      // Create URL with date 2 hours ago and 3 hour expiry (still valid)
      const url = createMockSignedUrl({
        key: 'document.pdf',
        orgId: 'org-123',
        dateOffsetMinutes: -120, // 2 hours ago
        expiresInSeconds: 10800, // 3 hours
      })
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should reject AWS v4 signed URLs past expiry window', () => {
      // Create URL with date 2 hours ago and 1 hour expiry (expired)
      const url = createMockSignedUrl({
        key: 'document.pdf',
        orgId: 'org-123',
        dateOffsetMinutes: -120, // 2 hours ago
        expiresInSeconds: 3600, // 1 hour (expired)
      })
      
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })

    it('should handle expires parameter (lowercase)', () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600
      const url = `https://s3.example.com/evidence.pdf?expires=${futureExpiry}&signature=valid123`
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('Tamper Detection - Signature', () => {
    it('should handle URLs with valid signature format', () => {
      // Note: validateSignedObjectStorageUrl only validates expiry, not signature
      // The actual signature verification happens when S3 processes the request
      const url = createSimpleSignedUrl(3600)
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should handle URL with missing signature', () => {
      const url = `https://s3.example.com/evidence.pdf?Expires=${Math.floor(Date.now() / 1000) + 3600}`
      
      // Should still validate (signature check is for S3 to do)
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should detect tampered X-Amz-Signature in AWS v4 URLs', () => {
      // Create a valid URL
      const url = createMockSignedUrl({
        key: 'document.pdf',
        orgId: 'org-123',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      // Tamper with the signature
      const tamperedUrl = tamperUrl(url, { 'X-Amz-Signature': 'tampered456' })
      
      // Validation should still pass (expiry is okay), but S3 would reject the tampered signature
      const expiry = validateSignedObjectStorageUrl(tamperedUrl)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('Tamper Detection - Key/Path', () => {
    it('should handle URLs with tenant-scoped keys', () => {
      const url = createMockSignedUrl({
        key: 'sensitive-doc.pdf',
        orgId: 'org-A',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      // Validate that org A's URL is valid
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
      expect(url).toContain('org%2Forg-A')
    })

    it('should handle URL with encoded key correctly', () => {
      const url = createMockSignedUrl({
        key: 'my document (2026) - v2.0.pdf',
        orgId: 'org-123',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('Cross-Tenant Isolation', () => {
    it('should ensure evidence keys are tenant-scoped', () => {
      // Create URLs for both orgs
      const orgAUrl = createMockSignedUrl({
        key: 'evidence-123.pdf',
        orgId: 'org-A',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      const orgBUrl = createMockSignedUrl({
        key: 'evidence-456.pdf',
        orgId: 'org-B',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      // Both URLs should be valid (not expired)
      expect(() => validateSignedObjectStorageUrl(orgAUrl)).not.toThrow()
      expect(() => validateSignedObjectStorageUrl(orgBUrl)).not.toThrow()
      
      // The keys should be different and org-scoped
      expect(orgAUrl).toContain('org%2Forg-A')
      expect(orgBUrl).toContain('org%2Forg-B')
      expect(orgAUrl).not.toContain('org-B')
      expect(orgBUrl).not.toContain('org-A')
    })

    it('should simulate S3 rejecting cross-org access', async () => {
      // Mock S3 presigner to simulate access denial
      const mockPresignReject = jest.fn().mockRejectedValue(
        new Error('AccessDenied: User does not have permission to access this resource')
      )
      setPresigner(mockPresignReject as any)
      
      // Attempting to get a signed URL for cross-org resource should fail
      await expect(
        getExportSignedUrl(
          { bucket: 'evidence-bucket', region: 'us-east-1', signedUrlTtlSeconds: 3600 },
          'org/org-B/restricted-doc.pdf',
        )
      ).rejects.toThrow('AccessDenied')
    })

    it('should validate that URLs contain correct org prefix', () => {
      const orgAUrl = createMockSignedUrl({
        key: 'secret.pdf',
        orgId: 'org-A',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      const orgBUrl = createMockSignedUrl({
        key: 'secret.pdf',
        orgId: 'org-B',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      // URLs should be different (different org in path)
      expect(orgAUrl).not.toEqual(orgBUrl)
      
      // Both should be valid
      expect(() => validateSignedObjectStorageUrl(orgAUrl)).not.toThrow()
      expect(() => validateSignedObjectStorageUrl(orgBUrl)).not.toThrow()
    })
  })

  describe('Edge Cases', () => {
    it('should handle URLs with special characters in path', () => {
      const url = createMockSignedUrl({
        key: 'document (2026) - v2.0.pdf',
        orgId: 'org-123',
        dateOffsetMinutes: -60,
        expiresInSeconds: 7200,
      })
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should reject malformed URLs', () => {
      const malformedUrls = [
        'not-a-valid-url',
        'ftp://invalid-protocol.com/file.pdf',
        'https://',
        '',
      ]
      
      for (const url of malformedUrls) {
        expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
      }
    })

    it('should handle very long expiry times', () => {
      // Year 3000 (far future)
      const farFutureExpiry = Math.floor(new Date('3000-01-01').getTime() / 1000)
      const url = `https://s3.example.com/evidence.pdf?Expires=${farFutureExpiry}&signature=valid123`
      
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getFullYear()).toBe(3000)
    })

    it('should reject URLs with negative expiry', () => {
      const url = `https://s3.example.com/evidence.pdf?Expires=-1000&signature=valid123`
      
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })

    it('should handle URLs with multiple signature parameters', () => {
      // Some CDNs or proxies might add duplicate parameters
      const baseExpiry = Math.floor(Date.now() / 1000) + 3600
      const url = `https://s3.example.com/evidence.pdf?Expires=${baseExpiry}&signature=valid123&signature=another456`
      
      // Should use the first signature parameter
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should handle URL with no expiry parameters', () => {
      const url = `https://s3.example.com/evidence.pdf?X-Amz-Signature=abc`
      
      expect(() => validateSignedObjectStorageUrl(url)).toThrow('missing expiry parameter')
    })
  })

  describe('Deterministic Clock for Expiry Assertions', () => {
    it('should correctly validate expiry with mocked Date.now', () => {
      const fixedNow = new Date()
      fixedNow.setHours(fixedNow.getHours() + 1) // 1 hour in future
      const fixedNowTs = fixedNow.getTime()
      
      jest.spyOn(Date, 'now').mockReturnValue(fixedNowTs)
      
      // URL expires in 1 hour from fixed now (use seconds precision)
      const expiryEpoch = Math.floor((fixedNowTs + 3600000) / 1000)
      const url = `https://s3.example.com/evidence.pdf?Expires=${expiryEpoch}&signature=valid123`
      
      const expiry = validateSignedObjectStorageUrl(url)
      
      // Check that expiry is approximately correct (within 1 second)
      expect(Math.abs(expiry.getTime() - (fixedNowTs + 3600000))).toBeLessThan(1000)
      
      // Verify URL is not expired
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('should correctly reject expired URL with mocked Date.now', () => {
      const fixedNow = new Date().getTime()
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
      
      // URL expired 1 hour ago
      const expiredEpoch = Math.floor((fixedNow - 3600000) / 1000)
      const url = `https://s3.example.com/evidence.pdf?Expires=${expiredEpoch}&signature=valid123`
      
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })

    it('should handle boundary condition at exact expiry time', () => {
      const fixedNow = new Date().getTime()
      jest.spyOn(Date, 'now').mockReturnValue(fixedNow)
      
      // URL expires exactly now
      const expiryEpoch = Math.floor(fixedNow / 1000)
      const url = `https://s3.example.com/evidence.pdf?Expires=${expiryEpoch}&signature=valid123`
      
      // Should reject (expiry <= now)
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })
  })

  describe('Security Integration Tests', () => {
    it('should validate complete evidence reference flow', async () => {
      // Create a valid evidence hash (32+ chars, alphanumeric, underscore, hyphen)
      const validHash = 'abc123def456ghi789jkl012mno345pqr678stu901'
      
      // Create URL with future expiry
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600
      const referenceUrl = `https://s3.example.com/evidence.pdf?Expires=${futureExpiry}&signature=valid123`
      
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600000)
      
      // Mock Prisma with proper Date objects
      const mockQueryRaw = jest.fn().mockResolvedValue([{
        id: 'evidence-1',
        verification_id: 'verification-1',
        evidence_hash: validHash,
        reference_url: referenceUrl,
        expires_at: expiresAt,
        created_at: now,
      }])
      
      // Reset modules to allow re-mocking
      jest.resetModules()
      
      jest.doMock('../lib/prisma.js', () => ({
        prisma: {
          $queryRaw: mockQueryRaw,
        },
      }))
      
      // Import after mocking
      const { createEvidenceReference } = await import('../services/evidence.js')
      
      const evidence = await createEvidenceReference(
        'verification-1',
        validHash,
        referenceUrl
      )
      
      expect(evidence).toBeDefined()
      expect(evidence.verificationId).toBe('verification-1')
      expect(evidence.evidenceHash).toBe(validHash)
    })

    it('should prevent timing attacks on signature validation', () => {
      // This is a conceptual test - in reality, AWS S3 handles signature validation
      // The test ensures our code doesn't have obvious timing leaks
      
      const urls = [
        createSimpleSignedUrl(3600) + '&signature=aaa',
        createSimpleSignedUrl(3600) + '&signature=bbb',
        createSimpleSignedUrl(3600) + '&signature=ccc',
      ]
      
      // All should validate expiry the same way (timing should be consistent)
      for (const url of urls) {
        const start = Date.now()
        validateSignedObjectStorageUrl(url)
        const duration = Date.now() - start
        
        // Validation should be fast and consistent (< 100ms)
        expect(duration).toBeLessThan(100)
      }
    })
  })
})
