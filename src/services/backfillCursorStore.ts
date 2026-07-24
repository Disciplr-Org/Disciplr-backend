import { Knex } from 'knex'

export interface BackfillCursor {
  jobName: string
  cursor: string | null
  updatedAt: Date
  createdAt: Date
}

export interface BackfillProgress {
  jobName: string
  cursor: string | null
  processed: number
  paused: boolean
  /** Throughput samples: [timestampMs, processed] pairs for ETA calculation */
  samples: Array<[number, number]>
  updatedAt: Date
  createdAt: Date
}

export interface BackfillProgressSnapshot {
  jobName: string
  cursor: string | null
  processed: number
  paused: boolean
  etaMs: number | null
  updatedAt: string
}

/** Maximum throughput samples retained per job */
const MAX_SAMPLES = 10

/**
 * Estimate milliseconds to completion given throughput samples and a total item count.
 * Returns null when total is unknown or there is insufficient data.
 */
function estimateEtaMs(
  samples: Array<[number, number]>,
  processed: number,
  total: number | null,
): number | null {
  if (total === null || total <= processed || samples.length < 2) return null
  const oldest = samples[0]
  const newest = samples[samples.length - 1]
  const elapsed = newest[0] - oldest[0]
  const delta = newest[1] - oldest[1]
  if (delta <= 0 || elapsed <= 0) return null
  const ratePerMs = delta / elapsed
  return Math.ceil((total - processed) / ratePerMs)
}

/**
 * BackfillCursorStore
 *
 * Generic persisted-cursor table for resumable batch backfill jobs. Each job
 * is identified by a stable `jobName` and advances a single opaque string
 * cursor (e.g. the last processed primary key) so a crashed or restarted
 * process resumes from where it left off.
 *
 * Extended with:
 * - pause/resume flags so operators can halt a running backfill and continue
 *   from the saved cursor without reprocessing already-done ranges.
 * - processed count and throughput samples for progress/ETA reporting.
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
      .insert({ job_name: jobName, cursor, updated_at: now, created_at: now })
      .onConflict('job_name')
      .merge({ cursor, updated_at: now })
  }

  /** Returns true when the job has been paused by an operator. */
  async isPaused(jobName: string): Promise<boolean> {
    const row = await this.db('backfill_cursors').where({ job_name: jobName }).first()
    return row ? Boolean(row.paused) : false
  }

  async pause(jobName: string): Promise<void> {
    const now = new Date()
    await this.db('backfill_cursors')
      .insert({ job_name: jobName, cursor: null, paused: true, updated_at: now, created_at: now })
      .onConflict('job_name')
      .merge({ paused: true, updated_at: now })
  }

  async resume(jobName: string): Promise<void> {
    const now = new Date()
    await this.db('backfill_cursors')
      .insert({ job_name: jobName, cursor: null, paused: false, updated_at: now, created_at: now })
      .onConflict('job_name')
      .merge({ paused: false, updated_at: now })
  }

  /**
   * Record that `count` items were processed and append a throughput sample.
   * Retains at most MAX_SAMPLES entries (FIFO).
   */
  async recordProgress(jobName: string, count: number): Promise<void> {
    const now = new Date()
    const row = await this.db('backfill_cursors').where({ job_name: jobName }).first()

    let processed = count
    let samples: Array<[number, number]> = [[now.getTime(), count]]

    if (row) {
      const prev: number = Number(row.processed ?? 0)
      processed = prev + count
      const prevSamples: Array<[number, number]> = row.samples ? JSON.parse(row.samples as string) : []
      samples = [...prevSamples, [now.getTime(), processed]].slice(-MAX_SAMPLES)
    }

    await this.db('backfill_cursors')
      .insert({
        job_name: jobName,
        cursor: null,
        processed,
        samples: JSON.stringify(samples),
        updated_at: now,
        created_at: now,
      })
      .onConflict('job_name')
      .merge({ processed, samples: JSON.stringify(samples), updated_at: now })
  }

  /**
   * List all known backfill jobs with their progress snapshot.
   * `total` is optional — when supplied, an ETA is estimated from throughput.
   */
  async listProgress(totals?: Record<string, number>): Promise<BackfillProgressSnapshot[]> {
    const rows = await this.db('backfill_cursors').select('*').orderBy('job_name')
    return rows.map((row) => {
      const samples: Array<[number, number]> = row.samples ? JSON.parse(row.samples as string) : []
      const processed = Number(row.processed ?? 0)
      const total = totals?.[row.job_name as string] ?? null
      return {
        jobName: row.job_name as string,
        cursor: row.cursor as string | null,
        processed,
        paused: Boolean(row.paused),
        etaMs: estimateEtaMs(samples, processed, total),
        updatedAt: new Date(row.updated_at as string).toISOString(),
      }
    })
  }

  /**
   * Operator tool: restart a backfill job from the beginning.
   */
  async resetCursor(jobName: string): Promise<void> {
    await this.db('backfill_cursors').where({ job_name: jobName }).delete()
  }
}
