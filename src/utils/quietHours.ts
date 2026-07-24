/**
 * Quiet-hours utilities for timezone-aware notification deferral.
 * Uses native Intl.DateTimeFormat for DST-safe timezone conversions.
 */

export interface QuietHoursConfig {
  timezone: string
  startTime: string  // HH:MM format (local time)
  endTime: string    // HH:MM format (local time)
}

/**
 * Parses HH:MM time string to minutes since midnight.
 */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * Gets the current local time as minutes since midnight for a given timezone.
 */
export function getLocalMinutes(utcNow: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const parts = formatter.formatToParts(utcNow)
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)

  return hour * 60 + minute
}

/**
 * Determines if the given UTC timestamp falls within quiet hours
 * for the specified timezone configuration.
 *
 * Handles both same-day windows (e.g., 09:00-17:00) and
 * overnight windows (e.g., 22:00-08:00).
 */
export function isInQuietHours(utcNow: Date, config: QuietHoursConfig): boolean {
  const localMinutes = getLocalMinutes(utcNow, config.timezone)
  const startMinutes = parseTimeToMinutes(config.startTime)
  const endMinutes = parseTimeToMinutes(config.endTime)

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g., 09:00 to 17:00)
    return localMinutes >= startMinutes && localMinutes < endMinutes
  } else {
    // Overnight window (e.g., 22:00 to 08:00)
    return localMinutes >= startMinutes || localMinutes < endMinutes
  }
}

/**
 * Gets the local date components for a given UTC timestamp in a specific timezone.
 */
function getLocalDateComponents(utcNow: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const parts = formatter.formatToParts(utcNow)
  const year = parseInt(parts.find(p => p.type === 'year')?.value ?? '1970', 10)
  const month = parseInt(parts.find(p => p.type === 'month')?.value ?? '1', 10)
  const day = parseInt(parts.find(p => p.type === 'day')?.value ?? '1', 10)

  return { year, month, day }
}

/**
 * Converts a local date and time in a specific timezone to a UTC Date object.
 * Uses Intl.DateTimeFormat to correctly handle DST transitions.
 */
function localToUTC(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timezone: string
): Date {
  // Create a date string in ISO format and use the timezone offset
  // to determine the correct UTC time
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`

  // Create a formatter that will give us the offset for this datetime in this timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  })

  // Parse as if it's in the target timezone by finding the offset
  // We need to iterate to find the correct UTC time that corresponds to this local time
  const targetLocalTime = new Date(dateStr + 'Z')

  // Binary search for the correct UTC time
  // Start with a rough estimate (assuming UTC)
  let utcGuess = new Date(dateStr + 'Z')

  for (let i = 0; i < 3; i++) {
    // Format the guess in the target timezone
    const parts = formatter.formatToParts(utcGuess)
    const guessHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
    const guessMinute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
    const guessDay = parseInt(parts.find(p => p.type === 'day')?.value ?? '1', 10)

    // Calculate the difference
    const targetMinutes = hours * 60 + minutes + (day - guessDay) * 24 * 60
    const guessMinutes = guessHour * 60 + guessMinute
    const diffMinutes = targetMinutes - guessMinutes

    if (diffMinutes === 0) break

    // Adjust the guess
    utcGuess = new Date(utcGuess.getTime() + diffMinutes * 60 * 1000)
  }

  return utcGuess
}

/**
 * Calculates the next UTC timestamp when quiet hours end
 * for the given timezone configuration.
 *
 * Handles DST transitions correctly by using Intl.DateTimeFormat.
 */
export function getQuietHoursEndUTC(utcNow: Date, config: QuietHoursConfig): Date {
  const { year, month, day } = getLocalDateComponents(utcNow, config.timezone)
  const [endHours, endMinutes] = config.endTime.split(':').map(Number)

  // Calculate today's quiet-hours end in the user's timezone
  let endUTC = localToUTC(year, month, day, endHours, endMinutes, config.timezone)

  // If the end time has already passed today, use tomorrow's end time
  if (endUTC.getTime() <= utcNow.getTime()) {
    // Add one day
    const tomorrow = new Date(utcNow.getTime() + 24 * 60 * 60 * 1000)
    const tomorrowComponents = getLocalDateComponents(tomorrow, config.timezone)
    endUTC = localToUTC(
      tomorrowComponents.year,
      tomorrowComponents.month,
      tomorrowComponents.day,
      endHours,
      endMinutes,
      config.timezone
    )
  }

  return endUTC
}

/**
 * Validates that a timezone string is a valid IANA timezone identifier.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Validates that a time string is in HH:MM format.
 */
export function isValidTimeFormat(time: string): boolean {
  const match = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(time)
  return match !== null
}
