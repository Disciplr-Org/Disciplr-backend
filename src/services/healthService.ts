export type HealthStatus = {
  status: 'ok'
  service: string
  timestamp: string
}

export const buildHealthStatus = (service: string): HealthStatus => ({
  status: 'ok',
  service,
  timestamp: new Date().toISOString(),
})
