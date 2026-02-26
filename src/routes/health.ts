import { Router } from 'express'

export const healthRouter = Router()

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the Disciplr backend service
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'disciplr-backend',
    timestamp: new Date().toISOString(),
  })
})
