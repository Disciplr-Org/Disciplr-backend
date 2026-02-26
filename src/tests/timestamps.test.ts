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
