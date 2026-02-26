import type { NextFunction, Request, Response } from 'express'

type ApiError = {
  status?: number
  message?: string
}

export const errorHandler = (
  err: ApiError,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  void next
  const status = err.status ?? 500
  const message = err.message ?? 'Internal server error'
  res.status(status).json({ error: message })
}
