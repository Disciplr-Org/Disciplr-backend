import type { Request, Response } from 'express'
import { AppError } from './errorHandler.js'

export const notFound = (req: Request, res: Response): void => {
  const err = AppError.notFound(`Route not found: ${req.method} ${req.path}`)
  res.status(err.status).json({
    error: {
      code: err.code,
      message: err.message,
    },
  })
}
