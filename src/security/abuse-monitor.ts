import type { NextFunction, Request, Response } from 'express'

type SuspiciousPatternType =
  | 'endpoint_scan'
  | 'high_volume'
  | 'repeated_bad_requests'
  | 'failed_login_burst'

type RequestEvent = {
  ts: number
  path: string
  status: number
}

type IpState = {
  requestTimes: number[]
  recentEvents: RequestEvent[]
  failedLoginTimes: number[]
  lastAlertAt: Partial<Record<SuspiciousPatternType, number>>
  lastSeen: number
}

type SecurityMetrics = {
  failedLoginAttempts: number
  rateLimitTriggers: number
  suspiciousPatterns: Record<SuspiciousPatternType, number>
}

const config = {
  rateLimitWindowMs: readPositiveIntEnv('SECURITY_RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: readPositiveIntEnv('SECURITY_RATE_LIMIT_MAX_REQUESTS', 120),
  suspiciousWindowMs: readPositiveIntEnv('SECURITY_SUSPICIOUS_WINDOW_MS', 300_000),
  suspicious404Threshold: readPositiveIntEnv('SECURITY_SUSPICIOUS_404_THRESHOLD', 20),
  suspiciousDistinctPathThreshold: readPositiveIntEnv(
    'SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD',
    12,
  ),
  suspiciousBadRequestThreshold: readPositiveIntEnv(
    'SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD',
    30,
  ),
  suspiciousHighVolumeThreshold: readPositiveIntEnv(
    'SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD',
    300,
  ),
  failedLoginWindowMs: readPositiveIntEnv('SECURITY_FAILED_LOGIN_WINDOW_MS', 900_000),
  failedLoginBurstThreshold: readPositiveIntEnv('SECURITY_FAILED_LOGIN_BURST_THRESHOLD', 5),
  alertCooldownMs: readPositiveIntEnv('SECURITY_ALERT_COOLDOWN_MS', 300_000),
}

const ipStates = new Map<string, IpState>()
const metrics: SecurityMetrics = {
  failedLoginAttempts: 0,
  rateLimitTriggers: 0,
  suspiciousPatterns: {
    endpoint_scan: 0,
    high_volume: 0,
    repeated_bad_requests: 0,
    failed_login_burst: 0,
  },
}

let processedEvents = 0

export function securityMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on('finish', () => {
    const now = Date.now()
    const ip = getClientIp(req)
    const state = getIpState(ip, now)

    pruneState(state, now)

    const path = sanitizePath(req.originalUrl)
    const status = res.statusCode

    state.recentEvents.push({ ts: now, path, status })
    state.lastSeen = now

    if (isFailedLoginAttempt(path, status)) {
      state.failedLoginTimes.push(now)
      metrics.failedLoginAttempts += 1
      logSecurityEvent('security.failed_login_attempt', {
        ip,
        path,
        method: req.method,
        status,
        failedLoginsInWindow: state.failedLoginTimes.length,
        windowMs: config.failedLoginWindowMs,
      })
    }

    evaluateSuspiciousPatterns(state, ip, now)
    maybeCleanupIdleIpStates(now)
  })

  next()
}

export function securityRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const now = Date.now()
  const ip = getClientIp(req)
  const state = getIpState(ip, now)

  pruneState(state, now)

  state.requestTimes.push(now)
  state.lastSeen = now

  if (state.requestTimes.length > config.rateLimitMaxRequests) {
    metrics.rateLimitTriggers += 1
    logSecurityEvent('security.rate_limit_triggered', {
      ip,
      path: sanitizePath(req.originalUrl),
      method: req.method,
      requestCount: state.requestTimes.length,
      windowMs: config.rateLimitWindowMs,
      threshold: config.rateLimitMaxRequests,
    })
    res.status(429).json({ error: 'Too many requests' })
    return
  }

  next()
}

export function getSecurityMetricsSnapshot(): Record<string, unknown> {
  const now = Date.now()

  const topSources = [...ipStates.entries()]
    .map(([ip, state]) => {
      pruneState(state, now)
      const requestsInRateLimitWindow = state.requestTimes.length
      const eventsInSuspiciousWindow = state.recentEvents.length
      const failedLoginsInWindow = state.failedLoginTimes.length

      return {
        ip,
        requestsInRateLimitWindow,
        eventsInSuspiciousWindow,
        failedLoginsInWindow,
      }
    })
    .filter(
      (source) =>
        source.requestsInRateLimitWindow > 0 ||
        source.eventsInSuspiciousWindow > 0 ||
        source.failedLoginsInWindow > 0,
    )
    .sort((a, b) => b.eventsInSuspiciousWindow - a.eventsInSuspiciousWindow)
    .slice(0, 10)

  return {
    timestamp: new Date(now).toISOString(),
    metrics: {
      failedLoginAttempts: metrics.failedLoginAttempts,
      rateLimitTriggers: metrics.rateLimitTriggers,
      suspiciousPatterns: { ...metrics.suspiciousPatterns },
    },
    thresholds: {
      rateLimitWindowMs: config.rateLimitWindowMs,
      rateLimitMaxRequests: config.rateLimitMaxRequests,
      suspiciousWindowMs: config.suspiciousWindowMs,
      suspicious404Threshold: config.suspicious404Threshold,
      suspiciousDistinctPathThreshold: config.suspiciousDistinctPathThreshold,
      suspiciousBadRequestThreshold: config.suspiciousBadRequestThreshold,
      suspiciousHighVolumeThreshold: config.suspiciousHighVolumeThreshold,
      failedLoginWindowMs: config.failedLoginWindowMs,
      failedLoginBurstThreshold: config.failedLoginBurstThreshold,
      alertCooldownMs: config.alertCooldownMs,
    },
    activeIpCount: ipStates.size,
    topSources,
  }
}

