import type { RequestHandler } from 'express'

let inFlight = 0
let draining = false

export const getInFlightCount = (): number => inFlight
export const setDraining = (value: boolean): void => {
  draining = value
}

export const inFlightMiddleware: RequestHandler = (req, res, next) => {
  if (draining) {
    res.setHeader('Connection', 'close')
    res.setHeader('Retry-After', '0')
    res.status(503).json({ error: 'server is draining' })
    return
  }

  inFlight += 1
  // Ensure counter is decremented when the response finishes for any reason
  const cleanup = () => {
    inFlight = Math.max(0, inFlight - 1)
    res.removeListener('finish', cleanup)
    res.removeListener('close', cleanup)
  }

  res.on('finish', cleanup)
  res.on('close', cleanup)
  next()
}

export default inFlightMiddleware
