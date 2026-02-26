/**
 * Central timestamp utilities for the Disciplr backend.
 * All timestamps are stored and transmitted in UTC (ISO 8601 with timezone).
 * No external dependencies — uses native Intl.DateTimeFormat for localization.
 */

const ISO8601_WITH_TZ =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Validates that a value is a well-formed ISO 8601 datetime string
 * with a mandatory timezone designator (Z or ±HH:MM).
 * Also rejects impossible calendar dates (month 13, Feb 30, etc.).
 */
export function isValidISO8601(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const match = ISO8601_WITH_TZ.exec(value)
  if (!match) return false

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const second = Number(secondStr)

  if (month < 1 || month > 12) return false
  if (hour > 23 || minute > 59 || second > 59) return false

  // Validate day range for the given month/year
  const maxDay = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDay) return false

  return true
}

/**
 * Parses an ISO 8601 string with any timezone offset and returns
 * the equivalent UTC string ending in Z.
 * Throws if the input is not a valid ISO 8601 string with timezone.
 */
export function parseAndNormalizeToUTC(value: string): string {
  if (!isValidISO8601(value)) {
    throw new Error(`Invalid ISO 8601 timestamp: ${value}`)
  }

  const date = new Date(value)
  if (isNaN(date.getTime())) {
    throw new Error(`Unparseable timestamp: ${value}`)
  }

  return date.toISOString()
}

/**
 * Returns the current time as an ISO 8601 UTC string (ending in Z).
 * Centralizes timestamp generation so every module uses a consistent source.
 */
export function utcNow(): string {
  return new Date().toISOString()
}

export interface FormatTimestampOptions {
  locale?: string
  timeZone?: string
  style?: 'short' | 'medium' | 'long'
}

const styleMap: Record<string, { dateStyle: Intl.DateTimeFormatOptions['dateStyle']; timeStyle: Intl.DateTimeFormatOptions['timeStyle'] }> = {
  short:  { dateStyle: 'short',  timeStyle: 'short' },
  medium: { dateStyle: 'medium', timeStyle: 'medium' },
  long:   { dateStyle: 'long',   timeStyle: 'long' },
}

/**
 * Formats an ISO 8601 timestamp for display using Intl.DateTimeFormat.
 * Useful for server-side rendering of emails, reports, etc.
 *
 * @param iso   - An ISO 8601 string (must include timezone)
 * @param options.locale   - BCP 47 locale tag (default: 'en-US')
 * @param options.timeZone - IANA timezone (default: 'UTC')
 * @param options.style    - 'short' | 'medium' | 'long' (default: 'medium')
 */
export function formatTimestamp(iso: string, options?: FormatTimestampOptions): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp for formatting: ${iso}`)
  }

  const locale = options?.locale ?? 'en-US'
  const timeZone = options?.timeZone ?? 'UTC'
  const { dateStyle, timeStyle } = styleMap[options?.style ?? 'medium']

  return new Intl.DateTimeFormat(locale, { dateStyle, timeStyle, timeZone }).format(date)
}
