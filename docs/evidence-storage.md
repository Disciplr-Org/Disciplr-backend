# Evidence Storage Contract

This service stores signed object-storage references for verification evidence without persisting raw PII or document contents.

## What is stored

- `verification_id` — links the reference to the recorded verification decision.
- `evidence_hash` — integrity checksum for the submitted evidence payload.
- `reference_url` — signed object-storage URL (e.g. S3-compatible signed URL).
- `expires_at` — expiry timestamp extracted from the signed URL.
- `created_at` — insertion timestamp.

## What is not stored

- Raw evidence files.
- User-uploaded document contents.
- Sensitive personal data from the payload.

## Ingestion rules

- `POST /api/verifications` now accepts `evidenceHash` and `evidenceReferenceUrl`.
- `evidenceHash` must be a non-empty alphanumeric-hyphen-underscore string between 32 and 128 characters.
- `evidenceReferenceUrl` must be an HTTP/HTTPS signed object-storage URL.
- URL expiry is validated by parsing one of:
  - `X-Amz-Expires` with `X-Amz-Date`
  - `Expires`
  - `expires`
- Expired URLs are rejected.

## Persistence

A new `evidence_references` table stores evidence metadata.
This table is created by the new database migration `db/migrations/20260527000000_create_evidence_references.cjs`.

## Audit logging

Audit logs do not include the raw signed URL.
Only evidence metadata such as `evidenceHash` and the fact that evidence was attached are recorded.
