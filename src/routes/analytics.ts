import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { listMilestoneEvents } from '../services/milestones.js'
import { utcNow } from '../utils/timestamps.js'

export const analyticsRouter = Router()

type TrendGroupBy = 'day' | 'week'

interface TrendBucket {
  bucketStart: string
  bucketEnd: string
  total: number
  successes: number
  failures: number
}

const DAY_IN_MS = 24 * 60 * 60 * 1000
const WEEK_IN_MS = 7 * DAY_IN_MS

const logAnalyticsEvent = (event: string, details: Record<string, unknown>): void => {
  console.log(
    JSON.stringify({
      level: 'info',
      event,
      service: 'disciplr-backend',
      timestamp: utcNow(),
      ...details,
    }),
  )
}

const parseIsoDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const getBucketDuration = (groupBy: TrendGroupBy): number => {
  return groupBy === 'week' ? WEEK_IN_MS : DAY_IN_MS
}

const buildTrendBuckets = (
  from: Date,
  to: Date,
  groupBy: TrendGroupBy,
  events: ReturnType<typeof listMilestoneEvents>,
): TrendBucket[] => {
  const bucketDuration = getBucketDuration(groupBy)
  const buckets = new Map<number, TrendBucket>()

  for (let cursor = from.getTime(); cursor <= to.getTime(); cursor += bucketDuration) {
    const bucketEnd = Math.min(cursor + bucketDuration - 1, to.getTime())
    buckets.set(cursor, {
      bucketStart: new Date(cursor).toISOString(),
      bucketEnd: new Date(bucketEnd).toISOString(),
      total: 0,
      successes: 0,
      failures: 0,
    })
  }

  for (const event of events) {
    const eventTime = new Date(event.timestamp).getTime()
    const bucketIndex = Math.floor((eventTime - from.getTime()) / bucketDuration)
    const bucketStart = from.getTime() + bucketIndex * bucketDuration
    const bucket = buckets.get(bucketStart)

    if (!bucket) {
      continue
    }

    bucket.total += 1
    if (event.status === 'success') {
      bucket.successes += 1
    } else {
      bucket.failures += 1
    }
  }

  return Array.from(buckets.values())
}

analyticsRouter.get('/summary', authenticate, (_req, res) => {
  res.status(200).json({
    total_vaults: 10,
    active_vaults: 5,
    completed_vaults: 3,
    failed_vaults: 2,
    total_locked_capital: '5000.0000000',
    active_capital: '2500.0000000',
    success_rate: 60.0,
    last_updated: utcNow(),
  })
})

analyticsRouter.get('/overview', authenticateApiKey(['read:analytics']), (_req, res) => {
  res.status(200).json({
    generatedAt: utcNow(),
    status: 'ok',
  })
})

analyticsRouter.get('/vaults', authenticateApiKey(['read:vaults']), (_req, res) => {
  res.status(200).json({
    vaults: [],
    generatedAt: utcNow(),
  })
})

analyticsRouter.get('/vaults/:id', authenticate, (req, res) => {
  res.status(200).json({
    vault_id: req.params.id,
    status: 'active',
    performance: 'on_track',
  })
})

analyticsRouter.get('/milestones/trends', authenticateApiKey(['read:analytics']), (req, res) => {
  const from = parseIsoDate(req.query.from)
  const to = parseIsoDate(req.query.to)
  const groupBy = req.query.groupBy === 'week' ? 'week' : 'day'

  if (!from || !to) {
    logAnalyticsEvent('analytics.milestones_trends.invalid_query', {
      reason: 'invalid_date_range',
      hasFrom: Boolean(req.query.from),
      hasTo: Boolean(req.query.to),
    })
    res.status(400).json({ error: '`from` and `to` must be valid ISO-8601 timestamps.' })
    return
  }

  if (from.getTime() > to.getTime()) {
    logAnalyticsEvent('analytics.milestones_trends.invalid_query', {
      reason: 'from_after_to',
      groupBy,
    })
    res.status(400).json({ error: '`from` must be less than or equal to `to`.' })
    return
  }

  const events = listMilestoneEvents({
    from: from.toISOString(),
    to: to.toISOString(),
  })

  const buckets = buildTrendBuckets(from, to, groupBy, events)

  logAnalyticsEvent('analytics.milestones_trends.generated', {
    groupBy,
    bucketCount: buckets.length,
    eventCount: events.length,
  })

  res.status(200).json({
    from: from.toISOString(),
    to: to.toISOString(),
    groupBy,
    buckets,
  })
})

analyticsRouter.get('/behavior', authenticateApiKey(['read:analytics']), (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : ''
  const baseScorePerSuccess = Number(req.query.baseScorePerSuccess ?? 10)
  const penaltyPerFailure = Number(req.query.penaltyPerFailure ?? 5)
  const from = parseIsoDate(req.query.from)
  const to = parseIsoDate(req.query.to)

  if (!userId) {
    logAnalyticsEvent('analytics.behavior.invalid_query', {
      reason: 'missing_user_id',
    })
    res.status(400).json({ error: '`userId` is required.' })
    return
  }

  if (!Number.isFinite(baseScorePerSuccess) || !Number.isFinite(penaltyPerFailure)) {
    logAnalyticsEvent('analytics.behavior.invalid_query', {
      reason: 'invalid_score_modifiers',
    })
    res.status(400).json({ error: 'Score modifiers must be valid numbers.' })
    return
  }

  if ((req.query.from && !from) || (req.query.to && !to)) {
    logAnalyticsEvent('analytics.behavior.invalid_query', {
      reason: 'invalid_date_filter',
    })
    res.status(400).json({ error: '`from` and `to` must be valid ISO-8601 timestamps when provided.' })
    return
  }

  if (from && to && from.getTime() > to.getTime()) {
    logAnalyticsEvent('analytics.behavior.invalid_query', {
      reason: 'from_after_to',
    })
    res.status(400).json({ error: '`from` must be less than or equal to `to`.' })
    return
  }

  const events = listMilestoneEvents({
    userId,
    from: from?.toISOString(),
    to: to?.toISOString(),
  })

  const successes = events.filter((event) => event.status === 'success').length
  const failures = events.length - successes
  const behaviorScore = successes * baseScorePerSuccess - failures * penaltyPerFailure

  logAnalyticsEvent('analytics.behavior.generated', {
    eventCount: events.length,
    successes,
    failures,
  })

  res.status(200).json({
    userId,
    successes,
    failures,
    behaviorScore,
    evaluatedFrom: from?.toISOString() ?? null,
    evaluatedTo: to?.toISOString() ?? null,
  })
})
