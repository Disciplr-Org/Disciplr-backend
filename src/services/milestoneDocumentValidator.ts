/**
 * Validation service for milestone document references.
 *
 * Security strategy:
 * - URLs must be well-formed (parseable by the URL constructor)
 * - Only https:// is allowed (no http, ftp, data URIs, etc.)
 * - Domain allowlisting is enforced when ALLOWED_DOC_DOMAINS is set
 * - Content hash must be a valid hex string of the correct length
 * - Hash algorithm must be one of the supported values
 * - No open redirect risk: URLs are never followed server-side;
 *   they are stored as references only
 */

export interface DocumentValidationResult {
  valid: boolean
  errors: string[]
}

// Supported hash algorithms and their expected hex digest lengths
const HASH_LENGTHS: Record<string, number> = {
  sha256: 64,
  sha512: 128,
}

/**
 * Allowed domains for document URLs.
 * Set the ALLOWED_DOC_DOMAINS environment variable as a comma-separated
 * list of hostnames to enable allowlisting.
 * Example: ALLOWED_DOC_DOMAINS=docs.example.com,files.example.org
 * If not set, any https domain is accepted.
 */
function getAllowedDomains(): string[] | null {
  const raw = process.env.ALLOWED_DOC_DOMAINS
  if (!raw || raw.trim() === '') return null
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
}

/**
 * Validate a document URL.
 * - Must be parseable
 * - Must use https protocol
 * - Must be on the allowlist if configured
 */
export function validateDocumentUrl(url: string): string[] {
  const errors: string[] = []

  if (!url || typeof url !== 'string' || url.trim() === '') {
    errors.push('url is required')
    return errors
  }

  if (url.length > 2048) {
    errors.push('url must not exceed 2048 characters')
    return errors
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    errors.push('url is not a valid URL')
    return errors
  }

  if (parsed.protocol !== 'https:') {
    errors.push('url must use the https protocol')
  }

  const allowedDomains = getAllowedDomains()
  if (allowedDomains) {
    const hostname = parsed.hostname.toLowerCase()
    const allowed = allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
    if (!allowed) {
      errors.push(`url domain '${hostname}' is not in the allowed domains list`)
    }
  }

  return errors
}

/**
 * Validate a content hash.
 * - Must be a non-empty hex string
 * - Length must match the expected digest length for the algorithm
 */
export function validateContentHash(
  hash: string | undefined,
  algorithm: string | undefined
): string[] {
  const errors: string[] = []

  // Both must be provided together or not at all
  if (hash && !algorithm) {
    errors.push('hashAlgorithm is required when contentHash is provided')
    return errors
  }
  if (!hash && algorithm) {
    errors.push('contentHash is required when hashAlgorithm is provided')
    return errors
  }
  if (!hash && !algorithm) return errors

  const alg = algorithm!.toLowerCase()
  if (!HASH_LENGTHS[alg]) {
    errors.push(`hashAlgorithm '${alg}' is not supported. Supported: ${Object.keys(HASH_LENGTHS).join(', ')}`)
  }

  if (!/^[0-9a-f]+$/i.test(hash!)) {
    errors.push('contentHash must be a hexadecimal string')
  } else if (HASH_LENGTHS[alg] && hash!.length !== HASH_LENGTHS[alg]) {
    errors.push(
      `contentHash length ${hash!.length} does not match expected length ${HASH_LENGTHS[alg]} for ${alg}`
    )
  }

  return errors
}

/**
 * Validate a full document reference input.
 */
export function validateMilestoneDocument(input: {
  vaultId?: string
  label?: string
  url?: string
  contentHash?: string
  hashAlgorithm?: string
}): DocumentValidationResult {
  const errors: string[] = []

  if (!input.vaultId || typeof input.vaultId !== 'string' || input.vaultId.trim() === '') {
    errors.push('vaultId is required')
  }

  if (!input.label || typeof input.label !== 'string' || input.label.trim() === '') {
    errors.push('label is required')
  } else if (input.label.length > 255) {
    errors.push('label must not exceed 255 characters')
  }

  errors.push(...validateDocumentUrl(input.url ?? ''))
  errors.push(...validateContentHash(input.contentHash, input.hashAlgorithm))

  return { valid: errors.length === 0, errors }
}