# Requirements Document

## Introduction

The `privacy-logger` middleware for the Disciplr backend must ensure that personally identifiable information (PII) and security-sensitive values are never written to application logs. The existing `src/middleware/privacy-logger.ts` masks only a narrow set of body fields and uses unstructured `console.log` output. This feature extends it to: redact all known PII field names and patterns (emails, tokens, passwords, authorization headers, API keys) from request bodies, headers, and query strings; emit structured JSON log lines; and provide a standalone `redact` utility that any module can call. All log output must have a stable, documented JSON shape.

## Glossary

- **Privacy_Logger**: The Express middleware at `src/middleware/privacy-logger.ts` responsible for emitting a structured log line per request with all PII redacted.
- **Redactor**: The pure utility function (exported from the same module or a sibling) that accepts an arbitrary object and returns a deep copy with all sensitive values replaced by the redaction marker.
- **Redaction_Marker**: The fixed string `"[REDACTED]"` used to replace sensitive values in log output.
- **Sensitive_Field**: Any object key whose name matches the sensitive-field list, or whose value matches a PII pattern (email address regex, JWT pattern, etc.).
- **Structured_Log_Line**: A single-line JSON object written to `stdout` via `console.log` with a stable set of top-level keys: `timestamp`, `level`, `event`, `service`, `method`, `url`, `status`, `durationMs`, `ip`, `body`, `query`, `headers`.
- **PII**: Personally Identifiable Information — values that could identify or authenticate a person, including email addresses, passwords, tokens, and API keys.

## Requirements

### Requirement 1: Sensitive Field Redaction

**User Story:** As a backend engineer, I want all sensitive field names in request bodies, query strings, and headers to be replaced with `[REDACTED]` before logging, so that PII and credentials never appear in log output.

#### Acceptance Criteria

1. THE Redactor SHALL replace the value of any key matching (case-insensitively) `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `api_key`, `secret`, `authorization`, `x-api-key`, `x-auth-token`, `credential`, `credentials`, `ssn`, `creditCard`, `credit_card`, `cvv`, `pin` with the Redaction_Marker.
2. WHEN a request body, query object, or headers object contains a nested object or array, THE Redactor SHALL recursively redact all sensitive fields at every depth.
3. WHEN a field value is a string that matches an email address pattern (`/[^@\s]+@[^@\s]+\.[^@\s]+/`), THE Redactor SHALL replace that value with the Redaction_Marker regardless of the field name.
4. WHEN a field value is a string that matches a JWT pattern (`/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/`), THE Redactor SHALL replace that value with the Redaction_Marker regardless of the field name.
5. THE Redactor SHALL leave all non-sensitive fields and their values unchanged.
6. THE Redactor SHALL treat the input as immutable and return a new object; THE Redactor SHALL NOT mutate the original input.

### Requirement 2: Structured JSON Log Output

**User Story:** As a platform operator, I want every request log line to be a single-line JSON object with a stable schema, so that log aggregators can parse and query logs reliably.

#### Acceptance Criteria

1. WHEN a request completes, THE Privacy_Logger SHALL emit exactly one `console.log` call containing a single-line JSON string.
2. THE Privacy_Logger SHALL include the following top-level keys in every log line: `timestamp` (ISO 8601 UTC string), `level` (string `"info"`), `event` (string `"http.request"`), `service` (string `"disciplr-backend"`), `method` (HTTP method string), `url` (request URL string), `status` (HTTP status code number), `durationMs` (integer milliseconds), `ip` (masked IP string), `body` (redacted body object or `null`), `query` (redacted query object or `null`), `headers` (redacted headers object).
3. THE Privacy_Logger SHALL NOT include any additional top-level keys beyond those listed in criterion 2.2.
4. WHEN the request body is absent or not a plain object, THE Privacy_Logger SHALL set `body` to `null` in the log line.
5. WHEN the request query string is empty, THE Privacy_Logger SHALL set `query` to `null` in the log line.

### Requirement 3: IP Address Masking

**User Story:** As a privacy officer, I want IP addresses in logs to be partially masked, so that individual users cannot be identified from log data alone.

#### Acceptance Criteria

1. WHEN an IPv4 address is logged, THE Privacy_Logger SHALL mask the last two octets, producing the form `a.b.x.x`.
2. WHEN an IPv6 address is logged, THE Privacy_Logger SHALL retain only the first three groups and replace the remainder with `xxxx` segments, producing the form `a:b:c:xxxx:xxxx:xxxx:xxxx:xxxx`.
3. IF the IP address cannot be determined, THE Privacy_Logger SHALL log the string `"unknown"` for the `ip` field.

### Requirement 4: Header Redaction

**User Story:** As a security engineer, I want HTTP request headers containing credentials to be redacted before logging, so that bearer tokens and API keys are never stored in log files.

#### Acceptance Criteria

1. WHEN logging request headers, THE Privacy_Logger SHALL pass the headers object through the Redactor before including it in the log line.
2. THE Redactor SHALL redact the `authorization` header value (case-insensitive key match) with the Redaction_Marker.
3. THE Redactor SHALL redact the `x-api-key` header value (case-insensitive key match) with the Redaction_Marker.
4. THE Redactor SHALL redact the `x-auth-token` header value (case-insensitive key match) with the Redaction_Marker.
5. THE Redactor SHALL preserve all non-sensitive header values unchanged.
6. THE Redactor SHALL NOT log the `cookie` header; IF the `cookie` key is present, THE Redactor SHALL replace its value with the Redaction_Marker.

### Requirement 5: Redactor as Standalone Utility

**User Story:** As a backend developer, I want to import and call the `redact` function directly in any module, so that I can sanitize objects before passing them to any logger or external service.

#### Acceptance Criteria

1. THE Redactor SHALL be exported as a named export `redact` from `src/middleware/privacy-logger.ts`.
2. WHEN `redact` is called with a non-object value (string, number, boolean, null, undefined), THE Redactor SHALL return the value unchanged.
3. WHEN `redact` is called with an array, THE Redactor SHALL return a new array with each element recursively redacted.
4. WHEN `redact` is called with a plain object, THE Redactor SHALL return a new object with all sensitive keys and pattern-matched values replaced by the Redaction_Marker.

### Requirement 6: Stable Log Shape and Snapshot Testing

**User Story:** As a developer maintaining the logging pipeline, I want the JSON log shape to be validated by snapshot tests, so that accidental schema changes are caught before they reach production.

#### Acceptance Criteria

1. THE Privacy_Logger test suite SHALL include at least one Jest snapshot test that captures the exact JSON structure of a log line for a representative request.
2. WHEN the log shape changes intentionally, THE developer SHALL update the snapshot explicitly using `jest --updateSnapshot`.
3. THE snapshot SHALL cover a request that includes a body with sensitive fields, an `Authorization` header, and an `x-api-key` header, confirming all are replaced with the Redaction_Marker.

### Requirement 7: No PII in Error Paths

**User Story:** As a security engineer, I want error handling within the logger to never surface raw PII in thrown errors or fallback log lines, so that exception paths are as safe as the happy path.

#### Acceptance Criteria

1. IF the `JSON.stringify` call on the log object throws, THE Privacy_Logger SHALL emit a fallback log line containing only `{ "level": "error", "event": "privacy-logger.serialization-failure", "timestamp": "<ISO string>" }` with no request data.
2. IF the Redactor encounters a circular reference or non-serializable value in the input, THE Redactor SHALL replace that value with the Redaction_Marker rather than throwing.
3. THE Privacy_Logger SHALL call `next()` regardless of any internal error, so that the middleware chain is never interrupted.
