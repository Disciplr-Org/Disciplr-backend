# Export streaming and quota contract

Issue: #1537

## Invariants

- Export quota accounting is keyed only by the authenticated principal. Client-supplied `orgId` query parameters and `x-organization-id` headers are not trusted.
- The daily quota repository performs the check and increment atomically, so concurrent requests cannot push a stored counter above its configured limit.
- Export column filters are bounded to 16 KiB of UTF-8 input and at most 25 columns per section.
- Export creation admits at most two simultaneous HTTP enqueue operations per quota key in a process. The daily quota remains the authoritative cross-process control.
- Download responses are emitted in 512 KiB chunks through a backpressure-aware stream when the response supports `write()`/`end()`.
- Export polling metadata exposes a one-second minimum interval and a 300-attempt client-side ceiling (five minutes at the advertised interval).
- Operational events contain bounded error text and export metadata, not credentials or signed URLs.

## Degraded behavior

- Daily quota exhaustion returns `429` with `Retry-After` set to the remaining UTC-day duration.
- Process-local concurrency saturation returns `429` with a one-second `Retry-After` hint.
- Invalid or oversized column filters return `400` before quota consumption or job enqueue.
- Unauthorized export status/download access returns `403` without revealing export contents.

## Tradeoffs and limitations

The concurrency gate is intentionally process-local. It protects the HTTP enqueue boundary from bursts but is not a replacement for a distributed semaphore. Deployments with multiple application instances must rely on the atomic persistent quota and job-system worker capacity for cross-process enforcement.

Export generation still materializes the completed result in the existing job representation. This change bounds request parsing and network delivery and avoids one-shot response writes; it does not redesign the storage/worker representation of generated results.

## Validation

Focused validation:

```bash
npm test -- src/services/exportBounds.test.ts
npm test -- src/routes/exports.quota.test.ts
npm test -- src/routes/exports.test.ts
npm run build
npm run lint
```
