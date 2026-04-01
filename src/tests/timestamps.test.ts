import {
  isValidISO8601,
  parseAndNormalizeToUTC,
  utcNow,
  formatTimestamp,
} from '../utils/timestamps.js'

// ── isValidISO8601 ──────────────────────────────────────────────

describe('isValidISO8601', () => {
  it('accepts UTC (Z suffix)', () => {
    expect(isValidISO8601('2025-06-15T12:30:00Z')).toBe(true)
  })

  it('accepts UTC with milliseconds', () => {
    expect(isValidISO8601('2025-06-15T12:30:00.123Z')).toBe(true)
  })

  it('accepts positive offset', () => {
    expect(isValidISO8601('2025-06-15T18:00:00+05:30')).toBe(true)
  })

  it('accepts negative offset', () => {
    expect(isValidISO8601('2025-06-15T08:00:00-04:00')).toBe(true)
  })

  it('rejects timestamp without timezone', () => {
    expect(isValidISO8601('2025-06-15T12:30:00')).toBe(false)
  })

  it('rejects date-only string', () => {
    expect(isValidISO8601('2025-06-15')).toBe(false)
  })

  it('rejects plain text', () => {
    expect(isValidISO8601('not-a-date')).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidISO8601(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidISO8601(undefined)).toBe(false)
  })

  it('rejects a number', () => {
    expect(isValidISO8601(1234567890)).toBe(false)
  })

  it('rejects impossible month (13)', () => {
    expect(isValidISO8601('2025-13-15T12:00:00Z')).toBe(false)
  })

  it('rejects impossible day (Feb 30)', () => {
    expect(isValidISO8601('2025-02-30T12:00:00Z')).toBe(false)
  })

  it('rejects impossible day (Apr 31)', () => {
    expect(isValidISO8601('2025-04-31T12:00:00Z')).toBe(false)
  })

  it('accepts Feb 29 in a leap year', () => {
    expect(isValidISO8601('2024-02-29T00:00:00Z')).toBe(true)
  })

  it('rejects Feb 29 in a non-leap year', () => {
    expect(isValidISO8601('2025-02-29T00:00:00Z')).toBe(false)
  })
})

// ── parseAndNormalizeToUTC ──────────────────────────────────────

