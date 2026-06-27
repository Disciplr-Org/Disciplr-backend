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
- Object-storage paths are rejected when they contain leading empty segments, `.` or `..` path traversal segments, backslashes, null bytes, or line breaks. Percent-encoded variants such as `%2e%2e` and `%00` are decoded before validation.
- Signed URL response content-type overrides, when present, must use the storage allowlist. Unsafe browser-executable types such as `text/html` and JavaScript content types are rejected.
- URL expiry is validated by parsing one of:
  - `X-Amz-Expires` with `X-Amz-Date`
  - `Expires`
  - `expires`
- Expired URLs are rejected.

## Export object keys

S3 export uploads use tenant-scoped keys in the form `exports/<requesting-user-id>/<job-id>/<filename>`.
Each path segment is validated before upload or pre-signing so a caller cannot overwrite a sibling tenant's object with `../`, leading slash, absolute filesystem path, encoded traversal, or null-byte input.
Export uploads also enforce a content-type allowlist for CSV, JSON, NDJSON, gzip, PDF/image/text evidence-style objects. HTML, opaque binary, and executable/script MIME types are intentionally excluded.

## Persistence

A new `evidence_references` table stores evidence metadata.
This table is created by the new database migration `db/migrations/20260527000000_create_evidence_references.cjs`.

## Audit logging

Audit logs do not include the raw signed URL.
Only evidence metadata such as `evidenceHash` and the fact that evidence was attached are recorded.
