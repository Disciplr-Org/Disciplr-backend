# Evidence and Export Object Storage

This document describes the security rules applied to S3 object-key construction
and content-type validation for evidence references and export uploads.

---

## S3 Object-Key Rules

All object keys are tenant-prefixed to ensure cross-tenant isolation:

```
exports/<job-id>/<filename>
```

### Key Segment Sanitisation

Every user-influenced path segment (job ID, filename) is passed through
`sanitizeS3KeySegment` before the key is assembled. The function enforces:

| Rule | Effect |
|------|--------|
| Null bytes (`\0`) | **Rejected** — throws `S3KeyTraversalError` |
| `..` in any slash-delimited component | **Rejected** — throws `S3KeyTraversalError` |
| Single `.` in any slash-delimited component | **Rejected** — throws `S3KeyTraversalError` |
| Leading `/` or `//…` | **Stripped** — cannot escape the tenant prefix |
| Embedded `/` sequences | **Collapsed to `-`** — segment stays within a single path component |

Because the tenant prefix (`exports/`) is prepended _after_ sanitisation,
no caller-supplied value can navigate above or outside the intended prefix.

### Why this matters

Without sanitisation, a segment such as `../../other-org/secrets.csv` would
produce the key `exports/../../other-org/secrets.csv`, which many S3-compatible
stores normalise to `other-org/secrets.csv`, overwriting another tenant's
object.

---

## Content-Type Allowlist

`uploadToS3` calls `assertAllowedContentType` before sending the upload. Any
content type not in `ALLOWED_CONTENT_TYPES` causes an `S3ContentTypeError` and
the upload is aborted.

### Permitted content types

| MIME type | Use |
|-----------|-----|
| `text/csv` | Export CSV downloads |
| `text/csv; charset=utf-8` | Export CSV downloads |
| `application/json` | Export JSON downloads |
| `application/json; charset=utf-8` | Export JSON downloads |
| `application/x-ndjson` | Export NDJSON downloads |
| `application/pdf` | Evidence attachments |
| `image/png` | Evidence screenshots |
| `image/jpeg` | Evidence screenshots |
| `image/webp` | Evidence screenshots |

### Rejected categories

- `text/html` — served directly, creates XSS vectors
- `application/javascript` / `text/javascript` — active content
- `application/octet-stream` — generic binary, potential executable
- `text/xml` / `application/xml` — XXE vectors
- Any type not explicitly listed above

To add a new type, update `ALLOWED_CONTENT_TYPES` in
`src/services/exportS3.ts` and extend the test matrix in
`src/tests/exportS3.traversal.test.ts`.

---

## Evidence URL Validation

Evidence references store pre-signed object-storage URLs supplied by callers.
They are **not** built by the backend, but they are validated before acceptance:

1. **SSRF guard** — `validateEvidenceUrlSafety` calls `isUrlAllowed`, which
   blocks RFC 1918 private ranges, loopback, link-local, and non-allowlisted
   hosts. See `src/services/evidence.ts` for the implementation.
2. **Expiry check** — the signed URL must not already be expired. Both
   AWS-style (`X-Amz-Expires` + `X-Amz-Date`) and epoch-style (`Expires`)
   parameters are supported.
3. **Protocol enforcement** — only `http:` and `https:` are accepted.

---

## Adding a New Upload Path

1. Determine the tenant prefix (e.g. `evidence/<org-id>/`).
2. Pass every user-supplied path segment through `sanitizeS3KeySegment`.
3. Choose the correct content type and confirm it is in `ALLOWED_CONTENT_TYPES`.
4. Call `uploadToS3` — it enforces the content-type allowlist automatically.
5. Add test cases covering traversal inputs and the disallowed-content-type
   path to `src/tests/exportS3.traversal.test.ts`.
