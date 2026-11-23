# Disaster Recovery Runbook

This runbook defines how Disciplr-backend recovers from a database loss, object-store outage, or partial platform failure while preserving evidence and audit continuity. It also states the recovery objectives that operators should use when deciding whether a restore is acceptable.

## Recovery objectives

The operational target for this service is:

- RPO: 15 minutes
- RTO: 4 hours

These values assume PostgreSQL point-in-time recovery (PITR) is enabled for production, S3 versioning is enabled for evidence and export objects, and the restore process is rehearsed quarterly.

## Backup strategy

### PostgreSQL

1. Take daily physical snapshots of the production database volume or managed snapshot service.
2. Enable PITR so the database can be restored to any point in the last 7 days.
3. Run a weekly full logical export of the application schema and core business data for offline verification.
4. Retain PITR archives for 30 days and snapshots for 90 days.

### S3 evidence and exports

1. Enable versioning on the evidence bucket and export bucket.
2. Apply lifecycle policies that preserve current versions for 90 days and delete expired versions after 365 days.
3. Validate object integrity with checksums or ETags after each backup window.

### Secrets and keys

Back up the following material in a dedicated secrets manager or an encrypted offline vault:

- field-encryption key used by the application
- JWT signing keys
- database credentials used by the restore environment
- any cloud credentials required to restore S3 objects

## Restore procedure

1. Declare the incident and freeze writes to the damaged environment.
2. Verify the backup chain:
   - confirm the latest PostgreSQL snapshot or PITR window is intact
   - confirm the required S3 versions exist
   - confirm the encryption and JWT keys are available
3. Provision a replacement PostgreSQL instance with the same major version and extensions as production.
4. Restore the database from the latest valid snapshot or PITR point.
5. Restore the application schema and data with the current migration tooling:
   - `knex migrate:latest --knexfile knexfile.cjs`
   - `knex migrate:status --knexfile knexfile.cjs`
6. Rehydrate object storage from the latest S3 versions for evidence, exports, and any other immutable artifacts.
7. Restore the secrets and keys into the replacement environment before bringing the service online.
8. Recreate the application configuration, including environment variables and network access rules.
9. Start the backend and confirm health endpoints and queue health before accepting traffic.
10. Replay Horizon events from the last good checkpoint stored in `horizon_checkpoints` to close any gap introduced by the restore.
11. Validate the restored system by checking vaults, milestones, audit logs, and analytics against the last known-good snapshot.
12. Re-enable traffic only after the validation checklist passes.

## Horizon replay guidance

When a restore does not include the most recent ledger activity, replay the event stream from the last good checkpoint in the `horizon_checkpoints` table. If the application uses a checkpoint reset flow, confirm the checkpoint is set to the last verified ledger before replaying events.

## Quarterly restore drill checklist

- [ ] Confirm the backup window completed successfully.
- [ ] Validate the latest PostgreSQL snapshot and PITR window.
- [ ] Validate the latest S3 object versions.
- [ ] Confirm the encryption and JWT keys are accessible.
- [ ] Perform a restore in a non-production environment.
- [ ] Verify the application can replay Horizon events from the last good checkpoint.
- [ ] Record the actual RTO and confirm it remains within the target.
- [ ] Update the runbook with any gaps discovered during the drill.

## Operational notes

- Keep restore credentials in a separate secure location from the production environment.
- Prefer restoring to a fresh environment rather than patching the damaged system in place.
- Document every restore action with timestamps, operator names, and evidence of successful validation.