describe('parseAndNormalizeToUTC', () => {
  it('keeps UTC string as-is (ends in Z)', () => {
    const result = parseAndNormalizeToUTC('2025-06-15T12:30:00Z')
    expect(result).toBe('2025-06-15T12:30:00.000Z')
  })

  it('normalizes positive offset to UTC', () => {
    const result = parseAndNormalizeToUTC('2025-06-15T18:00:00+05:30')
    expect(result).toBe('2025-06-15T12:30:00.000Z')
  })

  it('normalizes negative offset to UTC', () => {
    const result = parseAndNormalizeToUTC('2025-06-15T08:30:00-04:00')
    expect(result).toBe('2025-06-15T12:30:00.000Z')
  })

  it('throws on invalid input', () => {
    expect(() => parseAndNormalizeToUTC('not-a-date')).toThrow('Invalid ISO 8601 timestamp')
  })

  it('throws on timestamp without timezone', () => {
    expect(() => parseAndNormalizeToUTC('2025-06-15T12:30:00')).toThrow('Invalid ISO 8601 timestamp')
  })

  // DST edge cases: explicit offsets encode DST state at parse time.
  // Same local time with different offsets yields different UTC times.

  it('handles US Eastern DST fall-back (EDT->EST)', () => {
    // 2025-11-02 01:30 AM EDT (DST active, offset -04:00)
    const edt = parseAndNormalizeToUTC('2025-11-02T01:30:00-04:00')
    expect(edt).toBe('2025-11-02T05:30:00.000Z')
    // 2025-11-02 01:30 AM EST (DST ended, offset -05:00)
    // Same local time, different offset = different UTC
    const est = parseAndNormalizeToUTC('2025-11-02T01:30:00-05:00')
    expect(est).toBe('2025-11-02T06:30:00.000Z')
    expect(edt).not.toBe(est)
  })

  it('handles US Eastern DST spring-forward (EST->EDT)', () => {
    // 2025-03-09 01:59 AM EST (last moment before DST)
    const est = parseAndNormalizeToUTC('2025-03-09T01:59:00-05:00')
    expect(est).toBe('2025-03-09T06:59:00.000Z')
    // 2025-03-09 03:00 AM EDT (first moment after DST spring-forward)
    // 2:00-3:00 AM does not exist; explicit offset -04:00 handles this
    const edt = parseAndNormalizeToUTC('2025-03-09T03:00:00-04:00')
    expect(edt).toBe('2025-03-09T07:00:00.000Z')
  })

  it('handles Southern Hemisphere DST (Australia)', () => {
    // 2025-04-06 02:30 AM AEDT (DST active, offset +11:00)
    const aedt = parseAndNormalizeToUTC('2025-04-06T02:30:00+11:00')
    expect(aedt).toBe('2025-04-05T15:30:00.000Z')
    // 2025-04-06 02:30 AM AEST (DST ended, offset +10:00)
    const aest = parseAndNormalizeToUTC('2025-04-06T02:30:00+10:00')
    expect(aest).toBe('2025-04-05T16:30:00.000Z')
    expect(aedt).not.toBe(aest)
  })

  it('handles Europe London DST (GMT->BST)', () => {
    // 2025-03-30 01:00 GMT (last moment before BST starts)
    const gmt = parseAndNormalizeToUTC('2025-03-30T01:00:00+00:00')
    expect(gmt).toBe('2025-03-30T01:00:00.000Z')
    // 2025-03-30 02:00 BST (DST active, offset +01:00)
    const bst = parseAndNormalizeToUTC('2025-03-30T02:00:00+01:00')
    expect(bst).toBe('2025-03-30T01:00:00.000Z')
  })

  it('handles timestamps with milliseconds during DST transition', () => {
    const result = parseAndNormalizeToUTC('2025-11-02T01:30:00.500-04:00')
    expect(result).toBe('2025-11-02T05:30:00.500Z')
  })

  it('handles positive offset during DST transition', () => {
    // 2025-03-30 02:00 BST (Europe/London DST starts, offset +01:00)
    const result = parseAndNormalizeToUTC('2025-03-30T02:00:00+01:00')
    expect(result).toBe('2025-03-30T01:00:00.000Z')
  })

  it('handles large positive offset (Pacific/Honolulu, no DST)', () => {
    // Hawaii doesn't observe DST; offset is always -10:00
    const result = parseAndNormalizeToUTC('2025-06-15T12:30:00-10:00')
    expect(result).toBe('2025-06-15T22:30:00.000Z')
  })

  it('handles large positive offset (Pacific/Auckland, Southern Hemisphere DST)', () => {
    // New Zealand DST: +13:00 during summer (Dec 25 is summer in Southern Hemisphere)
    // 12:00 - 13:00 = -1:00 = 23:00 previous day UTC
    const summer = parseAndNormalizeToUTC('2025-12-25T12:00:00+13:00')
    expect(summer).toBe('2025-12-24T23:00:00.000Z')
    // New Zealand winter: +12:00 (June 15 is winter in Southern Hemisphere)
    // 12:00 - 12:00 = 00:00 same day UTC
    const winter = parseAndNormalizeToUTC('2025-06-15T12:00:00+12:00')
    expect(winter).toBe('2025-06-15T00:00:00.000Z')
  })
})

// ── utcNow ─────────────────────────────────────────────────────

describe('utcNow', () => {
  it('returns a valid ISO 8601 string ending in Z', () => {
    const now = utcNow()
    expect(isValidISO8601(now)).toBe(true)
    expect(now).toMatch(/Z$/)
  })

  it('returns a timestamp close to Date.now()', () => {
    const before = Date.now()
    const now = utcNow()
    const after = Date.now()
    const ts = new Date(now).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

// ── formatTimestamp ────────────────────────────────────────────

describe('formatTimestamp', () => {
  const iso = '2025-06-15T12:30:00Z'

  it('formats with default options (en-US, UTC, medium)', () => {
    const result = formatTimestamp(iso)
    expect(result).toContain('2025')
    expect(typeof result).toBe('string')
  })

  it('formats with Spanish locale', () => {
    const result = formatTimestamp(iso, { locale: 'es-ES' })
    expect(result).toContain('2025')
  })

  it('formats with America/New_York timezone', () => {
    const result = formatTimestamp(iso, { timeZone: 'America/New_York' })
    // 12:30 UTC = 8:30 AM ET (EDT in June)
    expect(result).toContain('8:30')
  })

  it('formats with short style', () => {
    const short = formatTimestamp(iso, { style: 'short' })
    const long = formatTimestamp(iso, { style: 'long' })
    expect(long.length).toBeGreaterThan(short.length)
  })

  it('throws on invalid timestamp', () => {
    expect(() => formatTimestamp('garbage')).toThrow('Invalid timestamp for formatting')
  })
})
