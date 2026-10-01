import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { healthService } from '../services/healthService.js'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'
import type { AbuseMonitor } from '../services/abuse-monitor.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { getPendingCount, getDueCount } from '../services/deferredReminders.service.js'

const deepHealthHttpStatus = (status: string): number => {
  if (status === 'error') return 503
  if (status === 'degraded') return 207
  return 200
}

export const createHealthRouter = (
  jobSystem: BackgroundJobSystem,
  privacyAbuseMonitor?: AbuseMonitor,
): Router => {
  const router = Router()

  router.get('/', async (req, res) => {
    const isDeep = req.query.deep === '1'

    if (isDeep) {
      const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
      return res.status(deepHealthHttpStatus(deepStatus.status)).json(deepStatus)
    }

    return res.status(200).json(healthService.buildHealthStatus('disciplr-api', jobSystem))
  })

  router.get('/deep', async (req, res) => {
    const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
    return res.status(deepHealthHttpStatus(deepStatus.status)).json(deepStatus)
  })

  // GET /api/health/security
  //
  // Returns a live snapshot of the app's abuse-detection telemetry, including:
  //   - Aggregate counters: total failed login attempts, rate-limit trips, and
  //     per-pattern suspicious event counts (endpoint_scan, high_volume,
  //     repeated_bad_requests, failed_login_burst).
  //   - Detection thresholds: the active values of all SECURITY_* env vars so
  //     operators can confirm runtime config at a glance.
  //   - topSources: up to 10 source IPs ranked by recent event volume, each
  //     annotated with requestsInRateLimitWindow, eventsInSuspiciousWindow, and
  //     failedLoginsInWindow drawn from the in-memory per-IP state in
  //     src/security/abuse-monitor.ts (getSecurityMetricsSnapshot).
  //   - privacy.categoryCounts: per-AbuseCategory counts from the optional
  //     privacyAbuseMonitor (mounted via src/routes/privacy.ts) when present.
  //   - deferredReminders: pending/due deferred-reminder counts from
  //     src/services/deferredReminders.service.ts; null on query failure so a
  //     DB outage never blocks the security snapshot itself.
  //
  // SECURITY: This endpoint is intentionally gated behind TWO middleware layers:
  //
  //   1. authenticate  — validates the Bearer token / session and populates
  //      req.user (src/middleware/auth.ts). Unauthenticated requests receive 401.
  //
  //   2. requireAdmin  — calls enforceRBAC({ allow: [UserRole.ADMIN] }) from
  //      src/middleware/rbac.ts, which rejects any non-admin role with 403 and
  //      emits a structured `security.rbac_denied` log event.
  //
  // Both guards are required because the response contains:
  //   a) Raw client IP addresses in topSources — IP-level PII that must not be
  //      exposed to anonymous or unprivileged callers.
  //   b) Live detection thresholds — exposing these to attackers would allow
  //      them to calibrate request volume to stay just below rate-limit and
  //      suspicious-pattern triggers, undermining the detection system entirely.
  //
  // This matches the pattern used for the /metrics endpoint (metricsAuth) and
  // all routes under /api/admin. Do NOT remove or relax these guards without
  // a security review.
  router.get('/security', authenticate, requireAdmin, async (req, res) => {
    // Collect global abuse-monitor counters and thresholds. getSecurityMetricsSnapshot()
    // reads from the module-level in-memory state maintained by securityMetricsMiddleware
    // and securityRateLimitMiddleware (both mounted app-wide in app-bootstrap.ts).
    const globalMetrics = getSecurityMetricsSnapshot()
    const securityData: Record<string, unknown> = {
      ...globalMetrics,
      // Override the timestamp already included in globalMetrics with a fresh
      // one so the response reflects the exact moment the handler ran, not the
      // moment the snapshot was computed internally.
      timestamp: new Date().toISOString(),
    }

    // Merge privacy-layer abuse counts when the optional privacyAbuseMonitor is
    // wired in. This monitor tracks a separate AbuseCategory taxonomy
    // (brute-force, enumeration, payload-anomaly, rate-limit-trip) maintained
    // by src/routes/privacy.ts and surfaced here for a unified security view.
    if (privacyAbuseMonitor) {
      securityData.privacy = {
        categoryCounts: privacyAbuseMonitor.getCategoryCounts(),
      }
    }

    // Append deferred-reminder queue depth as an operational signal. A large
    // pending/due count can indicate reminder processing is falling behind,
    // which may correlate with job-queue pressure or DB degradation.
    // Errors are caught and nulled out intentionally: a DB failure here must
    // not prevent the rest of the security snapshot from being returned.
    try {
      const [pendingCount, dueCount] = await Promise.all([getPendingCount(), getDueCount()])
      securityData.deferredReminders = { pendingCount, dueCount }
    } catch {
      securityData.deferredReminders = { pendingCount: null, dueCount: null, error: 'Failed to query' }
    }

    return res.status(200).json(securityData)
  })

  return router
}
