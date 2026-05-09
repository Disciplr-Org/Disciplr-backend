# Milestones API

Milestones represent verifiable tasks or conditions that must be completed for a vault to transition to the "completed" state. Each milestone is assigned to a specific verifier who is responsible for validating its completion.

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