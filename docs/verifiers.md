# Verifier Registry

Admins manage verifier eligibility through `/api/admin/verifiers`. A `VERIFIER` JWT is not enough to perform verifier actions; the authenticated user must also have an approved registry profile.

## Status Lifecycle

Verifier status values:

- `pending`: registered but not approved to verify work.
- `approved`: active and allowed to verify.
- `suspended`: temporarily blocked from verification.
- `deactivated`: administratively offboarded. Reactivation returns the verifier to `pending` for re-approval.

Allowed transitions:

| From | To |
| --- | --- |
| `pending` | `approved`, `deactivated` |
| `approved` | `suspended`, `deactivated` |
| `suspended` | `approved`, `deactivated` |
| `deactivated` | `pending` |

Invalid transitions return `409 Conflict`. No-op updates do not create audit log entries.

## Admin Endpoints

All endpoints require an admin token.

- `GET /api/admin/verifiers`: list verifier profiles with stats.
- `GET /api/admin/verifiers/:userId`: fetch one verifier profile with stats.
- `POST /api/admin/verifiers`: create a verifier profile.
- `PATCH /api/admin/verifiers/:userId`: update `displayName`, `metadata`, and optionally `status`.
- `DELETE /api/admin/verifiers/:userId`: legacy hard delete, audited as `verifier.deleted`.
- `POST /api/admin/verifiers/:userId/approve`: transition to `approved`.
- `POST /api/admin/verifiers/:userId/suspend`: transition to `suspended`.
- `POST /api/admin/verifiers/:userId/deactivate`: transition to `deactivated`.
- `POST /api/admin/verifiers/:userId/reactivate`: transition from `deactivated` to `pending`.

The legacy `approve` and `suspend` endpoints create a minimal pending profile first when the verifier does not already exist, then apply the requested transition. New clients should prefer explicit creation through `POST /api/admin/verifiers` before lifecycle transitions.

## Audit Logs

Registry changes write queryable audit records with:

- `target_type: "verifier"`
- `target_id`: verifier user ID
- `metadata.before`
- `metadata.after`
- `metadata.changed_fields`

Example:

```json
{
  "action": "verifier.deactivated",
  "target_type": "verifier",
  "target_id": "verifier-user-id",
  "metadata": {
    "before": { "status": "approved" },
    "after": { "status": "deactivated" },
    "changed_fields": ["status"],
    "admin_id": "admin-user-id"
  }
}
```

State-change actions use specific names: `verifier.approved`, `verifier.suspended`, `verifier.deactivated`, and `verifier.reactivated`. Non-status profile edits use `verifier.updated`.

## Verification Decision Transaction Guarantee

`POST /api/verifications` writes two rows atomically:

1. The verification record (`verifications` table via `recordVerification`).
2. The audit log entry (`audit_logs` table via `createAuditLog`).

Both writes are wrapped in a single **Knex transaction** (`db.transaction`). If either write fails the entire transaction is rolled back, so it is impossible to have a verification row without a corresponding audit trail, or vice-versa.

`createEvidenceReference` (Prisma `$queryRaw`) runs **after** the Knex transaction commits because Prisma uses a separate connection pool and cannot join a Knex transaction. It is safe to call after commit because it is idempotent (`ON CONFLICT (verification_id) DO UPDATE`).

The transaction call is wrapped in `retryWithBackoff` with a serialization-error predicate so transient PostgreSQL serialization failures (`could not serialize`, `deadlock`) are automatically retried with exponential back-off.

Both `recordVerification` and `createAuditLog` accept an optional `trx?: Knex.Transaction` parameter; when provided they use the transaction client instead of the global pool.

## Anti-Spoofing Rule

Verifier workflow routes chain `authenticate`, `requireVerifier`, and `requireActiveVerifier`. `requireActiveVerifier` loads the registry profile for `req.user.userId`, requires `status === "approved"`, and attaches the profile to `req.verifier`.

Clients cannot approve themselves by sending a `userId` in the request body or path; registry changes are admin-only and verification actions use the authenticated JWT subject.
