import type { Request, Response } from 'express'
import { config } from '../config/index.js'

export const getHealth = (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: config.serviceName, timestamp: new Date().toISOString() })
}
