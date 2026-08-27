import client from 'prom-client'

/** Shared registry exposed by /api/metrics and used by service instrumentation. */
export const register = new client.Registry()
client.collectDefaultMetrics({ register })
