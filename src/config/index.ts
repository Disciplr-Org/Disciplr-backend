type AppConfig = {
  env: string
  port: number
  serviceName: string
  corsOrigins: string[] | '*'
}

const parsePort = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

const parseCorsOrigins = (value: string | undefined): string[] | '*' => {
  if (!value) return '*'
  if (value.trim() === '*') return '*'
  return value.split(',').map((origin) => origin.trim()).filter(Boolean)
}

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parsePort(process.env.PORT, 3000),
  serviceName: process.env.SERVICE_NAME ?? 'disciplr-backend',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
}
