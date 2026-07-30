import { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import db from '../db/index.js'

// Configurable via env: comma-separated list of actions requiring a second-admin approval
export const DUAL_CONTROL_ACTIONS = new Set(
  (process.env.DUAL_CONTROL_ACTIONS ?? 'user.hard_delete')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

// Valid destructive action scopes — must match what guarded routes advertise
export const VALID_DESTRUCTIVE_ACTIONS = new Set([
  'horizon.cursor.reset',
  'embeddings.force_resync',
  'user.hard_delete',
  'user.soft_delete',
])

const SINGLE_CONTROL_TTL_MS = 5 * 60 * 1000   // 5 min
const DUAL_CONTROL_TTL_MS = 15 * 60 * 1000    // 15 min: gives second admin time to approve

export interface ConfirmationTokenEntry {
  tokenId: string
  userId: string
  action: string
  scope?: string
  expiresAt: number
  used: boolean
  dualControlRequired: boolean
  approvedBy?: string
  approvedAt?: number
  createdAt: number
}

function rowToEntry(row: any): ConfirmationTokenEntry {
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    action: row.action,
    scope: row.scope ?? undefined,
    expiresAt: new Date(row.expires_at).getTime(),
    used: row.used,
    dualControlRequired: row.dual_control_required,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at).getTime() : undefined,
    createdAt: new Date(row.created_at).getTime(),
  }
}

export const clearConfirmationTokens = async (): Promise<void> => {
  await db('confirmation_tokens').delete()
}

export const isDualControlRequired = (action: string): boolean =>
  DUAL_CONTROL_ACTIONS.has(action)

export const issueConfirmationToken = async (
  userId: string,
  action: string,
  scope?: string,
): Promise<ConfirmationTokenEntry> => {
  const dualControlRequired = isDualControlRequired(action)
  const ttlMs = dualControlRequired ? DUAL_CONTROL_TTL_MS : SINGLE_CONTROL_TTL_MS
  const tokenId = randomUUID()
  const expiresAt = new Date(Date.now() + ttlMs)

  await db('confirmation_tokens').insert({
    token_id: tokenId,
    user_id: userId,
    action,
    scope: scope ?? null,
    expires_at: expiresAt.toISOString(),
    used: false,
    dual_control_required: dualControlRequired,
  })

  return {
    tokenId,
    userId,
    action,
    scope,
    expiresAt: expiresAt.getTime(),
    used: false,
    dualControlRequired,
    createdAt: Date.now(),
  }
}

export type ApproveResult =
  | { ok: true; entry: ConfirmationTokenEntry }
  | { ok: false; reason: string }

export const approveConfirmationToken = async (tokenId: string, approverId: string): Promise<ApproveResult> => {
  const row = await db('confirmation_tokens').where({ token_id: tokenId }).first()
  if (!row) return { ok: false, reason: 'token_not_found' }

  const entry = rowToEntry(row)
  if (entry.used) return { ok: false, reason: 'token_already_used' }
  if (entry.expiresAt < Date.now()) return { ok: false, reason: 'token_expired' }
  if (!entry.dualControlRequired) return { ok: false, reason: 'action_does_not_require_approval' }
  if (entry.approvedBy) return { ok: false, reason: 'already_approved' }
  if (entry.userId === approverId) return { ok: false, reason: 'self_approval_not_allowed' }

  const now = new Date()
  await db('confirmation_tokens')
    .where({ token_id: tokenId })
    .update({
      approved_by: approverId,
      approved_at: now.toISOString(),
    })

  entry.approvedBy = approverId
  entry.approvedAt = now.getTime()
  return { ok: true, entry }
}

export const validateConfirmationToken = async (
  tokenId: string,
  userId: string,
  action: string,
): Promise<ConfirmationTokenEntry | null> => {
  const row = await db('confirmation_tokens').where({ token_id: tokenId }).first()
  if (!row) return null

  const entry = rowToEntry(row)
  if (entry.used) return null
  if (entry.expiresAt < Date.now()) return null
  if (entry.userId !== userId) return null
  if (entry.action !== action) return null
  if (entry.dualControlRequired && !entry.approvedBy) return null

  await db('confirmation_tokens')
    .where({ token_id: tokenId })
    .update({ used: true })

  entry.used = true
  return entry
}

export const requireConfirmationToken =
  (actionOrResolver: string | ((req: Request) => string)) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const action =
      typeof actionOrResolver === 'function' ? actionOrResolver(req) : actionOrResolver
    const userId = (req as any).user?.userId
    const tokenId =
      (req.headers['x-confirmation-token'] as string | undefined) ??
      (req.body as any)?.confirmationToken

    if (!userId || !tokenId) {
      res.status(403).json({
        error: 'Confirmation token required for this destructive action',
        confirmationRequired: true,
        action,
        prepareUrl: '/api/admin/confirm/prepare',
      })
      return
    }

    // Await is handled by wrapping the middleware
    validateConfirmationToken(tokenId, userId, action)
      .then((entry) => {
        if (!entry) {
          res.status(403).json({
            error: 'Invalid, expired, wrong-scope, or already-used confirmation token',
            confirmationRequired: true,
            action,
            prepareUrl: '/api/admin/confirm/prepare',
          })
          return
        }

        ;(req as any).confirmationTokenEntry = entry
        next()
      })
      .catch((err) => {
        console.error('Confirmation token validation error:', err)
        res.status(500).json({ error: 'Internal server error during token validation' })
      })
  }
