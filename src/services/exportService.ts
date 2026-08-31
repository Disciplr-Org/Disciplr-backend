import { createHash } from 'crypto';
import type { Knex } from 'knex';
import { enforceExportQuota } from './quotaService';

export type ExportScope = 'self' | 'org' | 'admin';
export type ExportFormat = 'csv' | 'json' | 'xlsx';
export type ExportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  requester_user_id: string;
  requester_is_admin: boolean;
  target_user_id: string | null;
  scope: ExportScope;
  format: ExportFormat;
  status: ExportStatus;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  request_hash: string;
  error: string | null;
  result_data: Buffer | null;
  filename: string | null;
  s3_key: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CreateExportJobParams {
  requesterUserId: string;
  requesterIsAdmin?: boolean;
  targetUserId?: string | null;
  scope: ExportScope;
  format: ExportFormat;
  orgId?: string | null;
  quotaLimit?: number | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  maxAttempts?: number;
}

export class ExportJobError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'ExportJobError';
  }
}

export class ExportJobNotFoundError extends ExportJobError {
  constructor() {
    super('Export job not found', 404);
    this.name = 'ExportJobNotFoundError';
  }
}

export class ExportJobConflictError extends ExportJobError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ExportJobConflictError';
  }
}

function computeRequestHash(data: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function lockIdempotencyKey(
  trx: Knex.Transaction,
  requesterUserId: string,
  idempotencyKey: string,
): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `export_job:${requesterUserId}:${idempotencyKey}`,
  ]);
}

