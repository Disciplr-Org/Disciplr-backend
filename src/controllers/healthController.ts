import type { Request, Response } from 'express'
import { buildHealthStatus } from '../services/healthService.js'
import { config } from '../config/index.js'

export const getHealth = (_req: Request, res: Response) => {
  res.json(buildHealthStatus(config.serviceName))
}
