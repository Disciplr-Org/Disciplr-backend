# Privacy Logging Guidelines

## Overview
Disciplr is committed to protecting user data. To ensure that sensitive Personally Identifiable Information (PII) and credentials are never written to long-term storage via logs, we have implemented a dedicated `privacy-logger` middleware.

## Redaction Policy

Any field containing the following keys (case-insensitive) will have its value redacted and replaced with `***REDACTED***` in our application and audit logs:
- `email`
- `password`
- `token`
- `accessToken`
- `refreshToken`
- `apiKey`
- `api_key`
- `secret`
- `clientSecret`
- `creator`
- `successDestination`
- `failureDestination`
- `authorization` (Headers)
- `cookie` (Headers)
- `x-api-key` (Headers)

### Supported Data Structures
The redaction engine is recursive and works safely across nested objects, arrays, and standard data structures. It includes built-in protection against circular references (to prevent stack overflows) and automatically serializes `Date`, `RegExp`, and `Buffer` objects without attempting to recursively parse their internal properties.

## Adding New Redactions
To add new redactions, simply add the new field key to `SENSITIVE_FIELDS` in `src/middleware/privacy-logger.ts`.

## Development vs Production
This redaction policy runs across all environments including development to prevent accidental ingestion into development databases or logs and ensure parity in testing. Debugging should rely on non-sensitive identifiers such as user IDs, vault IDs, and transaction references, which remain visible in the logs.