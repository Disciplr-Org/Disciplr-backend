/**
 * Structured anomaly category taxonomy for abuse detection events.
 * Each variant carries the fields relevant to its detection logic.
 */

export type AbuseCategoryType =
  | 'brute-force'
  | 'enumeration'
  | 'payload-anomaly'
  | 'rate-limit-trip'

export type BruteForceCategory = {
  readonly type: 'brute-force'
  readonly failedLoginCount: number
  readonly windowMs: number
}

export type EnumerationCategory = {
  readonly type: 'enumeration'
  readonly notFoundCount: number
  readonly distinctPathCount: number
  readonly windowMs: number
}

export type PayloadAnomalyCategory = {
  readonly type: 'payload-anomaly'
  readonly badRequestCount: number
  readonly windowMs: number
}

export type RateLimitTripCategory = {
  readonly type: 'rate-limit-trip'
  readonly requestCount: number
  readonly windowMs: number
}

/** Discriminated union over all structured anomaly categories. */
export type AbuseCategory =
  | BruteForceCategory
  | EnumerationCategory
  | PayloadAnomalyCategory
  | RateLimitTripCategory

/** Structured abuse event emitted to the log and returned by the snapshot. */
export interface AbuseEvent {
  readonly event: 'security.abuse_detected'
  readonly actorHash: string
  readonly category: AbuseCategory
  readonly timestamp: string
}
