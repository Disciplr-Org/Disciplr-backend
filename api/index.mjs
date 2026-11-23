import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { randomBytes } from 'node:crypto'
import { getStore as defaultGetStore, StoreConflictError } from '../apilib/store.mjs'
import { checkReadiness, isDatabaseUnavailable } from '../apilib/store-bootstrap.mjs'
import { OPENAPI } from '../apilib/openapi.mjs'
import { OnchainError, isEnabled, getConfig, getServer, buildCreateVaultTx, buildStakeTx, buildClaimMilestoneTx, buildSlashTx, buildWithdrawTx, verifySignedTx, txHashOf, submitAndWait, validateForChain } from '../apilib/soroban.mjs'
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

  // Helper to resolve milestone index from { milestoneId } or { index }
  const resolveMilestoneIndex = (vault, body = {}) => {
    if (body.milestoneId !== undefined && body.milestoneId !== null) {
      const idx = vault.milestones.findIndex((m) => m.id === body.milestoneId)
      if (idx < 0) return { error: 'Milestone not found', status: 404 }
      return { index: idx, milestone: vault.milestones[idx] }
    }
    if (body.index !== undefined && body.index !== null) {
      const idx = Number(body.index)
      if (!Number.isInteger(idx) || idx < 0 || idx >= vault.milestones.length) {
        return { error: 'Milestone index out of range', status: 400 }
      }
      return { index: idx, milestone: vault.milestones[idx] }
    }
    return { error: 'milestoneId or index is required', status: 400 }
  }

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

  // Build the unsigned claim_milestone invocation for an active on-chain vault.
  router.post('/vaults/:id/onchain/claim-milestone', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.onchainStatus !== 'active' || v.status !== 'active') return bad(res, 'Vault must be active on-chain to claim a milestone', 409)
    const resolved = resolveMilestoneIndex(v, req.body || {})
    if (resolved.error) return bad(res, resolved.error, resolved.status)
    const cfg = getConfig()
    const caller = req.body?.caller
    res.json({ data: v, onChain: await buildClaimMilestoneTx(getServer(cfg), cfg, v, { caller, index: resolved.index }) })
  }))

  // Build the unsigned slash_on_miss invocation for an active on-chain vault.
  router.post('/vaults/:id/onchain/slash', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.onchainStatus !== 'active' || v.status !== 'active') return bad(res, 'Vault must be active on-chain to slash', 409)
    const cfg = getConfig()
    const caller = req.body?.caller
    res.json({ data: v, onChain: await buildSlashTx(getServer(cfg), cfg, v, { caller }) })
  }))

  // Build the unsigned withdraw invocation for an active or completed on-chain vault.
  router.post('/vaults/:id/onchain/withdraw', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    if (v.onchainStatus !== 'active') return bad(res, 'Vault must be active on-chain to withdraw', 409)
    const cfg = getConfig()
    res.json({ data: v, onChain: await buildWithdrawTx(getServer(cfg), cfg, v) })
  }))

  // Accept a signed XDR for create_vault, stake, claim_milestone, slash_on_miss or withdraw,
  // verify it against expectedArgs, relay it and record the real result.
  router.post('/vaults/:id/onchain/submit', wrap(async (req, res) => {
    if (!isEnabled()) return bad(res, 'On-chain mode is disabled', 409)
    const s = await getStore()
    const v = await s.getVault(req.params.id)
    if (!v) return bad(res, 'Vault not found', 404)
    const cfg = getConfig()
    const { signedXdr, networkPassphrase, operation: rawOp, milestoneId, index, caller } = req.body || {}
    if (typeof signedXdr !== 'string' || !signedXdr) return bad(res, 'signedXdr is required')
    if (networkPassphrase !== undefined && networkPassphrase !== cfg.networkPassphrase) return bad(res, 'Network passphrase mismatch')

    // Idempotency is keyed by tx hash: a resubmission of an already-recorded transaction never broadcasts a duplicate row.
    const probeHash = txHashOf(signedXdr, cfg)
    let existing = probeHash ? await s.getActivityByHash(probeHash) : null
    if (existing && existing.vaultId !== v.id) existing = null
    if (existing && existing.status !== 'pending') return res.status(existing.status === 'failed' ? 422 : 200).json({ data: v, activity: existing })

    let operation
    const params = {}
    let claimedMilestone = null
    if (rawOp !== undefined) {
      const normalized = rawOp === 'slash' ? 'slash_on_miss' : rawOp
      if (!['create_vault', 'stake', 'claim_milestone', 'slash_on_miss', 'withdraw'].includes(normalized)) {
        return bad(res, `Unsupported operation ${rawOp}`)
      }
      operation = normalized
      if (operation === 'create_vault' && v.onchainStatus !== 'pending_onchain') return bad(res, 'Vault is already created on-chain', 409)
      if (operation === 'stake' && v.onchainStatus !== 'created') return bad(res, 'Vault must be created on-chain before staking', 409)
      if (operation === 'claim_milestone' || operation === 'slash_on_miss') {
        if (v.onchainStatus !== 'active' || v.status !== 'active') return bad(res, 'Vault must be active on-chain to submit this operation', 409)
      }
    }
  }))

  app.use('/api', router)
  app.use('/', router)
  return app
}
