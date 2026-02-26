import client from 'prom-client'
import type { Request, Response, NextFunction } from 'express'

// Enable default metrics collection
client.collectDefaultMetrics({
  prefix: 'disciplr_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
})

// Custom metrics
export const httpRequestDuration = new client.Histogram({
  name: 'disciplr_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
})

export const httpRequestTotal = new client.Counter({
  name: 'disciplr_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
})

export const httpRequestErrors = new client.Counter({
  name: 'disciplr_http_errors_total',
  help: 'Total number of HTTP error responses (4xx, 5xx)',
  labelNames: ['method', 'route', 'status_code'],
})

export const activeVaults = new client.Gauge({
  name: 'disciplr_active_vaults_total',
  help: 'Number of currently active vaults',
})

export const vaultOperations = new client.Counter({
  name: 'disciplr_vault_operations_total',
  help: 'Total number of vault operations',
  labelNames: ['operation', 'status'],
})

export const rateLimitBreaches = new client.Counter({
  name: 'disciplr_rate_limit_breaches_total',
  help: 'Total number of rate limit breaches',
  labelNames: ['route', 'client_type'],
})

export const databaseConnections = new client.Gauge({
  name: 'disciplr_database_connections_active',
  help: 'Number of active database connections',
})

export const deadlineProcessingBacklog = new client.Gauge({
  name: 'disciplr_deadline_processing_backlog',
  help: 'Number of vaults pending deadline processing',
})

// Middleware for tracking HTTP requests
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  
  // Record total requests
  httpRequestTotal.inc({ method: req.method, route: req.route?.path || req.path })
  
  // Track response
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    const route = req.route?.path || req.path
    const statusCode = res.statusCode.toString()
    
    // Record duration
    httpRequestDuration.observe({ method: req.method, route, status_code: statusCode }, duration)
    
    // Record errors
    if (res.statusCode >= 400) {
      httpRequestErrors.inc({ method: req.method, route, status_code: statusCode })
    }
  })
  
  next()
}

// Function to update vault metrics
export const updateVaultMetrics = (vaults: any[]) => {
  const activeCount = vaults.filter(v => v.status === 'active').length
  activeVaults.set(activeCount)
}

// Function to record vault operations
export const recordVaultOperation = (operation: string, status: string) => {
  vaultOperations.inc({ operation, status })
}

// Function to record rate limit breaches
export const recordRateLimitBreach = (route: string, clientType: string) => {
  rateLimitBreaches.inc({ route, client_type: clientType })
}

// Function to update database connection metrics
export const updateDatabaseConnections = (count: number) => {
  databaseConnections.set(count)
}

// Function to update deadline processing backlog
export const updateDeadlineBacklog = (count: number) => {
  deadlineProcessingBacklog.set(count)
}

// Get metrics for Prometheus
export const getMetrics = async () => {
  return await client.register.metrics()
}

// Reset all metrics (useful for testing)
export const resetMetrics = () => {
  client.register.clear()
  client.collectDefaultMetrics({ prefix: 'disciplr_' })
}

export { client as promClient }