function getIpState(ip: string, now: number): IpState {
  const existing = ipStates.get(ip)
  if (existing) {
    return existing
  }

  const created: IpState = {
    requestTimes: [],
    recentEvents: [],
    failedLoginTimes: [],
    lastAlertAt: {},
    lastSeen: now,
  }
  ipStates.set(ip, created)
  return created
}

function pruneState(state: IpState, now: number): void {
  const rateLimitCutoff = now - config.rateLimitWindowMs
  const suspiciousCutoff = now - config.suspiciousWindowMs
  const failedLoginCutoff = now - config.failedLoginWindowMs

  state.requestTimes = state.requestTimes.filter((ts) => ts >= rateLimitCutoff)
  state.recentEvents = state.recentEvents.filter((event) => event.ts >= suspiciousCutoff)
  state.failedLoginTimes = state.failedLoginTimes.filter((ts) => ts >= failedLoginCutoff)
}

function evaluateSuspiciousPatterns(state: IpState, ip: string, now: number): void {
  const events = state.recentEvents
  const totalEvents = events.length

  if (totalEvents >= config.suspiciousHighVolumeThreshold) {
    emitSuspiciousAlert('high_volume', state, ip, now, {
      currentValue: totalEvents,
      threshold: config.suspiciousHighVolumeThreshold,
      windowMs: config.suspiciousWindowMs,
    })
  }

  const notFoundEvents = events.filter((event) => event.status === 404)
  const distinctPathsFrom404s = new Set(notFoundEvents.map((event) => event.path)).size

  if (
    notFoundEvents.length >= config.suspicious404Threshold &&
    distinctPathsFrom404s >= config.suspiciousDistinctPathThreshold
  ) {
    emitSuspiciousAlert('endpoint_scan', state, ip, now, {
      current404Count: notFoundEvents.length,
      distinctPathCount: distinctPathsFrom404s,
      threshold404: config.suspicious404Threshold,
      thresholdDistinctPaths: config.suspiciousDistinctPathThreshold,
      windowMs: config.suspiciousWindowMs,
    })
  }

  const badRequestCount = events.filter((event) => event.status === 400).length
  if (badRequestCount >= config.suspiciousBadRequestThreshold) {
    emitSuspiciousAlert('repeated_bad_requests', state, ip, now, {
      currentValue: badRequestCount,
      threshold: config.suspiciousBadRequestThreshold,
      windowMs: config.suspiciousWindowMs,
    })
  }

  if (state.failedLoginTimes.length >= config.failedLoginBurstThreshold) {
    emitSuspiciousAlert('failed_login_burst', state, ip, now, {
      currentValue: state.failedLoginTimes.length,
      threshold: config.failedLoginBurstThreshold,
      windowMs: config.failedLoginWindowMs,
    })
  }
}

function emitSuspiciousAlert(
  pattern: SuspiciousPatternType,
  state: IpState,
  ip: string,
  now: number,
  details: Record<string, number>,
): void {
  const previousAlert = state.lastAlertAt[pattern] ?? 0
  if (now - previousAlert < config.alertCooldownMs) {
    return
  }

  state.lastAlertAt[pattern] = now
  metrics.suspiciousPatterns[pattern] += 1

  logSecurityEvent('security.suspicious_pattern', {
    ip,
    pattern,
    alertCooldownMs: config.alertCooldownMs,
    ...details,
  })
}

function maybeCleanupIdleIpStates(now: number): void {
  processedEvents += 1
  if (processedEvents % 200 !== 0) {
    return
  }

  const staleAfterMs =
    Math.max(
      config.rateLimitWindowMs,
      config.suspiciousWindowMs,
      config.failedLoginWindowMs,
    ) + config.alertCooldownMs

  for (const [ip, state] of ipStates.entries()) {
    if (now - state.lastSeen > staleAfterMs) {
      ipStates.delete(ip)
    }
  }
}

function getClientIp(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for']

  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim()
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].split(',')[0].trim()
  }

  return req.socket.remoteAddress ?? 'unknown'
}

function isFailedLoginAttempt(path: string, status: number): boolean {
  if (status !== 401 && status !== 403) {
    return false
  }

  const normalizedPath = path.toLowerCase()
  return normalizedPath.includes('/auth') || normalizedPath.includes('/login')
}

function sanitizePath(path: string): string {
  const [sanitized] = path.split('?')
  return sanitized || '/'
}

function logSecurityEvent(event: string, data: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: 'warn',
      event,
      service: 'disciplr-backend',
      timestamp: new Date().toISOString(),
      ...data,
    }),
  )
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}
