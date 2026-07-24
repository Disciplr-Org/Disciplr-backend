import express, { type Request, type Response } from 'express'
import request from 'supertest'

import {
  addDeprecationHeaders,
  mountVersionedRoute,
} from '../middleware/versioning.js'

import {
  LEGACY_SUNSET_HTTP_DATE,
  VERSIONED_PREFIX,
} from '../config/versions.js'

describe('versioning middleware', () => {
  describe('addDeprecationHeaders', () => {
    it('adds RFC8594 deprecation headers', async () => {
      const app = express()

      app.get(
        '/api/demo',
        addDeprecationHeaders('/api/demo'),
        (_req: Request, res: Response) => {
          res.status(204).end()
        },
      )

      const res = await request(app).get('/api/demo')

      expect(res.status).toBe(204)
      expect(res.headers.deprecation).toBe('true')
      expect(res.headers.sunset).toBe(LEGACY_SUNSET_HTTP_DATE)
      expect(res.headers.link).toBe(
        '</api/v1/demo>; rel="successor-version"',
      )
    })
  })

  describe('mountVersionedRoute', () => {
    it('mounts both versioned and legacy endpoints', async () => {
      const app = express()

      mountVersionedRoute(
        app,
        '/api/ping',
        `${VERSIONED_PREFIX}/ping`,
        (_req: Request, res: Response) => {
          res.json({ ok: true })
        },
      )

      const legacy = await request(app).get('/api/ping')
      const versioned = await request(app).get('/api/v1/ping')

      expect(legacy.status).toBe(200)
      expect(versioned.status).toBe(200)

      expect(legacy.body).toEqual(versioned.body)

      expect(versioned.headers.deprecation).toBeUndefined()
      expect(legacy.headers.deprecation).toBe('true')
    })

    it('preserves identical responses across both routes', async () => {
      const app = express()

      mountVersionedRoute(
        app,
        '/api/example',
        `${VERSIONED_PREFIX}/example`,
        (_req: Request, res: Response) => {
          res.json({
            success: true,
            message: 'ok',
          })
        },
      )

      const legacy = await request(app).get('/api/example')
      const versioned = await request(app).get('/api/v1/example')

      expect(legacy.body).toStrictEqual(versioned.body)
    })
  })
})