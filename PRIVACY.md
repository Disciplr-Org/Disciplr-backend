# Privacy and Data Handling (Disciplr Backend)

This document outlines how Disciplr handles user-identifiable data (PII) and the policies in place to ensure privacy compliance.

## User-Identifiable Fields (PII Audit)

The following fields are considered user-identifiable or sensitive:

| Field Name           | Description                                     | Purpose                             | Retention Policy       |
| -------------------- | ----------------------------------------------- | ----------------------------------- | ---------------------- |
| `creator`            | User identifier (e.g., wallet address, auth ID) | identifies the owner of a vault     | Until account deletion |
| `successDestination` | Destination identifier                          | Used to route funds/data on success | Until account deletion |
| `failureDestination` | Destination identifier                          | Used to route funds/data on failure | Until account deletion |

## Data Access and Portability (Right to Access)

Users have the right to export their data. This is supported via the following API:

- `GET /api/privacy/export?creator=<USER_ID>`

## Data Erasure (Right to be Forgotten)

Users have the right to delete their personal data. This is supported via the following API:

- `DELETE /api/privacy/account?creator=<USER_ID>`

_Note: Deletion will permanently remove all vaults associated with the creator from the active system._

## Abuse Protection

Both privacy endpoints are protected by the following layers:

### Rate Limiting
A **strict rate limiter** (10 requests per hour) is applied to both `GET /api/privacy/export` and `DELETE /api/privacy/account`. The limiter uses the `strictRateLimiter` tier from `src/middleware/rateLimiter.ts` and returns HTTP 429 when exceeded.

### Ownership Enforcement
- **Export**: Only the owning user (whose `userId` matches the `creator` query parameter) or an admin can export data.
- **Erasure**: Only the owning user or an admin can delete account data. On successful deletion, an audit log is written via `src/lib/audit-logs.ts` with action `privacy.account_erasure`.

### Enumeration Resistance
Both endpoints return the same generic 404 response (`{ error: { code: 'NOT_FOUND', message: 'Creator not found' } }`) for:
- Non-owned creators
- Non-existent creators
This prevents attackers from distinguishing between existing and non-existing accounts.

### Abuse Monitoring
Suspicious patterns (repeated creator enumeration across both endpoints) are tracked via the `AbuseMonitor` class from `src/services/abuse-monitor.ts`. Enumeration attempts are recorded with an `enumeration` category type. The accumulated data is surfaced through `GET /api/health/security` and `GET /api/admin/abuse/category-counts`.

## Logging Policy

### Anonymization

- IP addresses in logs are masked (e.g., `192.168.x.x`).
- Request bodies containing PII are filtered before logging in production environments.
- Export queue DLQ records, metrics-style events, and structured logs must not store raw `userId`, `targetUserId`, Stellar addresses, emails, `creator`, `successDestination`, or `failureDestination`; those values are replaced with deterministic SHA-256 tokens before storage or emission.

### Retention

- Application logs are retained for 30 days.
- Security-critical logs (audit logs) are retained for 1 year.
- After the retention period, logs are automatically purged.
