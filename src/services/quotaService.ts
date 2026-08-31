import type { Knex } from 'knex';

export class QuotaExceededError extends Error {
  constructor(
    public orgId: string,
    public quotaDate: string,
    public limit: number,
  ) {
    super(`Export quota exceeded for org ${orgId} on ${quotaDate} (limit: ${limit})`);
    this.name = 'QuotaExceededError';
  }
}

/**
 * Atomically increments the export count for the given org/date/metric.
 * Throws QuotaExceededError if the count would exceed the limit.
 */
export async function enforceExportQuota(
  trx: Knex.Transaction,
  orgId: string,
  quotaDate: string,
  limit: number,
): Promise<void> {
  if (limit <= 0) {
    throw new QuotaExceededError(orgId, quotaDate, limit);
  }

  // Serialize quota increments for the same org/date/metric.
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `${orgId}:${quotaDate}:exports`,
  ]);

  const existing = await trx('org_quotas')
    .where({
      org_id: orgId,
      quota_date: quotaDate,
      metric: 'exports',
    })
    .forUpdate()
    .first();

  if (existing) {
    if (existing.count >= limit) {
      throw new QuotaExceededError(orgId, quotaDate, limit);
    }
    await trx('org_quotas')
      .where({ org_id: orgId, quota_date: quotaDate, metric: 'exports' })
      .update({
        count: existing.count + 1,
        updated_at: trx.fn.now(),
      });
  } else {
    await trx('org_quotas').insert({
      org_id: orgId,
      quota_date: quotaDate,
      metric: 'exports',
      count: 1,
      limit:
    });
  }
}
