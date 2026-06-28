import { Knex } from 'knex'

export interface BackfillCursor {
  jobName: string
  cursor: string | null
  updatedAt: Date
  createdAt: Date
}

/**
 * BackfillCursorStore
 *
 * Generic persisted-cursor table for resumable batch backfill jobs, modelled
 * on CheckpointStore (see src/services/checkpointStore.ts). Each job is
 * identified by a stable `jobName` and advances a single opaque string
 * cursor (e.g. the last processed primary key) so a crashed or restarted
 * process resumes from where it left off instead of starting over.
 */
export class BackfillCursorStore {
  constructor(private readonly db: Knex) {}

  async getCursor(jobName: string): Promise<string | null> {
    const row = await this.db('backfill_cursors').where({ job_name: jobName }).first()
    return row ? (row.cursor as string | null) : null
  }

  async upsertCursor(jobName: string, cursor: string | null): Promise<void> {
    const now = new Date()

    await this.db('backfill_cursors')
      .insert({
        job_name: jobName,
        cursor,
        updated_at: now,
        created_at: now,
      })
      .onConflict('job_name')
      .merge({
        cursor,
        updated_at: now,
      })
  }

  /**
   * Operator tool: restart a backfill job from the beginning.
   */
  async resetCursor(jobName: string): Promise<void> {
    await this.db('backfill_cursors').where({ job_name: jobName }).delete()
  }
}
