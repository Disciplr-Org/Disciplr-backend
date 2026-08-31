# feat(verifiers): admin suspend/reinstate lifecycle with vote gating and audit logs

## Summary

Implements the complete verifier suspend/reinstate lifecycle for admin verifier management. Suspended verifiers are blocked from casting milestone approvals while their historical votes remain intact. Every status transition is audited via the tamper-evident audit log system.

## Changes

### Routes (`src/routes/adminVerifiers.ts`)

- **`POST /api/admin/verifiers/:userId/suspend`** — Transitions a verifier to `suspended` status. Verifiers must be in `approved` state to be suspended.
- **`POST /api/admin/verifiers/:userId/reinstate`** — Restores a verifier to their prior active state. If the verifier was previously approved (has `approvedAt` timestamp), restores to `approved`; otherwise restores to `pending`.

### Services (`src/services/milestones.ts`)

- **`validateMilestoneMultiVerifier()`** — Updated to accept an optional `verifierStatus` parameter. Returns an error response rejecting the action when a suspended or deactivated verifier attempts to cast a milestone approval, preserving historical votes intact.

### Documentation (`docs/verifiers.md`)

- Added `reinstate` endpoint to the admin endpoints list with detailed description
- Updated the status transition table to include endpoint mapping and reinstate behavior
- Added documentation for the reinstate restore logic and audit action mapping

### Tests (`tests/adminVerifiers.lifecycle.test.ts`)

Comprehensive test coverage for the lifecycle:
- **Suspend**: approved → suspended transition, 404 for nonexistent verifier, 409 for invalid transitions, 500 on internal errors
- **Reinstate**: suspended → approved (previously approved), suspended → pending (never approved), 404/409/500 error cases, edge case with approvedAt-only verifiers
- **Edge cases**: already-suspended verifier, never-suspended verifier, concurrent requests
- **Audit logs**: audit log ID present in responses, null for no-op transitions
- **Stats and fields**: changedFields reported correctly, stats returned with response

## Status Transition Matrix

| From | To | Endpoint |
|------|----|----------|
| `pending` | `approved`, `deactivated` | `/approve`, `/deactivate` |
| `approved` | `suspended`, `deactivated` | `/suspend`, `/deactivate` |
| `suspended` | `approved`, `deactivated` | `/reinstate`, `/deactivate` |
| `deactivated` | `pending` | `/reactivate` |

## Security

- All lifecycle endpoints are gated by `authenticate` + `requireAdmin` middleware
- Non-admin roles receive 403 Forbidden
- Suspended/deactivated verifiers are rejected by the milestone approval route with a clear error message

closes #617
