import { validateEnv, type Env, type EnvWarning } from './env.js'

type AppConfig = {
  env: string
  port: number
  serviceName: string
  corsOrigins: string[] | '*'
}

/**
 * Resolves the list of allowed CORS origins from the CORS_ORIGINS env var.
 *
 * Production behaviour: if CORS_ORIGINS is not explicitly configured the
 * function returns an empty array (block all cross-origin requests) and emits a
 * structured warning so the misconfiguration is immediately visible in logs
 * rather than silently shipping an open API.
 *
 * Development / test behaviour: falls back to http://localhost:3000 so local
 * development works without requiring extra env setup.
 *
 * @param value  Raw CORS_ORIGINS env value (may be undefined).
 * @param env    Current NODE_ENV value.
 */
export function parseCorsOrigins(value: string | undefined, env: string): string[] | '*' {
  if (value !== undefined) {
    if (value.trim() === '*') return '*'
    return value
      .split(',')
      .map((origin) => origin.trim())
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
      }),
    )
    return []
  }

  // Outside production a sensible local-dev default avoids friction without
  // compromising prod security.
  return ['http://localhost:3000']
}

/** Validated environment – populated by `initEnv()`. */
let _validated: Env | undefined

/** Warnings produced during the last `initEnv()` call. */
let _envWarnings: EnvWarning[] = []

/**
 * Run Zod-based environment validation.  Must be called once at startup
 * before any module reads `config`.  Calling it more than once is safe
 * (subsequent calls are no-ops).
 */
export function initEnv(
  raw?: Record<string, string | undefined>,
): { env: Env; warnings: EnvWarning[] } {
  if (_validated) return { env: _validated, warnings: _envWarnings }
  const result = validateEnv(raw)
  _validated = result.env
  _envWarnings = result.warnings
  return result
}

/**
 * Return the validated env, throwing if `initEnv()` has not been called.
 * Useful in modules that import env values at the top level.
 */
export function getEnv(): Env {
  if (!_validated) {
    throw new Error('Environment not validated yet — call initEnv() first')
  }
  return _validated
}

/** Reset internal state — exposed for tests only. */
export function _resetEnvForTesting(): void {
  _validated = undefined
  _envWarnings = []
}

const _env = process.env.NODE_ENV ?? 'development'

export const config: AppConfig = {
  env: _env,
  port: _validated?.PORT ?? (process.env.PORT ? Number(process.env.PORT) : 3000),
  serviceName: _validated?.SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'disciplr-backend',
  corsOrigins: parseCorsOrigins(
    _validated?.CORS_ORIGINS ?? process.env.CORS_ORIGINS,
    _env,
  ),
}
