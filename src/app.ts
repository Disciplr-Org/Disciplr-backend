import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { config } from './config/index.js'
import { privacyLogger } from './middleware/privacy-logger.js'

export const app = express()

// ---------------------------------------------------------------------------
// Helmet — API-only hardened configuration
//
// Tradeoffs vs helmet() defaults:
//
// contentSecurityPolicy:
//   Default helmet CSP is browser-oriented (allows 'self' scripts/styles).
//   An API never serves HTML, so we set the most restrictive directives:
//   default-src 'none' blocks every fetch/script/style/frame.
//   frame-ancestors 'none' replaces X-Frame-Options (deprecated in favour of CSP).
//   This gives defence-in-depth if a misconfigured client ever renders a response.
//
// crossOriginEmbedderPolicy (COEP):
//   Default: enabled (require-corp). Fine for APIs; kept on.
//
// crossOriginOpenerPolicy (COOP):
//   Default: same-origin. Fine for APIs; kept on.
//
// crossOriginResourcePolicy (CORP):
//   Default: same-origin. Overridden to same-site so internal micro-services
//   on the same domain can fetch without CORS pre-flight overhead.
//   Change to 'cross-origin' only if public CDN access is needed.
//
// referrerPolicy:
//   Default: no-referrer. Kept — no referrer is correct for an API.
//
// strictTransportSecurity (HSTS):
//   Default: max-age=15552000 (180 days), no includeSubDomains.
//   Bumped to 1 year (HSTS preload minimum) and includeSubDomains added.
//   Do NOT set preload:true unless the domain is submitted to the HSTS preload list.
//
// xContentTypeOptions:
//   Default: nosniff. Kept — prevents MIME-sniffing attacks.
//
// xDnsPrefetchControl:
//   Default: off. Kept — suppresses speculative DNS lookups.
//
// xDownloadOptions:
//   Default: noopen. Kept — IE8 guard, harmless on modern stacks.
//
// xFrameOptions:
//   Disabled — superseded by CSP frame-ancestors above. Sending both is
//   redundant and can confuse some proxies.
//
// xPermittedCrossDomainPolicies:
//   Default: none. Kept — blocks Adobe Flash/PDF cross-domain reads.
//
// xPoweredBy:
//   helmet() removes X-Powered-By by default. Kept removed.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // Block every resource type — this server returns JSON, never HTML.
        defaultSrc: ["'none'"],
        // Disallow framing in any context.
        frameAncestors: ["'none'"],
        // Explicit no-op for completeness; implied by default-src 'none'.
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

    // COEP: require-corp — keep default.
    crossOriginEmbedderPolicy: true,

    // COOP: same-origin — keep default.
    crossOriginOpenerPolicy: { policy: 'same-origin' },

    // CORP: same-site allows same-domain micro-services without CORS preflight.
    crossOriginResourcePolicy: { policy: 'same-site' },

    // Referrer: no-referrer — keep default.
    referrerPolicy: { policy: 'no-referrer' },

    // HSTS: 1-year max-age + includeSubDomains (preload-ready but not submitted).
    strictTransportSecurity: {
      maxAge: 31_536_000, // 365 days in seconds
      includeSubDomains: true,
      // preload: true — omit until domain is registered in the HSTS preload list.
    },

    // nosniff — keep default.
    xContentTypeOptions: true,

    // DNS prefetch off — keep default.
    xDnsPrefetchControl: { allow: false },

    // IE8 download guard — keep default.
    xDownloadOptions: true,

    // Disable X-Frame-Options: CSP frame-ancestors supersedes it.
    xFrameOptions: false,

    // Flash/PDF cross-domain block — keep default.
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
  }),
)

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Non-browser / server-to-server requests carry no Origin header — pass through
    if (!origin) {
      callback(null, true)
      return
    }

    const allowed = config.corsOrigins
    if (allowed === '*' || (Array.isArray(allowed) && allowed.includes(origin))) {
      callback(null, true)
    } else {
      // Emit a structured log so rejected origins are observable in prod logs
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'security.cors_rejected',
          service: 'disciplr-backend',
          origin,
          timestamp: new Date().toISOString(),
        }),
      )
      callback(null, false)
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'idempotency-key'],
  credentials: true,
}

app.use(cors(corsOptions))
app.use(express.json())

app.use((_req, res, next) => {
  res.setHeader('X-Timezone', 'UTC')
  next()
})

app.use(privacyLogger)

// Routes are mounted in index.ts