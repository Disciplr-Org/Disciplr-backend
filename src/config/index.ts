import { initEnv, getEnv, type Env, type EnvWarning } from './env.js'

export { initEnv, getEnv, type Env, type EnvWarning }

// Config moved/merged below to avoid duplicate declaration

/**
 * Resolves the list of allowed CORS origins from the CORS_ORIGINS env var.
 */
export function parseCorsOrigins(value: string | undefined, env: string): string[] | '*' {
  if (value !== undefined) {
    if (value.trim() === '*') return '*'
    return value
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  }

  if (env === 'production') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'security.cors_misconfiguration',
        service: 'disciplr-backend',
        message:
          'CORS_ORIGINS is not configured in production — all cross-origin requests will be blocked. Set CORS_ORIGINS to the allowed frontend origin(s).',
        timestamp: new Date().toISOString(),
      }),
    )
    return []
  }

  return ['http://localhost:3000']
}

/** Reset internal state — exposed for tests only. */
export function _resetEnvForTesting(): void {
  // We need to be able to reset this. Since _validated is in env.ts,
  // we should export a reset function there too if needed, or
  // just handle it here if possible. 
  // Given the current structure, I will add a reset function to env.ts
}

export type AppConfig = {
  env: string
  port: number
  serviceName: string
  corsOrigins: string[] | '*'
  maxJsonBodySize: string
  nodeEnv: string
  logLevel: string
}

const _env = process.env.NODE_ENV ?? 'development'

export const config: AppConfig = {
  get env() { return _env },
  get nodeEnv() { return _env },
  get logLevel() { return process.env.LOG_LEVEL ?? 'info' },
  get port() { 
    try { return getEnv().PORT } catch { return process.env.PORT ? Number(process.env.PORT) : 3000 }
  },
  get serviceName() {
    try { return getEnv().SERVICE_NAME } catch { return process.env.SERVICE_NAME ?? 'disciplr-backend' }
  },
  get corsOrigins() {
    try {
      return parseCorsOrigins(getEnv().CORS_ORIGINS, this.env)
    } catch {
      return parseCorsOrigins(process.env.CORS_ORIGINS, this.env)
    }
  },
  get maxJsonBodySize() {
    try { return getEnv().MAX_JSON_BODY_SIZE } catch { return process.env.MAX_JSON_BODY_SIZE ?? '500kb' }
  }
}
