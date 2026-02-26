/**
 * routes/verificationRouter.ts
 *
 * REST endpoints for manual milestone verification.
 *
 * Base path: /verification/:vaultId/:milestoneIndex
 *
 * Endpoints:
 *   POST   /approve          – approve a milestone
 *   POST   /reject           – reject a milestone
 *   POST   /request-info     – request additional information
 *   GET    /history          – full audit trail for this milestone
 *   GET    /verifiers        – list active assigned verifiers
 *
 * Auth: API key with role 'verify:milestones'.
 * The verifierAddress is read from req.verifier (set by authenticateApiKey
 * middleware) so it cannot be spoofed via the request body.
 */

import { Router, Request, Response, NextFunction } from 'express'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { verificationService, VerificationError } from '../services/verificationService.js'
import { requireUserAuth } from '../middleware/userAuth.js'

export const verificationRouter = Router({ mergeParams: true })
verificationRouter.use(requireUserAuth)

// ── Error handler ─────────────────────────────────────────────────────────────

function handleError(err: unknown, res: Response): void {
  if (err instanceof VerificationError) {
    const statusMap: Record<VerificationError['code'], number> = {
      NOT_AUTHORIZED: 403,
      INVALID_STATUS_TRANSITION: 409,
      MILESTONE_NOT_FOUND: 404,
      OPEN_INFO_REQUEST: 409,
    }
    res.status(statusMap[err.code]).json({ error: err.message, code: err.code })
    return
  }
  console.error('[verificationRouter]', err)
  res.status(500).json({ error: 'Internal server error' })
}

// ── Middleware: parse + validate route params ─────────────────────────────────

function parseParams(req: Request, res: Response, next: NextFunction): void {
  const milestoneIndex = parseInt(req.params.milestoneIndex, 10)
  if (isNaN(milestoneIndex) || milestoneIndex < 0) {
    res.status(400).json({ error: 'milestoneIndex must be a non-negative integer' })
    return
  }
  // Attach parsed index for downstream handlers
  ;(req as Request & { milestoneIndex: number }).milestoneIndex = milestoneIndex
  next()
}

// ── POST /approve ─────────────────────────────────────────────────────────────

verificationRouter.post(
  '/approve',
  authenticateApiKey(['verify:milestones']),
  parseParams,
  async (req: Request, res: Response) => {
    const userId = req.authUser!.userId
    // todo: query verifier address from DB using userId
    try {
      const result = await verificationService.approveMilestone({
        verifierAddress: "",
        vaultId: req.params.vaultId,
        milestoneIndex: parseInt(req.params.milestoneIndex, 10),
        notes: req.body?.notes,
      })
      res.status(200).json(result)
    } catch (err) {
      handleError(err, res)
    }
  },
)

// ── POST /reject ──────────────────────────────────────────────────────────────

verificationRouter.post(
  '/reject',
  authenticateApiKey(['verify:milestones']),
  parseParams,
  async (req: Request, res: Response) => {
    if (!req.body?.notes || typeof req.body.notes !== 'string' || !req.body.notes.trim()) {
      res.status(400).json({ error: '`notes` is required when rejecting a milestone.' })
      return
    }

    const userId = req.authUser!.userId
    // todo: query verifier address from DB using userId

    try {
      const result = await verificationService.rejectMilestone({
        verifierAddress: "",
        vaultId: req.params.vaultId,
        milestoneIndex: parseInt(req.params.milestoneIndex, 10),
        notes: req.body.notes,
      })
      res.status(200).json(result)
    } catch (err) {
      handleError(err, res)
    }
  },
)

// ── POST /request-info ────────────────────────────────────────────────────────

verificationRouter.post(
  '/request-info',
  authenticateApiKey(['verify:milestones']),
  parseParams,
  async (req: Request, res: Response) => {
    const { question, respondingParty } = req.body ?? {}

    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: '`question` is required.' })
      return
    }
    if (!respondingParty || typeof respondingParty !== 'string' || !respondingParty.trim()) {
      res.status(400).json({ error: '`respondingParty` address is required.' })
      return
    }

    const userId = req.authUser!.userId
    // todo: query verifier address from DB using userId

    try {
      const result = await verificationService.requestMoreInfo({
        verifierAddress: "",
        vaultId: req.params.vaultId,
        milestoneIndex: parseInt(req.params.milestoneIndex, 10),
        question,
        respondingParty,
      })
      res.status(200).json(result)
    } catch (err) {
      handleError(err, res)
    }
  },
)

// ── GET /history ──────────────────────────────────────────────────────────────

verificationRouter.get(
  '/history',
  authenticateApiKey(['read:vaults']),
  parseParams,
  async (req: Request, res: Response) => {
    try {
      const history = await verificationService.getVerificationHistory(
        req.params.vaultId,
        parseInt(req.params.milestoneIndex, 10),
      )
      res.json({ vaultId: req.params.vaultId, milestoneIndex: req.params.milestoneIndex, history })
    } catch (err) {
      handleError(err, res)
    }
  },
)

// ── GET /verifiers ────────────────────────────────────────────────────────────

verificationRouter.get(
  '/verifiers',
  authenticateApiKey(['read:vaults']),
  parseParams,
  async (req: Request, res: Response) => {
    try {
      const verifiers = await verificationService.getAssignedVerifiers(
        req.params.vaultId,
        parseInt(req.params.milestoneIndex, 10),
      )
      res.json({ vaultId: req.params.vaultId, milestoneIndex: req.params.milestoneIndex, verifiers })
    } catch (err) {
      handleError(err, res)
    }
  },
)