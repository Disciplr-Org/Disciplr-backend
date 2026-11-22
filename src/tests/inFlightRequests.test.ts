import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'
import inFlightMiddleware, {
  getInFlightCount,
  inFlightMiddleware as namedMiddleware,
  resetInFlight,
  setDraining,
  waitForZeroActiveRequests,
} from '../middleware/inFlightRequests.js'

// Tests for the in-flight request counter and graceful-drain middleware.
// Jest (ESM) suite, mirroring the neighbouring suites in this directory.
// Hermetic: no network, no database, no Redis. Timing is controlled with
// deferred promises and EventEmitter events instead of real sleeps.

// ── Helpers ─────────────────────────────────────────────────────────────────

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Minimal fake Express response backed by a real EventEmitter. */
class FakeResponse extends EventEmitter {
  headers: Record<string, string> = {}
  statusCode = 200
  body: unknown

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  status(code: number): this {
    this.statusCode = code
    return this
  }

  json(body: unknown): this {
    this.body = body
    return this
  }
}

function runMiddleware(res: FakeResponse) {
  const next = jest.fn()
  inFlightMiddleware({} as Request, res as unknown as Response, next as unknown as NextFunction)
  return next
}

function createApp(
  handler: (req: Request, res: Response) => void | Promise<void>,
): express.Application {
  const app = express()
  app.get('/test', inFlightMiddleware, handler)
  return app
}

/** App with a handler that blocks until `gate` resolves; `arrived` fires
 *  once the handler starts running (so the count is already 1). */
function createGatedApp(): {
  app: express.Application
  gate: { promise: Promise<void>; resolve: () => void }
  arrived: { promise: Promise<void>; resolve: () => void }
} {
  const gate = createDeferred()
  const arrived = createDeferred()
  const app = express()
  app.get(
    '/test',
    inFlightMiddleware,
    async (_req, res) => {
      arrived.resolve()
      await gate.promise
      res.status(200).json({ ok: true })
    },
  )
  return { app, gate, arrived }
}

beforeEach(() => {
  // resetInFlight clears the counter and the drain waiters but leaves the
  // draining flag alone, so both need resetting between tests.
  resetInFlight()
  setDraining(false)
})

// ── getInFlightCount ────────────────────────────────────────────────────────

describe('getInFlightCount', () => {
  it('starts at 0', () => {
    expect(getInFlightCount()).toBe(0)
  })

  it('reflects requests currently in flight', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    expect(getInFlightCount()).toBe(1)
  })

  it('returns to 0 after the response finishes', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('finish')
    expect(getInFlightCount()).toBe(0)
  })

  it('never goes below 0 when cleanup runs more than once', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('finish')
    res.emit('close')
    expect(getInFlightCount()).toBe(0)
  })

  it('does not count requests rejected while draining', () => {
    setDraining(true)
    const res = new FakeResponse()
    runMiddleware(res)
    expect(getInFlightCount()).toBe(0)
  })
})

// ── setDraining ─────────────────────────────────────────────────────────────

