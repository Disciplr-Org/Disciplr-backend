import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { randomBytes } from 'node:crypto'
import { getStore as defaultGetStore, StoreConflictError } from '../apilib/store.mjs'
import { checkReadiness, isDatabaseUnavailable } from '../apilib/store-bootstrap.mjs'
import { OPENAPI } from '../apilib/openapi.mjs'
import { OnchainError, isEnabled, getConfig, getServer, buildCreateVaultTx, buildStakeTx, verifySignedTx, txHashOf, submitAndWait, validateForChain } from '../apilib/soroban.mjs'
import { safeCompare, expireOverdueVaults } from '../apilib/expiry.mjs'
import { validateCreateVault } from '../apilib/validation.mjs'
import { requestIdMiddleware } from '../apilib/log.mjs'
import { QueryValidationError, validateStatus, validateCreator, validateVaultId } from '../apilib/query.mjs'
import { encodeCursor, decodeCursor, parseLimit } from '../apilib/pagination.mjs'
import { failVault, validateMilestone } from '../shared/vaultMachine.mjs'
import { buildCorsOptions, parseAllowedOrigins, isOriginAllowed, helmetOptions } from '../apilib/cors.mjs'
import { createRateLimiter } from '../apilib/rateLimit.mjs'

// Milestone rows whose status the shared machine changed, in the shape store.transition() applies.
const changedMilestones = (before, after) => after.milestones
  .map((m, i) => (m.status !== before.milestones[i]?.status ? { id: m.id, status: m.status } : null))
  .filter(Boolean)

