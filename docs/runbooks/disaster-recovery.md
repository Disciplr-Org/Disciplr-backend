# Disaster Recovery Runbook

This runbook restores Disciplr-backend after data loss, region loss, object-store
loss, or Horizon ingestion corruption. It assumes the production service uses the
documented PostgreSQL + Knex migration flow, object-reference storage, background
jobs, and Horizon listener checkpointing.

## Recovery Targets

| Component | RPO target | RTO target | Recovery source |
| --- | ---: | ---: | --- |
| PostgreSQL application data | 5 minutes | 60 minutes to read-only API; 4 hours to full writes | Continuous WAL/PITR plus nightly snapshots |
| Horizon listener state | 0 missed events after replay | 6 hours to caught-up listener | `horizon_checkpoints`, Horizon replay, and idempotent `processed_events` |
| Evidence/export objects | 15 minutes | 4 hours | Versioned and replicated object storage referenced by `evidence_references` and `export_jobs` |
| Runtime configuration and secrets | 15 minutes | 2 hours | Sealed secret backup and key-management recovery package |

If any RPO or RTO cannot be met during an incident, record the exception in the
incident log, keep the API read-only, and continue reconciliation before enabling
new writes.

## Backup Cadence And Retention

### PostgreSQL

- Enable continuous WAL archiving for PITR with a maximum five-minute archive lag.
- Take one full snapshot every 24 hours after the lowest-traffic migration window.
- Retain PITR logs for 35 days and monthly snapshots for 12 months.
- Include the migration ledger table `knex_migrations` and every application table
  managed from `db/migrations`.
- Before each production deploy, run `npm run migrate:status` and save the output
  with the deploy record.

### Object Storage

- Enable bucket versioning for evidence and export objects.
- Replicate objects to a second region or account within 15 minutes.
- Retain deleted versions for at least 35 days and compliance snapshots for 90 days.
- Verify that every live `evidence_references.storage_key` and `export_jobs.s3_key`
  resolves to an object without storing raw PII in the database.

### Secrets And Configuration

- Back up `DATABASE_URL`, JWT signing material, Soroban submit credentials,
  Horizon listener configuration, and object-store credentials in sealed secret
  storage.
- Keep the previous field-encryption key or JWT verification key available during
  key rotation so restored records and old tokens can be validated while traffic is
  drained.
- Never store unsealed secrets in this repository, ticket comments, incident notes,
  screenshots, or database snapshots.

## Restore Procedure

1. Declare an incident owner and freeze new writes. Put the API in maintenance or
   read-only mode, stop scheduled workers, and pause the Horizon listener so no new
   jobs or chain events race the restore.
2. Identify the last good restore point. Prefer the newest PostgreSQL PITR target
   before the first corrupt write, then cross-check the nearest object-store
   replication timestamp and the most recent trusted Horizon checkpoint.
3. Restore PostgreSQL into an isolated database using the selected snapshot and WAL
   position. Point `DATABASE_URL` at the isolated database only after the restore is
   complete.
4. Validate schema state:
   - Run `npm run migrate:status`.
   - Run `npm run migrate:latest` only if the restored database is behind the
     current release.
   - Confirm the migration ledger in `knex_migrations` includes the production
     migrations expected from `db/migrations`.
5. Check the core tables before reopening traffic:
   - `vaults`
   - `milestones`
   - `validations`
   - `transactions`
   - `audit_logs`
   - `processed_events`
   - `failed_events`
   - `horizon_checkpoints`
   - `evidence_references`
   - `export_jobs`
6. Restore and validate object storage. Sample recent `evidence_references` rows
   and `export_jobs.s3_key` values, then confirm the referenced objects exist in the
   restored or failover bucket.
7. Restore sealed configuration and secrets. Verify `DATABASE_URL`, `JWT_SECRET`,
   Soroban variables, Horizon variables, and object-store credentials are loaded by
   the runtime without printing secret values to logs.
8. Restart the API in read-only mode and run smoke checks for `/api/health`,
   vault lookup, audit-log lookup, evidence lookup, and export metadata.
9. Resume background workers only after queue health is clean and dead-letter volume
   is understood. Replay dead-letter jobs manually if they represent idempotent
   work that should still happen after the database restore.
10. Resume Horizon ingestion from the last good checkpoint:
    - Read the trusted ledger and paging token from `horizon_checkpoints`.
    - If the table is missing or corrupt, recreate it from the newest verified
      database snapshot, then start from the last confirmed safe ledger minus one
      page of overlap.
    - Use the documented admin checkpoint routes to inspect, reset, or delete
      checkpoints when the restored value is wrong:
      `GET /api/admin/horizon/checkpoints`, `POST /api/admin/horizon/checkpoints`,
      and `DELETE /api/admin/horizon/checkpoints/:contractAddress`.
    - Let the listener replay forward. Duplicate events should no-op through
      `processed_events`; unrecoverable records should land in `failed_events` for
      operator review.
11. Reconcile business state. Compare vault totals, milestone states, transaction
    counts, audit-log continuity, and Horizon processed-event counts against the
    last clean deploy or monitoring snapshot.
12. Re-enable writes only after the incident owner signs off that PostgreSQL,
    object storage, job queues, and Horizon replay are internally consistent.

## Horizon Replay Notes

The listener is designed for at-least-once delivery. Recovery should therefore
favor replay with overlap instead of skipping ledgers. A replay from the last good
`horizon_checkpoints` row is acceptable when `processed_events` is present and
deduplicating event IDs. If the checkpoint is ahead of the restored data, move it
back through the admin checkpoint route before the listener starts.

During replay, monitor:

- lag between the current Horizon ledger and the stored checkpoint,
- growth in `processed_events`,
- new rows in `failed_events`,
- vault and transaction totals affected by replayed contracts,
- unexpected audit-log gaps around the incident window.

## Quarterly Restore Drill Checklist

- [ ] Restore the latest nightly PostgreSQL snapshot into a disposable database.
- [ ] Apply WAL to a randomly selected point inside the last 24 hours.
- [ ] Run `npm run migrate:status` and confirm `knex_migrations` matches the
      expected release.
- [ ] Resolve sampled `evidence_references.storage_key` and `export_jobs.s3_key`
      objects from the replica bucket.
- [ ] Start a disposable API instance against the restored database in read-only
      mode.
- [ ] Set the Horizon listener to replay from a copied `horizon_checkpoints` row
      with one page of overlap.
- [ ] Confirm duplicate events are absorbed by `processed_events`.
- [ ] Confirm replay failures land in `failed_events` and are operationally
      actionable.
- [ ] Document measured RPO/RTO, gaps, and follow-up owners.
- [ ] Destroy disposable infrastructure and verify no restored secrets or snapshots
      remain outside approved storage.