describe('setDraining', () => {
  it('rejects new requests with 503 while draining', async () => {
    setDraining(true)
    const app = createApp((_req, res) => {
      res.status(200).json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'server is draining' })
  })

  it('sets Connection: close and Retry-After: 0 on the 503 response', async () => {
    setDraining(true)
    const app = createApp((_req, res) => {
      res.status(200).json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.headers.connection).toBe('close')
    expect(res.headers['retry-after']).toBe('0')
  })

  it('does not call next() while draining', () => {
    setDraining(true)
    const res = new FakeResponse()
    const next = runMiddleware(res)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'server is draining' })
  })

  it('lets requests through again once draining is cleared', async () => {
    setDraining(true)
    setDraining(false)
    const app = createApp((_req, res) => {
      res.status(200).json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(200)
  })

  it('does not disturb requests already in flight', async () => {
    const { app, gate, arrived } = createGatedApp()
    const pending = request(app).get('/test').then((res) => res)
    await arrived.promise
    expect(getInFlightCount()).toBe(1)
    setDraining(true)
    gate.resolve()
    const res = await pending
    expect(res.status).toBe(200)
    expect(getInFlightCount()).toBe(0)
  })
})

// ── resetInFlight ───────────────────────────────────────────────────────────

describe('resetInFlight', () => {
  it('resets the counter to 0', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    expect(getInFlightCount()).toBe(1)
    resetInFlight()
    expect(getInFlightCount()).toBe(0)
  })

  it('clamps the counter at 0 when a reset happens mid-flight', async () => {
    const { app, gate, arrived } = createGatedApp()
    const pending = request(app).get('/test').then((res) => res)
    await arrived.promise
    resetInFlight()
    expect(getInFlightCount()).toBe(0)
    gate.resolve()
    const res = await pending
    expect(res.status).toBe(200)
    expect(getInFlightCount()).toBe(0)
  })

  it('leaves the draining flag untouched', async () => {
    setDraining(true)
    resetInFlight()
    const app = createApp((_req, res) => {
      res.status(200).json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(503)
  })

  it('drops drain waiters registered before the reset', async () => {
    const res = new FakeResponse()
    runMiddleware(res)
    let resolved = false
    const waiter = waitForZeroActiveRequests()
    void waiter.then(() => {
      resolved = true
    })
    resetInFlight()
    // Give the promise machinery a chance to run: nothing may resolve it.
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)
    // Even the late finish of the abandoned request cannot resolve it.
    res.emit('finish')
    await Promise.resolve()
    expect(resolved).toBe(false)
  })
})

// ── inFlightMiddleware ──────────────────────────────────────────────────────

describe('inFlightMiddleware', () => {
  it('calls next() and counts the request while it is in flight', () => {
    const res = new FakeResponse()
    const next = runMiddleware(res)
    expect(next).toHaveBeenCalledTimes(1)
    expect(getInFlightCount()).toBe(1)
  })

  it('decrements the count when the response finishes', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('finish')
    expect(getInFlightCount()).toBe(0)
  })

  it('decrements the count when the connection closes', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('close')
    expect(getInFlightCount()).toBe(0)
  })

  it('decrements the count when the response errors', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('error')
    expect(getInFlightCount()).toBe(0)
  })

  it('decrements only once when several terminal events fire', () => {
    const res = new FakeResponse()
    runMiddleware(res)
    res.emit('finish')
    res.emit('close')
    expect(getInFlightCount()).toBe(0)
  })

  it('tracks concurrent requests independently', () => {
    const first = new FakeResponse()
    const second = new FakeResponse()
    runMiddleware(first)
    runMiddleware(second)
    expect(getInFlightCount()).toBe(2)
    first.emit('finish')
    expect(getInFlightCount()).toBe(1)
    second.emit('close')
    expect(getInFlightCount()).toBe(0)
  })

  it('is the same function as the default export', () => {
    expect(inFlightMiddleware).toBe(namedMiddleware)
  })

  it('serves a full request end to end and returns the count to 0', async () => {
    const app = createApp((_req, res) => {
      expect(getInFlightCount()).toBe(1)
      res.status(200).json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(getInFlightCount()).toBe(0)
  })
})

// ── waitForZeroActiveRequests ───────────────────────────────────────────────

describe('waitForZeroActiveRequests', () => {
  it('resolves immediately when no requests are in flight', async () => {
    await expect(waitForZeroActiveRequests()).resolves.toBeUndefined()
  })

  it('waits while a request is in flight and resolves when it finishes', async () => {
    const { app, gate, arrived } = createGatedApp()
    const pending = request(app).get('/test').then((res) => res)
    await arrived.promise
    let resolved = false
    const waiter = waitForZeroActiveRequests()
    void waiter.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    gate.resolve()
    await pending
    await waiter
    expect(resolved).toBe(true)
  })

  it('resolves every waiter once the count reaches zero', async () => {
    const { app, gate, arrived } = createGatedApp()
    const pending = request(app).get('/test').then((res) => res)
    await arrived.promise
    let firstResolved = false
    let secondResolved = false
    const first = waitForZeroActiveRequests()
    const second = waitForZeroActiveRequests()
    void first.then(() => {
      firstResolved = true
    })
    void second.then(() => {
      secondResolved = true
    })
    gate.resolve()
    await pending
    await first
    await second
    expect(firstResolved).toBe(true)
    expect(secondResolved).toBe(true)
  })

  it('stays pending until the last in-flight request finishes', async () => {
    const firstGate = createDeferred()
    const firstArrived = createDeferred()
    const secondGate = createDeferred()
    const secondArrived = createDeferred()
    const app = express()
    app.get('/one', inFlightMiddleware, async (_req, res) => {
      firstArrived.resolve()
      await firstGate.promise
      res.status(200).json({ ok: true })
    })
    app.get('/two', inFlightMiddleware, async (_req, res) => {
      secondArrived.resolve()
      await secondGate.promise
      res.status(200).json({ ok: true })
    })
    const firstPending = request(app).get('/one').then((res) => res)
    const secondPending = request(app).get('/two').then((res) => res)
    await firstArrived.promise
    await secondArrived.promise
    expect(getInFlightCount()).toBe(2)
    let resolved = false
    const waiter = waitForZeroActiveRequests()
    void waiter.then(() => {
      resolved = true
    })
    firstGate.resolve()
    await firstPending
    expect(getInFlightCount()).toBe(1)
    expect(resolved).toBe(false)
    secondGate.resolve()
    await secondPending
    await waiter
    expect(resolved).toBe(true)
  })
})
