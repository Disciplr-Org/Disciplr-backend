# Jobs Enqueue Contract

`POST /api/jobs/enqueue` is admin-only and validates payload by job type using a discriminated schema.

## Supported job types

- `notification.send`
- `deadline.check`
- `oracle.call`
- `analytics.recompute`
- `export.generate`
- `sessions.cleanup`

## Enqueue options

- `delayMs`: optional, must be `>= 0`
- `maxAttempts`: optional integer, bounds `1..10`

Options parsing behavior:

- `delayMs` is floored before queue scheduling.
- `maxAttempts` is used as provided after schema validation.

## Retry failed jobs

`POST /api/jobs/:id/retry` is an admin-only endpoint to retry a failed job.

- Resets a job's attempts to 0 and queues it for immediate execution.
- If the job has exhausted its `max_attempts` (i.e. is dead-lettered), the request will be refused unless `?force=true` is passed as a query parameter.
- Emits a `job.retry` audit log upon success.

## Queue depth and stuck-job sweep

`GET /api/jobs/depth` returns an admin-only queue-depth report grouped by job
type and state. The response includes queued, delayed, active, and dead-letter
totals plus a `byType` map for every supported job type.

`POST /api/jobs/sweep-stuck` reclaims active jobs whose in-memory lease has been
held longer than `staleAfterMs`.

- `staleAfterMs` is optional and defaults to 5 minutes.
- `staleAfterMs` may be supplied in the JSON body or query string and is bounded
  to a maximum of 24 hours.
- Jobs with attempts remaining are moved back to the ready queue with their
  current attempt count preserved, so the next execution consumes the next
  attempt.
- Jobs already at `maxAttempts` are moved to the dead-letter queue instead of
  being retried indefinitely.
- The sweep trigger emits a `job.sweep_stuck` audit log with scanned, reclaimed,
  and dead-lettered counts.

## Error contract

Invalid payloads return:

- HTTP `400`
- `VALIDATION_ERROR` response body from `formatValidationError`
- field-level paths (for example `payload.scope`, `maxAttempts`, `delayMs`)

## Security

- Endpoint requires valid auth token and `ADMIN` role.
- Non-admin users receive `403`.
- On success, enqueue action writes `job.enqueue` audit logs.
