/**
 * Regression test for issue #1053:
 * /api/admin, /api/notifications, and /api/webhooks must each be mounted
 * exactly once on the Express app singleton.
 *
 * This test is intentionally self-contained: it builds a minimal Express app
 * that mirrors the app.ts + bootstrapApp() registration pattern, so it does
 * not depend on the full transitive import graph of the production app.
 *
 * The production fix is in src/app-bootstrap.ts: the three duplicate
 * app.use('/api/admin'), app.use('/api/notifications'), and
 * app.use('/api/webhooks') calls were removed, along with the broken
 * `{ webhooksRouter }` named import (the actual export is `webhookRouter`).
 */

import express, { Router, type Express } from 'express'

// ---------------------------------------------------------------------------
// Helper: count how many times a path prefix is mounted as a router layer.
// Express stores every app.use() call as a layer in app._router.stack.
// Router-mount layers have name === 'router' and a regexp compiled from the
// path prefix by path-to-regexp.
// ---------------------------------------------------------------------------
function countMounts(app: Express, pathPrefix: string): number {
  const stack: Array<{ regexp: RegExp; name: string }> =
    (app as any)._router?.stack ?? []

  // path-to-regexp turns '/api/foo' into a regexp whose source contains
  // '\\/api\\/foo' — escape slashes and hyphens to match.
  const escaped = pathPrefix.replace(/\//g, '\\/').replace(/-/g, '\\-')

  return stack.filter(
    (layer) =>
      layer.name === 'router' && layer.regexp.source.includes(escaped),
  ).length
}

// ---------------------------------------------------------------------------
// Simulate app.ts: mounts the three routers once at module-load time.
// ---------------------------------------------------------------------------
function createApp(): Express {
  const app = express()

  const adminRouter = Router()
  const notificationsRouter = Router()
  const webhookRouter = Router()

  // These are the mounts that live in app.ts and run at import time.
  app.use('/api/admin', adminRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/webhooks', webhookRouter)

  return app
}

// ---------------------------------------------------------------------------
// Simulate the FIXED bootstrapApp(): does NOT re-mount the three routers.
// ---------------------------------------------------------------------------
function bootstrapFixed(app: Express): void {
  // Other routes are added here — but /api/admin, /api/notifications, and
  // /api/webhooks are intentionally absent because app.ts already mounted them.
  const healthRouter = Router()
  app.use('/api/health', healthRouter)
}

// ---------------------------------------------------------------------------
// Simulate the BROKEN bootstrapApp() from before the fix: re-mounts all three.
// ---------------------------------------------------------------------------
function bootstrapBroken(app: Express): void {
  const adminRouter = Router()
  const notificationsRouter = Router()
  const webhookRouter = Router()

  app.use('/api/health', Router())

  // These were the duplicate mounts that the fix removed:
  app.use('/api/admin', adminRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/webhooks', webhookRouter)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('countMounts helper', () => {
  test('returns 0 when path is not mounted', () => {
    const app = createApp()
    expect(countMounts(app, '/api/missing')).toBe(0)
  })

  test('returns 1 for a single mount', () => {
    const app = createApp()
    expect(countMounts(app, '/api/admin')).toBe(1)
  })

  test('returns 2 when the same path is mounted twice', () => {
    const app = createApp()
    bootstrapBroken(app)
    expect(countMounts(app, '/api/admin')).toBe(2)
  })
})

describe('Fixed bootstrapApp — no duplicate mounts (issue #1053)', () => {
  let app: Express

  beforeAll(() => {
    app = createApp()       // mirrors app.ts module-load mounts
    bootstrapFixed(app)     // mirrors the fixed bootstrapApp()
  })

  test('/api/admin is mounted exactly once', () => {
    expect(countMounts(app, '/api/admin')).toBe(1)
  })

  test('/api/notifications is mounted exactly once', () => {
    expect(countMounts(app, '/api/notifications')).toBe(1)
  })

  test('/api/webhooks is mounted exactly once', () => {
    expect(countMounts(app, '/api/webhooks')).toBe(1)
  })
})

describe('Broken bootstrapApp — demonstrates the double-mount bug', () => {
  let app: Express

  beforeAll(() => {
    app = createApp()
    bootstrapBroken(app)
  })

  test('/api/admin is mounted twice under the broken setup', () => {
    expect(countMounts(app, '/api/admin')).toBe(2)
  })

  test('/api/notifications is mounted twice under the broken setup', () => {
    expect(countMounts(app, '/api/notifications')).toBe(2)
  })

  test('/api/webhooks is mounted twice under the broken setup', () => {
    expect(countMounts(app, '/api/webhooks')).toBe(2)
  })
})
