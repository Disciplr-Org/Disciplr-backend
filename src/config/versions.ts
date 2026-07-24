/**
 * API Versioning Configuration
 *
 * Defines the current canonical API version, legacy prefix, and the deprecation
 * sunset timeline. All dates are UTC and follow RFC 8594 / RFC 8288 conventions.
 */

/** Canonical version segment used in URL paths, e.g. /api/v1/… */
export const CURRENT_API_VERSION = 'v1' as const

/** Legacy route prefix that existing clients already hit. */
export const LEGACY_PREFIX = '/api' as const

/** Versioned route prefix that becomes the canonical surface. */
export const VERSIONED_PREFIX = `/api/${CURRENT_API_VERSION}` as const

/**
 * ISO 8601 timestamp when legacy (unversioned) routes will cease to be
 * supported. Chosen as 6 months from initial introduction to give consumers
 * ample migration runway.
 */
export const LEGACY_SUNSET_ISO = '2026-09-01T00:00:00Z' as const

/** Pre-computed HTTP-date string (RFC 7231) for the Sunset header. */
export const LEGACY_SUNSET_HTTP_DATE = new Date(LEGACY_SUNSET_ISO).toUTCString()

/**
 * Given a legacy path such as `/api/health`, returns the canonical
 * successor path, e.g. `/api/v1/health`.
 */
export function toVersionedPath(legacyPath: string): string {
  if (!legacyPath.startsWith(LEGACY_PREFIX)) {
    throw new Error(
      `Invalid legacy path "${legacyPath}" — must start with "${LEGACY_PREFIX}"`,
    )
  }
  return legacyPath.replace(LEGACY_PREFIX, VERSIONED_PREFIX)
}

/**
 * Deprecation metadata returned by middleware and used in docs.
 */
export interface DeprecationConfig {
  /** RFC 8594 boolean flag or date */
  deprecation: 'true' | string
  /** RFC 8594 Sunset HTTP-date */
  sunset: string
  /** RFC 8288 Link header pointing to successor version */
  link: string
}

/**
 * Build a DeprecationConfig for a specific legacy path.
 */
export function getDeprecationConfig(legacyPath: string): DeprecationConfig {
  const successorPath = toVersionedPath(legacyPath)
  return {
    deprecation: 'true',
    sunset: LEGACY_SUNSET_HTTP_DATE,
    link: `<${successorPath}>; rel="successor-version"`,
  }
}

