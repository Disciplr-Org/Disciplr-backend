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

## Logging Policy

### Anonymization

- IP addresses in logs are masked (e.g., `192.168.x.x`).
- Request bodies containing PII are filtered before logging in production environments.

### Retention

- Application logs are retained for 30 days.
- Security-critical logs (audit logs) are retained for 1 year.
- After the retention period, logs are automatically purged.
