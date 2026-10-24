// CORS and security header configuration for the serverless API.

export const DEFAULT_FRONTEND_ORIGIN = 'https://disciplr-frontend.vercel.app'

export const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS']

export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'idempotency-key',
  'x-test-now',
  'x-wallet-address',
  'x-network-id',
]

export const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      connectSrc: ["'none'"],
      fontSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: {
    maxAge: 31_536_000, // 1 year
    includeSubDomains: true,
  },
  xContentTypeOptions: true,
  xDnsPrefetchControl: { allow: false },
  xDownloadOptions: true,
  xFrameOptions: false,
  xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
}

/**
 * Normalises an origin string by trimming whitespace and trailing slashes.
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return ''
  return origin.trim().replace(/\/+$/, '')
}

/**
 * Resolves the list of allowed CORS origins from the CORS_ORIGINS env variable.
 * Whitespace and trailing slashes are stripped.
 * - When unset in production: returns [] (fail closed, no cross-origin writes allowed).
 * - When unset in non-production: defaults to the production frontend origin.
 * - Wildcard '*' is not permitted for write endpoints and is stripped from the list.
 */
export function parseAllowedOrigins(env = process.env) {
  const raw = env?.CORS_ORIGINS

  if (raw !== undefined) {
    return raw
      .split(',')
      .map((o) => normalizeOrigin(o))
      .filter((o) => o.length > 0 && o !== '*')
  }

  if (env?.NODE_ENV === 'production') {
    return []
  }

  return [DEFAULT_FRONTEND_ORIGIN]
}

/**
 * Checks whether an origin is allowed by comparing exact origins.
 * No substring or regex matching.
 * Missing origin is considered allowed (server-to-server / curl).
 * 'null' origin is untrusted and rejected.
 */
export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) return true
  if (origin === 'null') return false
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false
  const normalized = normalizeOrigin(origin)
  return allowedOrigins.includes(normalized)
}

/**
 * Builds cors middleware options for write and preflight handling.
 *
 * @param {object} [env=process.env]
 * @returns {object} Options for the `cors` package
 */
export function buildCorsOptions(env = process.env) {
  const allowedOrigins = parseAllowedOrigins(env)

  return {
    origin: (origin, callback) => {
      // Allow requests without Origin header (server-to-server, curl)
      if (!origin) {
        callback(null, true)
        return
      }

      if (isOriginAllowed(origin, allowedOrigins)) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    },
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    maxAge: 600,
    credentials: false,
  }
}
