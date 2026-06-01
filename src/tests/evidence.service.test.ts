import { jest } from '@jest/globals'

const mockQueryRaw = jest.fn()

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
}))

const { createEvidenceReference, validateSignedObjectStorageUrl, EvidenceReferenceValidationError } = await import('../services/evidence.js')

describe('evidence service', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset()
  })

  test('validates AWS v4 signed object-storage URL expiry', () => {
    const url = 'https://s3.example.com/object.txt?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
    const expiry = validateSignedObjectStorageUrl(url)
    expect(expiry.getTime()).toBeGreaterThan(Date.now())
  })

  test('rejects expired signed object-storage URLs', () => {
    const url = 'https://s3.example.com/object.txt?X-Amz-Date=20200101T000000Z&X-Amz-Expires=60&X-Amz-Signature=abc'
    expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
  })

  test('rejects signed object-storage URLs missing expiry parameters', () => {
    const url = 'https://s3.example.com/object.txt?X-Amz-Signature=abc'
    expect(() => validateSignedObjectStorageUrl(url)).toThrow('missing expiry parameter')
  })

  test('persists evidence references via Prisma raw SQL', async () => {
    const fakeRow = [{
      id: 'evidence-1',
      verification_id: 'verification-1',
      evidence_hash: 'hash-0123456789abcdef0123456789abcdef',
      reference_url: 'https://example.com?Expires=32503680000&signature=abc',
      expires_at: new Date('2030-01-01T00:00:00.000Z'),
      created_at: new Date('2026-05-27T00:00:00.000Z'),
    }]

    mockQueryRaw.mockResolvedValueOnce(fakeRow)

    const evidence = await createEvidenceReference(
      'verification-1',
      'hash-0123456789abcdef0123456789abcdef',
      'https://example.com/object.pdf?Expires=32503680000&signature=abc',
    )

    expect(mockQueryRaw).toHaveBeenCalled()
    expect(evidence).toEqual({
      id: 'evidence-1',
      verificationId: 'verification-1',
      evidenceHash: 'hash-0123456789abcdef0123456789abcdef',
      referenceUrl: 'https://example.com?Expires=32503680000&signature=abc',
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-05-27T00:00:00.000Z',
    })
  })
})
