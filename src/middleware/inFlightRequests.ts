import type { RequestHandler } from 'express'

let inFlight = 0
let draining = false
let drainResolvers: (() => void)[] = []

export const getInFlightCount = (): number => inFlight
export const setDraining = (value: boolean): void => {
  draining = value
}

/**
 * Resets the in-flight request counter and clear all drain resolvers.
 * Used primarily for ensuring test isolation.
 */
export const resetInFlight = (): void => {
  inFlight = 0
  drainResolvers = []
}

/**
 * Returns a promise that remains pending while there are active requests,
 * and resolves once the active request count reaches zero.
 */
export const waitForZeroActiveRequests = (): Promise<void> => {
  if (inFlight === 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    drainResolvers.push(resolve)
  })
}

export const inFlightMiddleware: RequestHandler = (req, res, next) => {
  if (draining) {
    res.setHeader('Connection', 'close')
    res.setHeader('Retry-After', '0')
    res.status(503).json({ error: 'server is draining' })
    return
  }

  inFlight += 1
  let decremented = false

  const cleanup = () => {
    if (decremented) return
    decremented = true
    inFlight = Math.max(0, inFlight - 1)
    
    res.removeListener('finish', cleanup)
    res.removeListener('close', cleanup)
    res.removeListener('error', cleanup)

    if (inFlight === 0) {
      const resolvers = drainResolvers
      drainResolvers = []
      for (const resolve of resolvers) {
        resolve()
      }
    }
  }

  res.on('finish', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
  next()
}

export default inFlightMiddleware
