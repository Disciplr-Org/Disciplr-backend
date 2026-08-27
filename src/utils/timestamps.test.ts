/* global describe, test, expect */
import {
  InvalidTimestampError,
  formatTimestamp,
  hasTimezoneDesignator,
  isValidISO8601,
  normalizeTimestamp,
  parseAndNormalizeToUTC,
  toUTCDate,
  utcEndOfDay,
  utcStartOfDay,
  utcNow,
} from './timestamps.js'
import { createVaultSchema } from '../services/vaultValidation.js'

const validAddress = 'GAP3SREQTGBQADRB5QUVLWC4RZZ62MFMQZ5CCEYMMCVQF7GFREISGZGL'

const validVault = (overrides: Record<string, unknown> = {}) => ({
  amount: '1000',
  startDate: '2026-01-01T00:00:00Z',
  endDate: '2026-12-31T23:59:59Z',
  verifier: validAddress,
  destinations: {
    success: validAddress,
    failure: validAddress,
  },
  milestones: [
    {
      title: 'Release',
      dueDate: '2026-06-01T12:00:00Z',
      amount: '1000',
    },
  ],
  ...overrides,
})

describe('strict UTC timestamp contract', () => {
  describe('format validation', () => {
    test.each([
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.123Z',
      '2026-01-01T00:00:00+05:30',
      '2026-01-01T00:00:00-04:00',
      '0000-01-01T00:00:00Z',
      '0099-12-31T23:59:59Z',
    ])('accepts %s', (value) => {
      expect(isValidISO8601(value)).toBe(true)
      expect(hasTimezoneDesignator(value)).toBe(true)
    })

    test.each([
      '2026-01-01T00:00:00',
      '2026-01-01 00:00:00Z',
      '2026-01-01T00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:60:00Z',
      '2026-01-01T00:00:60Z',
      '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00+05:60',
      '2026-01-01T00:00:00+99:00',
      '2026-01-01T00:00:00 UTC',
      'not-a-timestamp',
    ])('rejects ambiguous or malformed input %s', (value) => {
      expect(isValidISO8601(value)).toBe(false)
    })

    test.each([
      '2025-02-29T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-06-31T00:00:00Z',
      '2026-09-31T00:00:00Z',
      '2026-11-31T00:00:00Z',
    ])('rejects impossible calendar date %s', (value) => {
      expect(isValidISO8601(value)).toBe(false)
    })

    test.each([
      ['2024-02-29T23:59:59Z', true],
      ['2000-02-29T00:00:00Z', true],
      ['1900-02-29T00:00:00Z', false],
      ['0000-02-29T00:00:00Z', true],
    ])('handles leap-year rule for %s', (value, expected) => {
      expect(isValidISO8601(value)).toBe(expected)
    })
  })

  describe('normalization and equality', () => {
    test.each([
      ['2026-03-08T01:30:00-05:00', '2026-03-08T06:30:00.000Z'],
      ['2026-03-08T03:30:00-04:00', '2026-03-08T07:30:00.000Z'],
      ['2026-11-01T01:30:00-04:00', '2026-11-01T05:30:00.000Z'],
      ['2026-11-01T01:30:00-05:00', '2026-11-01T06:30:00.000Z'],
      ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
      ['1969-12-31T23:59:59.999Z', '1969-12-31T23:59:59.999Z'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(parseAndNormalizeToUTC(input)).toBe(expected)
      expect(normalizeTimestamp(input)).toBe(expected)
    })

    test('equivalent offset representations resolve to one instant', () => {
      const winter = normalizeTimestamp('2026-01-15T12:00:00-05:00')
      const utc = normalizeTimestamp('2026-01-15T17:00:00Z')
      const india = normalizeTimestamp('2026-01-15T22:30:00+05:30')

      expect(winter).toBe(utc)
      expect(utc).toBe(india)
      expect(toUTCDate(winter).getTime()).toBe(toUTCDate(india).getTime())
    })

    test('normalizes Date values returned by database drivers', () => {
      const databaseValue = new Date('2026-02-28T23:59:59.999Z')
      expect(normalizeTimestamp(databaseValue)).toBe('2026-02-28T23:59:59.999Z')
      expect(toUTCDate(databaseValue).toISOString()).toBe(databaseValue.toISOString())
    })

    test('rejects an invalid Date rather than returning a misleading value', () => {
      expect(() => normalizeTimestamp(new Date('invalid'))).toThrow(InvalidTimestampError)
      expect(() => toUTCDate('2026-02-30T00:00:00Z')).toThrow(InvalidTimestampError)
    })

    test('requires timezone when normalizing strings', () => {
      expect(() => normalizeTimestamp('2026-01-01T00:00:00')).toThrow(InvalidTimestampError)
      expect(() => parseAndNormalizeToUTC('2026-01-01T00:00:00')).toThrow('Invalid ISO 8601')
    })
  })

  describe('UTC day boundaries', () => {
    test('does not let a local timezone move the day boundary', () => {
      expect(utcStartOfDay('2026-03-08T23:30:00-05:00')).toBe('2026-03-09T00:00:00.000Z')
      expect(utcEndOfDay('2026-03-08T23:30:00-05:00')).toBe('2026-03-09T23:59:59.999Z')
    })

    test('handles the epoch edge without local-date arithmetic', () => {
      expect(utcStartOfDay('1969-12-31T23:59:59.999Z')).toBe('1969-12-31T00:00:00.000Z')
      expect(utcEndOfDay('1970-01-01T00:00:00Z')).toBe('1970-01-01T23:59:59.999Z')
    })

    test('keeps leap day boundaries in UTC', () => {
      expect(utcStartOfDay('2024-02-29T23:59:00+14:00')).toBe('2024-02-29T00:00:00.000Z')
      expect(utcEndOfDay('2024-02-29T23:59:00+14:00')).toBe('2024-02-29T23:59:59.999Z')
    })
  })

  describe('schema and API boundary', () => {
    test('normalizes every accepted vault timestamp before persistence', () => {
      const result = createVaultSchema.parse(validVault({
        startDate: '2026-01-01T00:00:00-05:00',
        endDate: '2026-12-31T18:00:00-05:00',
        milestones: [{
          title: 'Release',
          dueDate: '2026-06-01T08:00:00-04:00',
          amount: '1000',
        }],
      }))

      expect(result.startDate).toBe('2026-01-01T05:00:00.000Z')
      expect(result.endDate).toBe('2026-12-31T23:00:00.000Z')
      expect(result.milestones[0].dueDate).toBe('2026-06-01T12:00:00.000Z')
    })

    test('rejects timezone-less vault and milestone values', () => {
      const result = createVaultSchema.safeParse(validVault({
        startDate: '2026-01-01T00:00:00',
        milestones: [{
          title: 'Release',
          dueDate: '2026-06-01T12:00:00',
          amount: '1000',
        }],
      }))

      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((issue) => issue.message)
        expect(messages).toContain('must include timezone (Z or +/-HH:MM)')
      }
    })

    test('compares instants, not wall-clock strings, around DST', () => {
      const before = toUTCDate('2026-03-08T01:59:59-05:00')
      const after = toUTCDate('2026-03-08T03:00:00-04:00')
      expect(after.getTime() - before.getTime()).toBe(1_000)
    })

    test('returns canonical UTC output for current timestamps', () => {
      expect(utcNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    test('formats a canonical instant without changing its meaning', () => {
      expect(formatTimestamp('2026-01-01T17:30:00.000Z', {
        locale: 'en-GB',
        timeZone: 'UTC',
        style: 'short',
      })).toContain('17:30')
    })
  })

  describe('round-trip stability matrix', () => {
    test.each([
      '1970-01-01T00:00:00.000Z',
      '2000-02-29T12:34:56.789Z',
      '2026-03-08T07:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2038-01-19T03:14:07.000Z',
      '2099-12-31T23:59:59.999Z',
    ])('is idempotent for canonical value %s', (value) => {
      const once = normalizeTimestamp(value)
      expect(normalizeTimestamp(once)).toBe(once)
      expect(toUTCDate(once).toISOString()).toBe(once)
    })

    test.each([
      ['2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00.000Z'],
      ['2026-01-01T00:00:00+14:00', '2025-12-31T10:00:00.000Z'],
      ['2026-01-01T00:00:00-12:00', '2026-01-01T12:00:00.000Z'],
      ['2026-07-01T23:59:59.999+05:45', '2026-07-01T18:14:59.999Z'],
    ])('keeps offset boundary %s stable', (input, expected) => {
      expect(normalizeTimestamp(input)).toBe(expected)
      expect(normalizeTimestamp(normalizeTimestamp(input))).toBe(expected)
    })

    test('never treats a local process timezone as part of the contract', () => {
      const explicitUtc = normalizeTimestamp('2026-05-05T12:00:00Z')
      const explicitOffset = normalizeTimestamp('2026-05-05T17:30:00+05:30')
      expect(explicitUtc).toBe(explicitOffset)
      expect(explicitUtc.endsWith('Z')).toBe(true)
    })

    test('keeps ordering stable across offset changes', () => {
      const values = [
        '2026-03-08T01:59:59-05:00',
        '2026-03-08T03:00:00-04:00',
        '2026-03-08T04:00:00-04:00',
      ].map(toUTCDate)

      expect(values[0].getTime()).toBeLessThan(values[1].getTime())
      expect(values[1].getTime()).toBeLessThan(values[2].getTime())
    })
  })
})
