import type { Application, Request, Response, NextFunction, RequestHandler } from 'express'
import { getDeprecationConfig } from '../config/versions.js'

/**
 * Express middleware that attaches RFC 8594 deprecation headers to the
 * response so legacy clients know they should migrate.
 *
 * Headers injected:
 *   Deprecation: true
 *   Sunset: <HTTP-date>
 *   Link: <successor-path>; rel="successor-version"
 */
export function addDeprecationHeaders(legacyPath: string) {
  const config = getDeprecationConfig(legacyPath)

  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Deprecation', config.deprecation)
    res.setHeader('Sunset', config.sunset)
    res.setHeader('Link', config.link)
    next()
  }
}

/**
 * Mount a route handler (or array of handlers) under both the canonical
 * versioned path and the legacy unversioned path.
 *
 * - `/api/v1/<resource>` — current version, **no** deprecation headers.
 * - `/api/<resource>`    — legacy alias, **with** deprecation headers.
 *
 * This guarantees zero-downtime migration for existing consumers while
 * steering them toward the versioned surface.
 *
 * Example:
 *   mountVersionedRoute(app, '/api/health', '/api/v1/health', handler)
 */
export function mountVersionedRoute(
  app: Application,
  legacyPath: string,
  versionedPath: string,
  ...handlers: RequestHandler[]
): void {
  // Canonical versioned route — clean, no deprecation noise.
  app.use(versionedPath, ...handlers)

  // Legacy route — identical behaviour plus deprecation headers.
  app.use(legacyPath, addDeprecationHeaders(legacyPath), ...handlers)
}