async function transitionJob(
  knex: Knex,
  jobId: string,
  fromStatuses: ExportStatus[],
  toStatus: ExportStatus,
  additionalData: Record<string, unknown> = {},
): Promise<ExportJob> {
  const trx = await knex.transaction();
  try {
    const [job] = await trx('export_jobs')
      .where({ id: jobId })
      .forUpdate()
      .select('*');
    if (!job) {
      throw new ExportJobNotFoundError();
    }
    if (!fromStatuses.includes(job.status)) {
      throw new ExportJobConflictError(
        Cannot transition job from ${job.status} to ${toStatus},
      );
    }

    const updateData = {
      status: toStatus,
      updated_at: trx.fn.now(),
      ...additionalData,
    };

    const [updated] = await trx('export_jobs')
      .where({ id: jobId, status: job.status })
      .update(updateData)
      .returning('*');

    await trx.commit();
    return updated as ExportJob;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

export async function createExportJob(
  knex: Knex,
  params: CreateExportJobParams,
): Promise<ExportJob> {
  const {
    requesterUserId,
    requesterIsAdmin = false,
    targetUserId = null,
    scope,
    format,
    orgId = null,
    quotaLimit = null,
    idempotencyKey = null,
    requestHash = null,
    maxAttempts = 3,
  } = params;

  const effectiveRequestHash =
    requestHash ?? computeRequestHash({
      requesterUserId,
      targetUserId,
      scope,
      format,
    });

  const trx = await knex.transaction();

  try {
    if (idempotencyKey) {
      // Serialize all create attempts for this idempotency key.
      await lockIdempotencyKey(trx, requesterUserId, idempotencyKey);

      const existing = await trx('export_jobs')
        .where({
          requester_user_id: requesterUserId,
          idempotency_key: idempotencyKey,
        })
        .forUpdate()
        .first();

      if (existing) {
        if (existing.status === 'pending' || existing.status === 'processing') {
          await trx.commit();
          return existing as ExportJob;
        }

        if (existing.status === 'completed') {
          await trx.commit();
          return existing as ExportJob;
        }

        if (existing.status === 'failed') {
          if (existing.attempts < existing.max_attempts) {
            const [updated] = await trx('export_jobs')
              .where({ id: existing.id, status: 'failed' })
              .update({
                status: 'pending',
                attempts: existing.attempts + 1,
                error: null,
                updated_at: trx.fn.now(),
              })
              .returning('*');
            await trx.commit();
            return updated as ExportJob;
          }
          throw new ExportJobConflictError(
            'Export job has exhausted retry attempts',
          );
        }

        if (existing.status === 'cancelled') {
          throw new ExportJobConflictError('Export job has been cancelled');
        }
      }
    }

    // Enforce quota before creating a new job.
    if (orgId && quotaLimit !== null) {
      const today = new Date().toISOString().slice(0, 10);
      await enforceExportQuota(trx, orgId, today, quotaLimit);
    }

    const [job] = await trx('export_jobs')
      .insert({
        requester_user_id: requesterUserId,
        requester_is_admin: requesterIsAdmin,
        target_user_id: targetUserId,
        scope,
        format,
        status: 'pending',
        attempts: 0,
        max_attempts: maxAttempts,
        idempotency_key: idempotencyKey,
        request_hash: effectiveRequestHash,
        error: null,
        result_data: null,
        filename: null,
        s3_key: null,
      })
      .returning('*');

    await trx.commit();
    return job as ExportJob;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

export async function getExportJob(
  knex: Knex,
  jobId: string,
  userId: string,
  isAdmin = false,
): Promise<ExportJob> {
  const query = knex('export_jobs').where({ id: jobId }).first();
  if (!isAdmin) {
    query.andWhere({ requester_user_id: userId });
  }
  const job = await query;
  if (!job) {
    throw new ExportJobNotFoundError();
  }
  return job as ExportJob;
}

export async function listExportJobs(
  knex: Knex,
  userId: string,
  isAdmin = false,
  status?: ExportStatus,
  limit = 50,
  offset = 0,
): Promise<{ jobs: ExportJob[]; total: number }> {
  const query = knex('export_jobs');
  if (!isAdmin) {
    query.where({ requester_user_id: userId });
  }
  if (status) {
    query.where({ status });
  }
  const totalQuery = query.clone().count<{ count: string }=[]>('* as count');
  const [{ count }] = await totalQuery;
  const jobs = await query.orderBy('created_at', 'desc').limit(limit).offset(offset);
  return { jobs: jobs as ExportJob[], total: Number(count) };
}

export async function cancelExportJob(
  knex: Knex,
  jobId: string,
  userId: string,
  isAdmin = false,
): Promise<ExportJob> {
  const trx = await knex.transaction();
  try {
    const query = trx('export_jobs').where({ id: jobId }).forUpdate();
    if (!isAdmin) {
      query.andWhere({ requester_user_id: userId });
    }
    const job = await query.first();
    if (!job) {
      throw new ExportJobNotFoundError();
    }
    if (job.status === 'pending' || job.status === 'processing') {
      const [updated] = await trx('export_jobs')
        .where({ id: jobId, status: job.status })
        .update({
          status: 'cancelled',
          updated_at: trx.fn.now(),
        })
        .returning('*');
      await trx.commit();
      return updated as ExportJob;
    }
    throw new ExportJobConflictError(
      Cannot cancel job in state ${job.status},
    );
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

export async function markJobProcessing(
  knex: Knex,
  jobId: string,
): Promise<ExportJob> {
  return transitionJob(knex, jobId, ['pending'], 'processing');
}

export async function completeExportJob(
  knex: Knex,
  jobId: string,
  data: {
    resultData?: Buffer | null;
    filename?: string | null;
    s3Key?: string | null;
  },
): Promise<ExportJob> {
  const updateData: Record<string, unknown> = {
    completed_at: new Date(),
  };
  if ('resultData' in data) updateData.result_data = data.resultData ?? null;
  if ('filename' in data) updateData.filename = data.filename ?? null;
  if ('s3Key' in data) updateData.s3_key = data.s3Key ?? null;
  return transitionJob(knex, jobId, ['processing'], 'completed', updateData);
}

export async function failExportJob(
  knex: Knex,
  jobId: string,
  error: Error | string,
): Promise<ExportJob> {
  const message = typeof error === 'string' ? error : error.message;
  return transitionJob(knex, jobId, ['processing'], 'failed', {
    error: message,
  });
}
