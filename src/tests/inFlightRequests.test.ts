import {
  inFlightMiddleware,
  getInFlightCount,
  setDraining,
  resetInFlight,
  waitForZeroActiveRequests,
} from '../middleware/inFlightRequests.js'
import { EventEmitter } from 'events'

class MockResponse extends EventEmitter {
  headers = new Map<string, string>()
  statusCode = 200
  body: any = null

  setHeader(name: string, value: string) {
    this.headers.set(name, value)
    return this
  }

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(data: any) {
    this.body = data
    return this
  }
}

describe('inFlightRequests middleware', () => {
  beforeEach(() => {
    resetInFlight()
    setDraining(false)
  })

  test('1. active request counter increments immediately when request enters middleware', () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    expect(getInFlightCount()).toBe(0)
    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('2. counter decrements after normal successful response (finish event)', () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)

    res.emit('finish')
    expect(getInFlightCount()).toBe(0)
  })

  test('3. counter decrements when request ends due to error', () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)

    res.emit('error', new Error('Test error'))
    expect(getInFlightCount()).toBe(0)
  })

  test('4. counter decrements when client aborts connection before completion (close event)', () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)

    res.emit('close')
    expect(getInFlightCount()).toBe(0)
  })

  test('5. multiple concurrent requests produce correct peak active count', () => {
    const next = jest.fn()
    const clients = Array.from({ length: 5 }, () => {
      return {
        req: {} as any,
        res: new MockResponse() as any,
      }
    })

    expect(getInFlightCount()).toBe(0)

    // Enter all 5 requests
    clients.forEach((c, idx) => {
      inFlightMiddleware(c.req, c.res, next)
      expect(getInFlightCount()).toBe(idx + 1)
    })

    expect(getInFlightCount()).toBe(5)

    // Finish them one by one
    clients.forEach((c, idx) => {
      c.res.emit('finish')
      expect(getInFlightCount()).toBe(5 - (idx + 1))
    })

    expect(getInFlightCount()).toBe(0)
  })

  test('6. middleware drain/wait mechanism remains pending while active requests exist', async () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)

    let resolved = false
    const drainPromise = waitForZeroActiveRequests().then(() => {
      resolved = true
    })

    // Wait a brief tick to verify promise remains pending
    await new Promise((resolve) => process.nextTick(resolve))
    expect(resolved).toBe(false)

    // Complete the request
    res.emit('finish')
    await drainPromise
    expect(resolved).toBe(true)
    expect(getInFlightCount()).toBe(0)
  })

  test('7. drain promise resolves only after active request count reaches zero', async () => {
    const req1 = {} as any
    const res1 = new MockResponse() as any
    const req2 = {} as any
    const res2 = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req1, res1, next)
    inFlightMiddleware(req2, res2, next)
    expect(getInFlightCount()).toBe(2)

    let resolved = false
    const drainPromise = waitForZeroActiveRequests().then(() => {
      resolved = true
    })

    // Finish first request, active count drops to 1 but not 0
    res1.emit('finish')
    expect(getInFlightCount()).toBe(1)

    await new Promise((resolve) => process.nextTick(resolve))
    expect(resolved).toBe(false)

    // Finish second request, count reaches zero
    res2.emit('close')
    expect(getInFlightCount()).toBe(0)

    await drainPromise
    expect(resolved).toBe(true)
  })

  test('8. active request counter never becomes negative and prevents duplicate completion events from double decrementing', () => {
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)
    expect(getInFlightCount()).toBe(1)

    // Emit multiple completion events for the same request
    res.emit('finish')
    expect(getInFlightCount()).toBe(0)

    res.emit('close')
    expect(getInFlightCount()).toBe(0)

    res.emit('error', new Error('Duplicate error'))
    expect(getInFlightCount()).toBe(0)
  })

  test('9. drain/wait resolves immediately when active request count is zero', async () => {
    expect(getInFlightCount()).toBe(0)
    
    let resolved = false
    await waitForZeroActiveRequests().then(() => {
      resolved = true
    })
    expect(resolved).toBe(true)
  })

  test('10. response is rejected with 503 when draining is active', () => {
    setDraining(true)
    const req = {} as any
    const res = new MockResponse() as any
    const next = jest.fn()

    inFlightMiddleware(req, res, next)

    expect(getInFlightCount()).toBe(0)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.headers.get('Connection')).toBe('close')
    expect(res.headers.get('Retry-After')).toBe('0')
    expect(res.body).toEqual({ error: 'server is draining' })
  })
})
