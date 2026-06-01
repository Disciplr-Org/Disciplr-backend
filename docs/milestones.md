# Milestones API

Milestones represent verifiable tasks or conditions that must be completed for a vault to transition to the "completed" state. Each milestone is assigned to a specific verifier who is responsible for validating its completion.

## Check-in Grace Window (`lateCheckInWindowSecs`)

By default, a verifier must validate a milestone **on or before its `dueDate`**. Setting `lateCheckInWindowSecs` on the vault allows a configurable grace period after `dueDate` during which check-in is still accepted.

### How it works

```
effectiveDeadline = min(dueDate + lateCheckInWindowSecs, vault.endDate)
```

- If `now ≤ effectiveDeadline` → check-in accepted.
- If `now > effectiveDeadline` → `400 DeadlinePassed`.
- The window is always bounded by the vault's `endDate` so it can never extend beyond the vault lifetime.
- If a milestone has no `dueDate`, no deadline is enforced regardless of the grace window.

### Configuration

Pass `lateCheckInWindowSecs` when creating a vault:

```json
{
  "amount": "1000",
  "startDate": "2030-01-01T00:00:00.000Z",
  "endDate": "2030-06-01T00:00:00.000Z",
  "verifier": "G...",
  "destinations": { "success": "G...", "failure": "G..." },
  "lateCheckInWindowSecs": 3600,
  "milestones": [
    { "title": "Kickoff", "dueDate": "2030-02-01T00:00:00.000Z", "amount": "500" }
  ]
}
```

| Field | Type | Default | Constraints |
|---|---|---|---|
| `lateCheckInWindowSecs` | integer | `0` | ≥ 0; bounded by vault `endDate` at runtime |

### Boundary behaviour

| Scenario | Result |
|---|---|
| `now < dueDate` | ✅ Accepted |
| `dueDate < now ≤ dueDate + graceWindow` (and `≤ endDate`) | ✅ Accepted |
| `now > dueDate + graceWindow` | ❌ `400 DeadlinePassed` |
| `now > endDate` (even within grace window) | ❌ `400 DeadlinePassed` |
| No `dueDate` on milestone | ✅ Accepted (no deadline) |

## Milestone Validation

### POST /api/vaults/:vaultId/milestones/:milestoneId/validate

Validates a milestone as completed. Only the assigned verifier can perform this action, and validation is idempotent (cannot be repeated).

**Authentication:** Required (JWT Bearer token)
**Authorization:** VERIFIER role required, must be the assigned verifier for the milestone
**Idempotency:** Yes - repeated validations return conflict error

#### Request

- **Method:** POST
- **Path:** `/api/vaults/:vaultId/milestones/:milestoneId/validate`
- **Headers:**
  - `Authorization: Bearer <jwt-token>`
- **Body:** Empty

#### Response

**Success (200):**
```json
{
  "milestone": {
    "id": "string",
    "vaultId": "string",
    "description": "string",
    "verified": true,
    "verifiedAt": "2024-01-01T00:00:00.000Z",
    "verifiedBy": "verifier-user-id",
    "verifierId": "verifier-user-id",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "vaultCompleted": false
}
```

**Errors:**
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - User is not a verifier or not the assigned verifier
- `404 Not Found` - Vault or milestone does not exist
- `409 Conflict` - Milestone already validated

#### Authorization Rules

1. **Role Check:** User must have VERIFIER role
2. **Active Verifier:** Verifier account must be active
3. **Assignment Check:** User must be the assigned verifier for the milestone (`milestone.verifierId`)
4. **Replay Protection:** Cannot validate an already validated milestone

#### Events

Successful validation emits:
- `milestone.validated` domain event with validator and timestamp
- If all milestones are validated, `vault.state_changed` to `completed`

#### Security Considerations

- Verifier identity verified from authenticated JWT context, not request headers
- Prevents IDOR by validating milestone belongs to specified vault
- Idempotent to prevent replay attacks
- All validation attempts logged with actor information