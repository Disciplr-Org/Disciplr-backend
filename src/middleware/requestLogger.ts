import type { NextFunction, Request, Response } from 'express'

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()

  res.on('finish', () => {
    const durationMs = Date.now() - start
    const logLine = `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
    console.info(logLine)
  })

  next()
}
