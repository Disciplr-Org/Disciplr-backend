import { db } from '../db/index.js'
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
