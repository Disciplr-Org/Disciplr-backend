import { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

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

// In-memory store — same pattern as STEP_UP_NONCES in auth.service.ts
const CONFIRMATION_TOKENS = new Map<string, ConfirmationTokenEntry>()

// Test helper — mirrors clearProcessedOverrides from admin.ts
export const clearConfirmationTokens = (): void => {
  CONFIRMATION_TOKENS.clear()
}

export const isDualControlRequired = (action: string): boolean =>
  DUAL_CONTROL_ACTIONS.has(action)

export const issueConfirmationToken = (
  userId: string,
  action: string,
  scope?: string,
): ConfirmationTokenEntry => {
  const dualControlRequired = isDualControlRequired(action)
  const ttlMs = dualControlRequired ? DUAL_CONTROL_TTL_MS : SINGLE_CONTROL_TTL_MS
  const entry: ConfirmationTokenEntry = {
    tokenId: randomUUID(),
    userId,
    action,
    scope,
    expiresAt: Date.now() + ttlMs,
    used: false,
    dualControlRequired,
    createdAt: Date.now(),
  }
  CONFIRMATION_TOKENS.set(entry.tokenId, entry)
  return entry
}

export type ApproveResult =
  | { ok: true; entry: ConfirmationTokenEntry }
  | { ok: false; reason: string }

export const approveConfirmationToken = (tokenId: string, approverId: string): ApproveResult => {
  const entry = CONFIRMATION_TOKENS.get(tokenId)
  if (!entry) return { ok: false, reason: 'token_not_found' }
  if (entry.used) return { ok: false, reason: 'token_already_used' }
  if (entry.expiresAt < Date.now()) return { ok: false, reason: 'token_expired' }
  if (!entry.dualControlRequired) return { ok: false, reason: 'action_does_not_require_approval' }
  if (entry.approvedBy) return { ok: false, reason: 'already_approved' }
  // Self-approval is prohibited — the approver must be a different admin
  if (entry.userId === approverId) return { ok: false, reason: 'self_approval_not_allowed' }
  entry.approvedBy = approverId
  entry.approvedAt = Date.now()
  return { ok: true, entry }
}

export const validateConfirmationToken = (
  tokenId: string,
  userId: string,
  action: string,
): ConfirmationTokenEntry | null => {
  const entry = CONFIRMATION_TOKENS.get(tokenId)
  if (!entry) return null
  if (entry.used) return null
  if (entry.expiresAt < Date.now()) return null
  if (entry.userId !== userId) return null
  if (entry.action !== action) return null
  // Dual-control tokens must be approved before use
  if (entry.dualControlRequired && !entry.approvedBy) return null
  entry.used = true
  CONFIRMATION_TOKENS.delete(tokenId)
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

    const entry = validateConfirmationToken(tokenId, userId, action)
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
  }
