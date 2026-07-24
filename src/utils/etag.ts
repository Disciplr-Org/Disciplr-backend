/**
 * ETag utilities for HTTP caching support
 *
 * Implements weak ETags (W/"...") for vault representations.
 * Weak ETags are suitable for semantically equivalent representations
 * and are appropriate for vault data that may be transformed during transmission.
 *
 * RFC 7232 Section 2.3: https://tools.ietf.org/html/rfc7232#section-2.3
 */

/**
 * Computes a weak ETag from a version string.
 * Weak ETags are prefixed with W/ to indicate they represent
 * semantically equivalent but not byte-for-byte identical content.
 *
 * @param version - The vault revision/version identifier
 * @returns Weak ETag string in format W/"-<version>"
 * @example
 *   computeWeakETag("123") // Returns: W/"-123"
 */
export function computeWeakETag(version: string | number): string {
  return `W/"-${version}"`
}

/**
 * Checks if an If-None-Match header matches the provided ETag.
 * Implements RFC 7232 Section 3.2 semantics for weak comparison.
 *
 * Rules:
 * 1. "*" matches any ETag (used for existence checks)
 * 2. Weak ETags are compared as-is (W/ prefix ignored in semantic comparison)
 * 3. Multiple ETags are comma-separated (return true if any match)
 * 4. Weak and strong ETags can be compared semantically (both treated as weak)
 *
 * @param ifNoneMatch - Value of If-None-Match header (e.g., 'W/"-123", W/"-456"' or '*')
 * @param etag - Current ETag of the resource
 * @returns true if If-None-Match matches (client should get 304), false otherwise
 * @example
 *   etagMatches('W/"-123"', 'W/"-123"') // true
 *   etagMatches('W/"-123", W/"-456"', 'W/"-123"') // true
 *   etagMatches('*', 'W/"-123"') // true
 *   etagMatches('W/"-456"', 'W/"-123"') // false
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false
  }

  // Normalize by trimming whitespace
  const normalized = ifNoneMatch.trim()

  // Wildcard matches any ETag
  if (normalized === '*') {
    return true
  }

  // Split on comma and compare each candidate
  const candidates = normalized.split(',').map((tag) => tag.trim())

  for (const candidate of candidates) {
    // Weak ETag comparison: strip W/ prefix if present and compare values
    const normalizeETag = (tag: string) => {
      return tag.startsWith('W/') ? tag.slice(2) : tag
    }

    if (normalizeETag(candidate) === normalizeETag(etag)) {
      return true
    }
  }

  return false
}

/**
 * Validates that an ETag is in a valid format
 * (strong: "..." or weak: W/"...")
 *
 * @param etag - ETag string to validate
 * @returns true if valid, false otherwise
 */
export function isValidETag(etag: string): boolean {
  // Weak ETag: W/"..."
  if (etag.startsWith('W/"') && etag.endsWith('"')) {
    return true
  }
  // Strong ETag: "..."
  if (etag.startsWith('"') && etag.endsWith('"')) {
    return true
  }
  return false
}

/**
 * Safely compares two ETags handling both strong and weak variants
 * This is useful for cache validation logic
 *
 * @param etag1 - First ETag
 * @param etag2 - Second ETag
 * @param weakComparison - If true, treat weak and strong as equivalent (default: true for HTTP caching)
 * @returns true if ETags are equivalent
 */
export function compareETags(
  etag1: string,
  etag2: string,
  weakComparison: boolean = true,
): boolean {
  if (!isValidETag(etag1) || !isValidETag(etag2)) {
    return false
  }

  if (weakComparison) {
    // Strip W/ prefix if present
    const normalize = (tag: string) => tag.startsWith('W/') ? tag.slice(2) : tag
    return normalize(etag1) === normalize(etag2)
  }

  // Strong comparison (exact match)
  return etag1 === etag2
}