export function createApp(getStore = defaultGetStore, env = process.env) {
  const app = express()
  app.disable('x-powered-by')
  app.use(requestIdMiddleware())
  app.use(helmet(helmetOptions))

  const allowedOrigins = parseAllowedOrigins(env)
  const strictCors = cors(buildCorsOptions(env))

  app.use((req, res, next) => {
    // Permissive CORS for public GET (and HEAD) endpoints
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      return next()
    }

    // Strict CORS for OPTIONS preflight and state-changing requests
    strictCors(req, res, () => {
      if (req.method === 'OPTIONS') {
        // Disallowed origins on preflight get no CORS headers and terminate with 204
        return res.status(204).end()
      }

      if (req.method === 'POST') {
        const origin = req.headers.origin
        if (origin && !isOriginAllowed(origin, allowedOrigins)) {
          return res.status(403).json({ error: 'Origin not allowed' })
        }
      }

      next()
    })
  })

  app.use(express.json({ limit: '100kb' }))
  app.use(createRateLimiter({ getStore }))

  const hex = (n) => randomBytes(n).toString('hex')
  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg })
  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next)

  const router = express.Router()

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'disciplr-api', time: new Date().toISOString() })
  })
  router.get('/ready', wrap(async (_req, res) => {
    res.json({ status: 'ok', ...await checkReadiness(await getStore()) })
  }))
  router.get('/openapi.json', (_req, res) => res.json(OPENAPI))

  router.get('/vaults', wrap(async (req, res) => {
    const limitParam = req.query.limit
    const limit = limitParam !== undefined ? parseLimit(limitParam) : 25
    if (limit === null) return bad(res, 'limit must be an integer between 1 and 100')
    
    const cursorParam = req.query.cursor
    let cursor = null
    if (cursorParam) {
      cursor = decodeCursor(cursorParam)
      if (!cursor) return bad(res, 'Invalid cursor')
    }
    
    const creator = validateCreator(req.query.creator)
    const status = validateStatus(req.query.status)
    const s = await getStore()
    const result = await s.listVaults({ creator, status, limit, cursor })
    
    const nextCursor = result.hasMore && result.lastItem
      ? encodeCursor(result.lastItem.created_at || result.lastItem.createdAt, result.lastItem.id)
      : null
    
    res.json({
      data: result.items,
      count: result.items.length,
      page: { limit, nextCursor },
    })
  }))

  router.get('/vaults/:id', wrap(async (req, res) => {
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    const activityResult = await s.listActivity({ vaultId: v.id })
    res.json({ data: { ...v, activity: activityResult.items || activityResult } })
  }))

  router.post('/vaults', wrap(async (req, res) => {
    const testNow = req._now || req.query.now || req.headers['x-test-now']
    const nowForValidation = testNow ? new Date(testNow) : new Date()
    const validation = validateCreateVault(req.body, { now: nowForValidation })
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation failed', details: validation.details })
    }

    const validData = validation.data
    const id = 'vault-' + hex(6)
    validData.milestones.forEach((m, i) => { m.id = `${id}-m${i + 1}`; delete m._i })
    const now = new Date().toISOString()
    const s = await getStore()
    const chain = isEnabled()
    const vault = {
      id,
      name: validData.name || `Vault ${validData.amount}`,
      creator: validData.creator,
      amount: validData.amount,
      status: chain ? 'draft' : 'active',
      onchainStatus: chain ? 'pending_onchain' : null,
      startDate: validData.startDate,
      endDate: validData.endDate,
      verifier: validData.verifier,
      successDestination: validData.successDestination,
      failureDestination: validData.failureDestination,
      createdAt: now,
      updatedAt: now,
      milestones: validData.milestones,
    }
    if (chain) {
      // Build + simulate first so an invalid vault is rejected before anything is stored.
      const cfg = getConfig()
      validateForChain(vault)
      const onChain = await buildCreateVaultTx(getServer(cfg), cfg, vault)
      await s.createVault(vault)
      return res.status(201).json({ data: vault, onChain })
    }
    await s.createVault(vault)
    await s.addActivity({ id: crypto.randomUUID(), type: 'create', vaultId: id, amount: vault.amount, status: 'simulated', hash: hex(32), memo: 'Vault created', createdAt: now })
    res.status(201).json({ data: vault })
  }))

  // Build the unsigned stake invocation for a vault whose create_vault is confirmed on-chain.
  router.post('/vaults/:id/onchain/stake', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.onchainStatus === 'active') return bad(res, 'Vault is already active', 409)
    if (v.onchainStatus !== 'created') return bad(res, 'Vault must be created on-chain before staking', 409)
    const cfg = getConfig()
    res.json({ data: v, onChain: await buildStakeTx(getServer(cfg), cfg, v) })
  }))

  // Accept the creator-signed XDR for create_vault or stake, verify it, relay it and record the real result.
  router.post('/vaults/:id/onchain/submit', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    const cfg = getConfig()
    const { signedXdr, networkPassphrase } = req.body || {}
    if (typeof signedXdr !== 'string' || !signedXdr) return bad(res, 'signedXdr is required')
    if (networkPassphrase !== undefined && networkPassphrase !== cfg.networkPassphrase) return bad(res, 'Network passphrase mismatch')
    const operation = v.onchainStatus === 'pending_onchain' ? 'create_vault' : v.onchainStatus === 'created' ? 'stake' : null
    // Idempotency is keyed by tx hash: a resubmission of an already-recorded transaction never broadcasts a duplicate row.
    const probeHash = txHashOf(signedXdr, cfg)
    let existing = probeHash ? await s.getActivityByHash(probeHash) : null
    if (existing && existing.vaultId !== v.id) existing = null
    if (existing && existing.status !== 'pending') return res.status(existing.status === 'failed' ? 422 : 200).json({ data: v, activity: existing })
    if (!operation) return bad(res, 'Vault is already active', 409)
    const { tx, hash } = verifySignedTx(signedXdr, v, operation, cfg)
    const now = new Date().toISOString()
    const act = existing || await s.addActivity({ id: crypto.randomUUID(), type: operation === 'stake' ? 'stake' : 'create', vaultId: v.id, amount: v.amount, status: 'pending', hash, memo: `${operation} submitted`, ledger: null, createdAt: now })
    const r = await submitAndWait(getServer(cfg), tx, hash, { resume: !!existing, timeoutMs: Number(process.env.SOROBAN_POLL_TIMEOUT_MS) || 30000, intervalMs: Number(process.env.SOROBAN_POLL_INTERVAL_MS) || 1000 })
    if (r.status === 'PENDING') return res.status(202).json({ data: v, activity: act })
    act.ledger = r.ledger ?? null
    if (r.status === 'SUCCESS') {
      act.status = 'confirmed'; act.memo = operation === 'stake' ? 'Vault staked' : 'Vault created on-chain'
      v.onchainStatus = operation === 'stake' ? 'active' : 'created'
      if (operation === 'stake') v.status = 'active'
      await s.saveActivity(act); await s.saveVault(v)
      return res.json({ data: v, activity: act })
    }
    act.status = 'failed'; act.memo = `${operation} failed: ${r.error.name}${r.error.message ? ` - ${r.error.message}` : ''}`
    await s.saveActivity(act)
    res.status(422).json({ error: `${r.error.name}: ${r.error.message}`, data: v, activity: act })
  }))

  // Creator submits evidence for a milestone: URL + SHA-256 hash + optional note
  router.post('/vaults/:id/milestones/:mid/evidence', wrap(async (req, res) => {
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.status !== 'active') return bad(res, `Vault is ${v.status}`, 409)
    const m = v.milestones.find((x) => x.id === req.params.mid)
    if (!m) return bad(res, 'Milestone not found', 404)
    if (m.status === 'completed') return bad(res, 'Milestone already completed', 409)
    if (m.status === 'failed' || m.status === 'cancelled') return bad(res, `Milestone is ${m.status}`, 409)

    const b = req.body || {}
    const errs = []
    if (b.submitter !== v.creator) errs.push('Only the vault creator may submit evidence')
    const url = String(b.url || '').trim()
    if (!url.startsWith('https://')) errs.push('url must be an HTTPS URL')
    if (url.length > 2048) errs.push('url must be at most 2048 characters')
    const sha256 = String(b.sha256 || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha256)) errs.push('sha256 must be 64 lowercase hexadecimal characters')
    const note = b.note ? String(b.note).trim() : null
    if (note && note.length > 1000) errs.push('note must be at most 1000 characters')
    if (errs.length) return res.status(b.submitter !== v.creator ? 403 : 400).json({ error: 'Validation failed', details: errs })

    const evidence = await s.addMilestoneEvidence({
      id: randomUUID(),
      vaultId: v.id,
      milestoneId: m.id,
      url,
      sha256,
      note,
      submittedBy: b.submitter,
      verified: false,
    })

    await s.addActivity({
      id: randomUUID(),
      type: 'evidence',
      vaultId: v.id,
      amount: m.amount,
      status: 'simulated',
      hash: hex(32),
      memo: `Evidence submitted for: ${m.title}`,
      createdAt: new Date().toISOString(),
    })

    res.status(201).json({ data: evidence })
  }))

  // Verifier validates a milestone. When every milestone is validated the vault completes and funds release.
  router.post('/vaults/:id/milestones/:mid/validate', wrap(async (req, res) => {
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.status !== 'active') return bad(res, `Vault is ${v.status}`, 409)
    if (req.body?.verifier !== v.verifier) return bad(res, 'Only the vault verifier may validate milestones', 403)
    const m = v.milestones.find((x) => x.id === req.params.mid)
    if (!m) return bad(res, 'Milestone not found', 404)
    if (m.status === 'completed') return bad(res, 'Milestone already validated', 409)

    const currentTime = req._now || req.query.now || req.headers['x-test-now']
      ? new Date(req._now || req.query.now || req.headers['x-test-now'])
      : new Date()
    if (currentTime > new Date(v.endDate)) {
      return bad(res, 'Vault deadline has passed', 409)
    }
    if (currentTime > new Date(m.dueDate)) {
      return bad(res, 'Milestone due date has passed', 409)
    }

    // Re-check and apply under the store's per-vault transition (row locks in Postgres, a per-vault
    // queue in memory) so concurrent validate/fail requests cannot double-complete or double-release.
    const result = await s.transition(v.id, (live) => {
      const outcome = validateMilestone(live, req.params.mid, currentTime, { hash: () => hex(32) })
      if (!outcome.ok) return { conflict: true, error: outcome.message }
      return {
        vaultStatus: outcome.vault.status,
        milestoneUpdates: changedMilestones(live, outcome.vault),
        activities: outcome.activities,
      }
    })
    if (!result) return bad(res, 'Vault not found', 404)
    res.json({ data: result.vault })
  }))

  // Verifier (or creator) declares failure: funds redirect to the failure destination.
  router.post('/vaults/:id/fail', wrap(async (req, res) => {
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.status !== 'active') return bad(res, `Vault is ${v.status}`, 409)
    if (req.body?.verifier !== v.verifier) return bad(res, 'Only the vault verifier may fail a vault', 403)
    const now = new Date()
    const result = await s.transition(v.id, (live) => {
      const outcome = failVault(live, now, { hash: () => hex(32) })
      if (!outcome.ok) return { conflict: true, error: outcome.message }
      return {
        vaultStatus: outcome.vault.status,
        milestoneUpdates: changedMilestones(live, outcome.vault),
        activities: outcome.activities,
      }
    })
    if (!result) return bad(res, 'Vault not found', 404)
    res.json({ data: result.vault })
  }))

  router.get('/transactions', wrap(async (req, res) => {
    const limitParam = req.query.limit
    const limit = limitParam !== undefined ? parseLimit(limitParam) : 25
    if (limit === null) return bad(res, 'limit must be an integer between 1 and 100')
    
    const cursorParam = req.query.cursor
    let cursor = null
    if (cursorParam) {
      cursor = decodeCursor(cursorParam)
      if (!cursor) return bad(res, 'Invalid cursor')
    }
    
    const vaultId = validateVaultId(req.query.vaultId)
    const s = await getStore()
    const result = await s.listActivity({ vaultId, limit, cursor })
    
    const nextCursor = result.hasMore && result.lastItem
      ? encodeCursor(result.lastItem.created_at || result.lastItem.createdAt, result.lastItem.id)
      : null
    
    res.json({
      data: result.items,
      count: result.items.length,
      page: { limit, nextCursor },
    })
  }))

  router.get('/stats', wrap(async (req, res) => {
    const creator = validateCreator(req.query.creator)
    const s = await getStore()
    // Use aggregateStats if available (Postgres or Memory store)
    const stats = typeof s.aggregateStats === 'function'
      ? await s.aggregateStats({ creator, verifier: req.query.verifier })
      : { totalVaults: 0, active: 0, completed: 0, failed: 0, totalLocked: '0', totalReleased: '0', totalRedirected: '0' }
    const { totalVaults, active, completed, failed, totalLocked, totalReleased, totalRedirected } = stats
    const done = completed + failed
    const successRate = done ? Math.round((completed / done) * 100) : null
    res.json({
      data: {
        totalVaults,
        active,
        completed,
        failed,
        totalLocked,
        totalReleased,
        totalRedirected,
        successRate,
      },
    })
  }))

  router.get('/cron/expire-vaults', wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')

    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret) {
      return res.status(503).json({ error: 'Service Unavailable: CRON_SECRET is not configured' })
    }

    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token || !safeCompare(token, cronSecret)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const now = req._now || req.query.now
    const batchSize = req.query.limit ? parseInt(req.query.limit, 10) : 100

    const result = await expireOverdueVaults({ now, batchSize, store: await getStore() })
    res.json({ processed: result.processed, remaining: result.remaining })
  }))

  app.use(['/api/v1', '/api'], (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Unsupported Media Type: Content-Type must be application/json' })
    }
    next()
  })

  app.use(['/api/v1', '/api'], router)

  // 405 Method Not Allowed for known API endpoints
  const methodMap = [
    { pattern: /^\/api(?:\/v1)?\/vaults\/?$/, allow: 'GET, POST' },
    { pattern: /^\/api(?:\/v1)?\/vaults\/[^\/]+\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/vaults\/[^\/]+\/sign\/?$/, allow: 'POST' },
    { pattern: /^\/api(?:\/v1)?\/vaults\/[^\/]+\/milestones\/[^\/]+\/validate\/?$/, allow: 'POST' },
    { pattern: /^\/api(?:\/v1)?\/vaults\/[^\/]+\/fail\/?$/, allow: 'POST' },
    { pattern: /^\/api(?:\/v1)?\/transactions\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/stats\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/health\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/ready\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/openapi\.json\/?$/, allow: 'GET' },
    { pattern: /^\/api(?:\/v1)?\/cron\/expire-vaults\/?$/, allow: 'GET' },
  ]
  app.use((req, res, next) => {
    const match = methodMap.find((m) => m.pattern.test(req.path))
    if (match) {
      res.setHeader('Allow', match.allow)
      return res.status(405).json({ error: `Method Not Allowed: use ${match.allow}` })
    }
    next()
  })

  // 404 Fallback
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

  // Error-handling middleware (4 arguments required by Express)
  // Maps Express entity.parse.failed -> 400, entity.too.large -> 413, charset/encoding -> 415,
  // QueryValidationError -> 400, isDatabaseUnavailable -> 503, StoreConflictError -> 409,
  // OnchainError -> e.status, and everything else -> safe 500 JSON without stack leak.
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' })
    }
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'Payload Too Large' })
    }
    if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported' || err?.status === 415) {
      return res.status(415).json({ error: 'Unsupported Media Type' })
    }
    if (err instanceof QueryValidationError) {
      return res.status(err.status || 400).json({ error: err.message, ...(err.details && { details: err.details }) })
    }
    if (isDatabaseUnavailable(err)) {
      return res.set('Retry-After', '1').status(503).json({ error: 'Database unavailable' })
    }
    if (err instanceof StoreConflictError) {
      return res.status(409).json({ error: err.message })
    }
    if (err instanceof OnchainError) {
      return res.status(err.status).json({ error: err.message, ...(err.contractError && { contractError: err.contractError }) })
    }
    if (req?.log?.error) {
      req.log.error({ err }, 'API request failed')
    } else {
      console.error('API request failed')
    }
    return res.status(500).json({ error: 'Internal error', ...(req?.id && { requestId: req.id }) })
  })

  return app
}

const app = createApp()
export default app

if (process.argv[1] && process.argv[1].endsWith('api/index.mjs')) {
  const port = process.env.PORT || 3001
  app.listen(port, () => console.log(`Disciplr API on :${port}`))
}
