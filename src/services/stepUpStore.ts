import db from '../db/index.js'

export interface StepUpNonce {
  nonce: string
  userId: string
  expiresAt: Date
}

export interface StepUpConsumeOptions {
  userId?: string
  now?: Date
  maxRemainingAgeMs?: number
}

export interface StepUpStore {
  issue(nonce: string, userId: string, expiresAt: Date): Promise<void>
  consume(nonce: string, options?: StepUpConsumeOptions): Promise<StepUpNonce | null>
  deleteExpired(batchSize?: number, now?: Date): Promise<number>
}

interface StepUpNonceRow {
  nonce: string
  user_id: string
  expires_at: Date | string
}

export class PostgresStepUpStore implements StepUpStore {
  async issue(nonce: string, userId: string, expiresAt: Date): Promise<void> {
    await db('step_up_nonces').insert({
      nonce,
      user_id: userId,
      expires_at: expiresAt,
    })
  }

  async consume(nonce: string, options: StepUpConsumeOptions = {}): Promise<StepUpNonce | null> {
    const now = options.now ?? new Date()
    const query = db('step_up_nonces')
      .where({ nonce })
      .where('expires_at', '>', now)

    if (options.userId !== undefined) {
      query.where({ user_id: options.userId })
    }

    if (options.maxRemainingAgeMs !== undefined) {
      query.where(
        'expires_at',
        '<=',
        new Date(now.getTime() + options.maxRemainingAgeMs),
      )
    }

    const deleted = await query.delete().returning(['nonce', 'user_id', 'expires_at']) as StepUpNonceRow[]
    const row = deleted[0]
    if (!row) {
      return null
    }

    return {
      nonce: row.nonce,
      userId: row.user_id,
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    }
  }

  async deleteExpired(batchSize = 1000, now = new Date()): Promise<number> {
    const expiredNonces = db('step_up_nonces')
      .select('nonce')
      .where('expires_at', '<=', now)
      .limit(batchSize)

    return db('step_up_nonces').whereIn('nonce', expiredNonces).delete()
  }
}

export class InMemoryStepUpStore implements StepUpStore {
  private readonly nonces = new Map<string, StepUpNonce>()

  async issue(nonce: string, userId: string, expiresAt: Date): Promise<void> {
    this.nonces.set(nonce, { nonce, userId, expiresAt: new Date(expiresAt) })
  }

  async consume(nonce: string, options: StepUpConsumeOptions = {}): Promise<StepUpNonce | null> {
    const entry = this.nonces.get(nonce)
    const now = options.now ?? new Date()

    if (
      !entry ||
      entry.expiresAt <= now ||
      (options.userId !== undefined && entry.userId !== options.userId) ||
      (options.maxRemainingAgeMs !== undefined &&
        entry.expiresAt.getTime() > now.getTime() + options.maxRemainingAgeMs)
    ) {
      return null
    }

    this.nonces.delete(nonce)
    return { ...entry, expiresAt: new Date(entry.expiresAt) }
  }

  async deleteExpired(batchSize = 1000, now = new Date()): Promise<number> {
    let deleted = 0
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt <= now) {
        this.nonces.delete(nonce)
        deleted += 1
        if (deleted >= batchSize) {
          break
        }
      }
    }
    return deleted
  }
}

let stepUpStore: StepUpStore = new PostgresStepUpStore()

export const getStepUpStore = (): StepUpStore => stepUpStore

export const setStepUpStore = (store: StepUpStore): void => {
  stepUpStore = store
}

export const cleanupExpiredStepUpNonces = (batchSize = 1000): Promise<number> =>
  stepUpStore.deleteExpired(batchSize)
