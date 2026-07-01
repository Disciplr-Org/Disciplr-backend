import db from '../db/index.js'
import { randomUUID } from 'node:crypto'

export interface SessionRecord {
  id: string
  user_id: string
  jti: string
  revoked_at: string | null
  expires_at: string
  created_at: string
}

export const recordSession = async (userId: string, jti: string, expiresAt: Date): Promise<void> => {
  await db('sessions').insert({
    user_id: userId,
    jti,
    expires_at: expiresAt.toISOString(),
  })
}

export const validateSession = async (jti: string): Promise<boolean> => {
  const session = await db('sessions')
    .where({ jti })
    .whereNull('revoked_at')
    .andWhere('expires_at', '>', new Date().toISOString())
    .first()

  return !!session
}

export const revokeSession = async (jti: string): Promise<void> => {
  await db('sessions')
    .where({ jti })
    .update({ revoked_at: new Date().toISOString() })
}

export const revokeAllUserSessions = async (userId: string): Promise<void> => {
  await db('sessions')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date().toISOString() })
}

export const forceRevokeUserSessions = async (userId: string): Promise<void> => {
  // Same as revokeAllUserSessions, but named for admin clarity
  await revokeAllUserSessions(userId)
}

/**
 * Session fixation defense: revoke the pre-auth session JTI (if any) and
 * return a brand-new JTI. The caller should embed the returned JTI in the
 * access token issued after successful authentication.
 *
 * If `oldJti` is provided and exists, it is revoked so a captured pre-auth
 * token cannot be used post-login.
 */
export const rotateSession = async (
  userId: string,
  oldJti: string | null,
  expiresAt: Date,
): Promise<string> => {
  const newJti = randomUUID()

  if (oldJti) {
    await db('sessions')
      .where({ jti: oldJti })
      .update({ revoked_at: new Date().toISOString() })
  }

  await db('sessions').insert({
    user_id: userId,
    jti: newJti,
    expires_at: expiresAt.toISOString(),
  })

  return newJti
}

/**
 * Enforce a maximum number of concurrent active sessions per user.
 * When the active session count exceeds `maxSessions`, the oldest sessions
 * (by `created_at`) are revoked until the count is within the cap.
 *
 * This prevents session accumulation and limits damage from stolen tokens.
 */
export const enforceSessionLimit = async (
  userId: string,
  maxSessions: number,
  knex: typeof db = db,
): Promise<number> => {
  const activeSessions: SessionRecord[] = await knex('sessions')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .andWhere('expires_at', '>', new Date().toISOString())
    .orderBy('created_at', 'asc')

  const excess = activeSessions.length - maxSessions
  if (excess <= 0) return 0

  const toRevoke = activeSessions.slice(0, excess)
  const jtisToRevoke = toRevoke.map((s) => s.jti)

  await knex('sessions')
    .whereIn('jti', jtisToRevoke)
    .update({ revoked_at: new Date().toISOString() })

  return excess
}

/**
 * Delete expired sessions older than 30 days in batches.
 * Returns the total number of rows deleted.
 * Accepts an optional knex instance for testing.
 */
export const cleanupExpiredSessions = async (
  batchSize = 1000,
  knex: typeof db = db,
): Promise<number> => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  let total = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const deleted: number = await knex('sessions')
      .whereRaw('expires_at < ?', [cutoff])
      .andWhereRaw('id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ?)', [cutoff, batchSize])
      .delete()

    total += deleted
    if (deleted < batchSize) break
  }

  return total
}
