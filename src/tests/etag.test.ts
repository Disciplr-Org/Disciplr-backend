import { describe, it, expect } from 'bun:test'
import { computeWeakETag, etagMatches, isValidETag, compareETags } from '../utils/etag.js'

describe('ETag Utilities', () => {
  describe('computeWeakETag', () => {
    it('returns a weak ETag for a string version', () => {
      expect(computeWeakETag('123')).toBe('W/"-123"')
    })

    it('returns a weak ETag for a number version', () => {
      expect(computeWeakETag(456)).toBe('W/"-456"')
    })
  })

  describe('etagMatches', () => {
    it('returns false if ifNoneMatch is undefined', () => {
      expect(etagMatches(undefined, 'W/"-123"')).toBe(false)
    })

    it('returns true for wildcard match', () => {
      expect(etagMatches('*', 'W/"-123"')).toBe(true)
    })

    it('returns true for exact weak match', () => {
      expect(etagMatches('W/"-123"', 'W/"-123"')).toBe(true)
    })

    it('returns true if one candidate in comma-separated list matches', () => {
      expect(etagMatches('W/"-456", W/"-123", W/"-789"', 'W/"-123"')).toBe(true)
    })

    it('returns false if no candidates match', () => {
      expect(etagMatches('W/"-456", W/"-789"', 'W/"-123"')).toBe(false)
    })

    it('handles weak-to-strong semantic comparison', () => {
      expect(etagMatches('"123"', 'W/"123"')).toBe(true)
      expect(etagMatches('W/"123"', '"123"')).toBe(true)
    })
  })

  describe('isValidETag', () => {
    it('returns true for valid weak ETags', () => {
      expect(isValidETag('W/"-123"')).toBe(true)
      expect(isValidETag('W/"some-hash"')).toBe(true)
    })

    it('returns true for valid strong ETags', () => {
      expect(isValidETag('"-123"')).toBe(true)
      expect(isValidETag('"some-hash"')).toBe(true)
    })

    it('returns false for invalid formats', () => {
      expect(isValidETag('123')).toBe(false)
      expect(isValidETag('W/-123')).toBe(false)
      expect(isValidETag('"-123')).toBe(false)
      expect(isValidETag('W/123"')).toBe(false)
    })
  })

  describe('compareETags', () => {
    it('returns false if either ETag is invalid', () => {
      expect(compareETags('123', 'W/"-123"')).toBe(false)
      expect(compareETags('W/"-123"', '123')).toBe(false)
    })

    it('handles strong comparison (exact match only)', () => {
      expect(compareETags('"-123"', '"-123"', false)).toBe(true)
      expect(compareETags('W/"-123"', 'W/"-123"', false)).toBe(true)
      expect(compareETags('W/"-123"', '"-123"', false)).toBe(false)
    })

    it('handles weak comparison (strips W/)', () => {
      expect(compareETags('W/"-123"', '"-123"', true)).toBe(true)
      expect(compareETags('"-123"', 'W/"-123"', true)).toBe(true)
      expect(compareETags('W/"-123"', 'W/"-123"', true)).toBe(true)
      expect(compareETags('"-123"', '"-123"', true)).toBe(true)
    })
    
    it('defaults to weak comparison', () => {
      expect(compareETags('W/"-123"', '"-123"')).toBe(true)
    })
  })
})
