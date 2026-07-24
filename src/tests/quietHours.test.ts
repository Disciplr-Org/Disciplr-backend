import { describe, it, expect } from 'vitest'
import {
  parseTimeToMinutes,
  getLocalMinutes,
  isInQuietHours,
  getQuietHoursEndUTC,
  isValidTimezone,
  isValidTimeFormat,
  QuietHoursConfig,
} from '../utils/quietHours.js'

describe('quietHours utilities', () => {
  describe('parseTimeToMinutes', () => {
    it('parses midnight correctly', () => {
      expect(parseTimeToMinutes('00:00')).toBe(0)
    })

    it('parses noon correctly', () => {
      expect(parseTimeToMinutes('12:00')).toBe(720)
    })

    it('parses end of day correctly', () => {
      expect(parseTimeToMinutes('23:59')).toBe(1439)
    })

    it('parses arbitrary time correctly', () => {
      expect(parseTimeToMinutes('22:30')).toBe(1350)
    })
  })

  describe('getLocalMinutes', () => {
    it('returns correct minutes for UTC', () => {
      const date = new Date('2024-06-15T14:30:00Z')
      expect(getLocalMinutes(date, 'UTC')).toBe(870) // 14 * 60 + 30
    })

    it('handles timezone offset correctly', () => {
      const date = new Date('2024-06-15T14:30:00Z')
      // America/New_York is UTC-4 in summer (EDT)
      // 14:30 UTC = 10:30 EDT = 630 minutes
      const minutes = getLocalMinutes(date, 'America/New_York')
      expect(minutes).toBe(630)
    })
  })

  describe('isInQuietHours', () => {
    describe('same-day window (09:00-17:00)', () => {
      const config: QuietHoursConfig = {
        timezone: 'UTC',
        startTime: '09:00',
        endTime: '17:00',
      }

      it('returns true when inside window', () => {
        const date = new Date('2024-06-15T12:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns true at start boundary', () => {
        const date = new Date('2024-06-15T09:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns false at end boundary', () => {
        const date = new Date('2024-06-15T17:00:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })

      it('returns false when outside window (before)', () => {
        const date = new Date('2024-06-15T08:59:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })

      it('returns false when outside window (after)', () => {
        const date = new Date('2024-06-15T20:00:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })
    })

    describe('overnight window (22:00-08:00)', () => {
      const config: QuietHoursConfig = {
        timezone: 'UTC',
        startTime: '22:00',
        endTime: '08:00',
      }

      it('returns true at 23:00', () => {
        const date = new Date('2024-06-15T23:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns true at 03:00', () => {
        const date = new Date('2024-06-15T03:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns true at start boundary', () => {
        const date = new Date('2024-06-15T22:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns false at end boundary', () => {
        const date = new Date('2024-06-15T08:00:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })

      it('returns false at noon', () => {
        const date = new Date('2024-06-15T12:00:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })
    })

    describe('timezone-aware window', () => {
      const config: QuietHoursConfig = {
        timezone: 'America/New_York',
        startTime: '22:00',
        endTime: '08:00',
      }

      it('returns true when local time is in quiet hours', () => {
        // 03:00 UTC = 23:00 EDT (previous day) - in quiet hours
        const date = new Date('2024-06-15T03:00:00Z')
        expect(isInQuietHours(date, config)).toBe(true)
      })

      it('returns false when local time is outside quiet hours', () => {
        // 18:00 UTC = 14:00 EDT - not in quiet hours
        const date = new Date('2024-06-15T18:00:00Z')
        expect(isInQuietHours(date, config)).toBe(false)
      })
    })

    describe('edge cases', () => {
      it('handles midnight crossing correctly', () => {
        const config: QuietHoursConfig = {
          timezone: 'UTC',
          startTime: '23:00',
          endTime: '00:30',
        }

        // At midnight - should be in quiet hours
        const midnight = new Date('2024-06-15T00:00:00Z')
        expect(isInQuietHours(midnight, config)).toBe(true)

        // At 00:29 - should be in quiet hours
        const beforeEnd = new Date('2024-06-15T00:29:00Z')
        expect(isInQuietHours(beforeEnd, config)).toBe(true)

        // At 00:30 - should be out of quiet hours
        const atEnd = new Date('2024-06-15T00:30:00Z')
        expect(isInQuietHours(atEnd, config)).toBe(false)
      })
    })
  })

  describe('getQuietHoursEndUTC', () => {
    it('returns today end time if not yet passed', () => {
      const config: QuietHoursConfig = {
        timezone: 'UTC',
        startTime: '22:00',
        endTime: '08:00',
      }

      // At 03:00 UTC, quiet hours end at 08:00 UTC same day
      const date = new Date('2024-06-15T03:00:00Z')
      const endUTC = getQuietHoursEndUTC(date, config)

      expect(endUTC.getUTCHours()).toBe(8)
      expect(endUTC.getUTCMinutes()).toBe(0)
      expect(endUTC.getUTCDate()).toBe(15)
    })

    it('returns tomorrow end time if today already passed', () => {
      const config: QuietHoursConfig = {
        timezone: 'UTC',
        startTime: '22:00',
        endTime: '08:00',
      }

      // At 23:00 UTC, quiet hours end at 08:00 UTC next day
      const date = new Date('2024-06-15T23:00:00Z')
      const endUTC = getQuietHoursEndUTC(date, config)

      expect(endUTC.getUTCHours()).toBe(8)
      expect(endUTC.getUTCMinutes()).toBe(0)
      expect(endUTC.getUTCDate()).toBe(16)
    })

    it('handles timezone offset correctly', () => {
      const config: QuietHoursConfig = {
        timezone: 'America/New_York',
        startTime: '22:00',
        endTime: '08:00',
      }

      // At 03:00 UTC = 23:00 EDT previous day
      // Quiet hours end at 08:00 EDT = 12:00 UTC
      const date = new Date('2024-06-15T03:00:00Z')
      const endUTC = getQuietHoursEndUTC(date, config)

      expect(endUTC.getUTCHours()).toBe(12)
      expect(endUTC.getUTCMinutes()).toBe(0)
    })
  })

  describe('isValidTimezone', () => {
    it('returns true for valid IANA timezones', () => {
      expect(isValidTimezone('UTC')).toBe(true)
      expect(isValidTimezone('America/New_York')).toBe(true)
      expect(isValidTimezone('Europe/London')).toBe(true)
      expect(isValidTimezone('Asia/Tokyo')).toBe(true)
    })

    it('returns false for invalid timezones', () => {
      expect(isValidTimezone('Invalid/Timezone')).toBe(false)
      expect(isValidTimezone('Not_A_Zone')).toBe(false)
      expect(isValidTimezone('')).toBe(false)
    })
  })

  describe('isValidTimeFormat', () => {
    it('returns true for valid HH:MM formats', () => {
      expect(isValidTimeFormat('00:00')).toBe(true)
      expect(isValidTimeFormat('08:30')).toBe(true)
      expect(isValidTimeFormat('12:00')).toBe(true)
      expect(isValidTimeFormat('23:59')).toBe(true)
    })

    it('returns false for invalid formats', () => {
      expect(isValidTimeFormat('24:00')).toBe(false)
      expect(isValidTimeFormat('12:60')).toBe(false)
      expect(isValidTimeFormat('1:30')).toBe(true) // Single digit hour is valid
      expect(isValidTimeFormat('abc')).toBe(false)
      expect(isValidTimeFormat('12:00:00')).toBe(false) // Seconds not allowed
      expect(isValidTimeFormat('')).toBe(false)
    })
  })

  describe('DST boundary handling', () => {
    // Note: These tests verify basic DST behavior. Full DST edge case testing
    // would require mocking the system clock at specific DST transition times.

    it('handles US spring-forward correctly (March)', () => {
      // March 10, 2024 - US DST starts (2 AM -> 3 AM)
      const config: QuietHoursConfig = {
        timezone: 'America/New_York',
        startTime: '22:00',
        endTime: '08:00',
      }

      // At 08:00 UTC on March 10 = 04:00 EDT (after DST starts)
      // This is still in quiet hours (before 08:00 local)
      const date = new Date('2024-03-10T08:00:00Z')
      expect(isInQuietHours(date, config)).toBe(true)
    })

    it('handles timezones without DST (UTC)', () => {
      const config: QuietHoursConfig = {
        timezone: 'UTC',
        startTime: '22:00',
        endTime: '08:00',
      }

      // UTC doesn't have DST, so behavior should be consistent year-round
      const summer = new Date('2024-06-15T03:00:00Z')
      const winter = new Date('2024-12-15T03:00:00Z')

      expect(isInQuietHours(summer, config)).toBe(true)
      expect(isInQuietHours(winter, config)).toBe(true)
    })

    it('handles timezones without DST (Asia/Kolkata)', () => {
      const config: QuietHoursConfig = {
        timezone: 'Asia/Kolkata',
        startTime: '22:00',
        endTime: '08:00',
      }

      // Asia/Kolkata is UTC+5:30 year-round (no DST)
      // At 03:00 UTC = 08:30 IST - should be outside quiet hours
      const date = new Date('2024-06-15T03:00:00Z')
      expect(isInQuietHours(date, config)).toBe(false)
    })
  })
})
