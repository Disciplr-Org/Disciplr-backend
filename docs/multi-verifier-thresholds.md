# Multi-Verifier Milestone Approval Thresholds

## Overview

The multi-verifier milestone approval system enables vault creators to define M-of-N approval thresholds for milestone validation. Instead of requiring a single designated verifier to approve a milestone, the system allows multiple verifiers to vote on milestone completion, with the milestone being marked as verified only when the threshold is reached.

## Architecture

### Core Concepts

- **Milestone**: A milestone is a checkpoint in a vault's progress that must be validated before proceeding
- **Approval Threshold (M-of-N)**: A milestone can be configured to require M approvals out of N potential verifiers
  - M = number of approvals required
  - N = total number of verifiers (or just required to track distinct votes)
- **Distinct Votes**: Each verifier can only vote once per milestone (enforced by database unique constraint)
- **Vote Status**: Each vote can be 'approved', 'rejected', or 'pending'

### Database Schema

#### milestones table (extended)

```sql
ALTER TABLE milestones ADD COLUMN approval_threshold INTEGER NOT NULL DEFAULT 1
```

- `approval_threshold`: The M value in M-of-N threshold (defaults to 1 for backward compatibility)
- Indexed for efficient queries

#### milestone_approvals table (new)

```sql
CREATE TABLE milestone_approvals (
  id UUID PRIMARY KEY,
  milestone_id VARCHAR(64) NOT NULL REFERENCES milestones(id),
  verifier_user_id VARCHAR(255) NOT NULL REFERENCES verifiers(user_id),
  approval_status ENUM('pending', 'approved', 'rejected'),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE(milestone_id, verifier_user_id) -- Prevent duplicate votes
)
```

Key features:
- **Unique constraint**: `(milestone_id, verifier_user_id)` ensures single vote per verifier per milestone
- **Status tracking**: Tracks approval status for each vote
- **Timestamps**: Records when votes were cast and last updated
- **Indexes**: Optimized for queries by milestone, verifier, and status

## API Endpoints

### POST /api/vaults/:vaultId/milestones/:id/approve

Record a verifier's approval or rejection for a milestone.

**Request:**
```json
{
  "approvalStatus": "approved" | "rejected"
}
```

**Response:**
```json
{
  "approval": {
    "id": "uuid",
    "milestoneId": "ms-123",
    "verifierUserId": "verifier-1",
    "approvalStatus": "approved",
    "createdAt": "2026-05-26T10:00:00Z",
    "updatedAt": "2026-05-26T10:00:00Z"
  },
  "approvalProgress": {
    "approved": 2,
    "rejected": 0,
    "pending": 1,
    "required": 2,
    "isComplete": true,
    "isRejected": false,
    "approvalPercentage": 66.67
  },
  "milestone": {
    "id": "ms-123",
    "vaultId": "vault-1",
    "description": "Complete Phase 1",
    "approvalThreshold": 2,
    "verified": true,
    "verifiedAt": "2026-05-26T10:05:00Z",
    "verifiedBy": "verifier-1"
  },
  "milestoneCompleted": true,
  "vaultCompleted": false
}
```

**Errors:**

- `400 Bad Request`: Invalid approvalStatus
- `404 Not Found`: Vault or milestone not found
- `409 Conflict`: Verifier has already voted on this milestone (duplicate vote prevention)

### GET /api/vaults/:vaultId/milestones/:id/approval-status

Get detailed approval status for a milestone.

**Response:**
```json
{
  "milestone": {
    "id": "ms-123",
    "vaultId": "vault-1",
    "description": "Complete Phase 1",
    "approvalThreshold": 2
  },
  "approvalStatus": {
    "approved": 2,
    "rejected": 0,
    "pending": 1,
    "required": 2,
    "isComplete": true,
    "isRejected": false,
    "approvalPercentage": 66.67
  }
}
```

## Service Layer Functions

### Verifiers Service (`src/services/verifiers.ts`)

#### recordMilestoneApproval

```typescript
recordMilestoneApproval(
  milestoneId: string,
  verifierUserId: string,
  approvalStatus: 'approved' | 'rejected' | 'pending'
): Promise<MilestoneApproval>
```

Records a milestone approval vote. Throws `DuplicateVerifierVoteError` if the verifier has already voted.

**Security**: The unique constraint on `(milestone_id, verifier_user_id)` ensures this at the database level.

#### getMilestoneApprovals

```typescript
getMilestoneApprovals(milestoneId: string): Promise<{
  approved: MilestoneApproval[]
  rejected: MilestoneApproval[]
  pending: MilestoneApproval[]
}>
```

Returns all approvals for a milestone, grouped by status.

#### getApprovedVerifiersCount

```typescript
getApprovedVerifiersCount(milestoneId: string): Promise<number>
```

Returns the count of approved votes (used for threshold checking).

#### getAllMilestoneVotes

```typescript
getAllMilestoneVotes(milestoneId: string): Promise<MilestoneApproval[]>
```

Returns all votes for a milestone in chronological order.

#### hasVerifierVoted

```typescript
hasVerifierVoted(
  milestoneId: string,
  verifierUserId: string
): Promise<boolean>
```

Checks if a specific verifier has already voted on a milestone. Used for duplicate vote prevention.

#### hasMilestoneMetThreshold

```typescript
hasMilestoneMetThreshold(
  milestoneId: string,
  approvalThreshold: number
): Promise<boolean>
```

Determines if a milestone has received enough approvals to meet its threshold.

#### getMilestoneApprovalProgress

```typescript
getMilestoneApprovalProgress(
  milestoneId: string,
  approvalThreshold: number
): Promise<{
  approved: number
  rejected: number
  pending: number
  required: number
  isComplete: boolean
  isRejected: boolean
  approvalPercentage: number
}>
```

Returns comprehensive approval progress including completion status. A milestone is considered:
- **Complete**: `approved >= required` AND `rejected === 0`
- **Rejected**: `rejected > 0` (any rejection fails the milestone)

## Security Considerations

### Duplicate Vote Prevention

**Multi-layer prevention:**

1. **Database Constraint**: Unique index on `(milestone_id, verifier_user_id)` prevents database-level duplicates
2. **Application Check**: `hasVerifierVoted()` checks before recording approval
3. **Error Handling**: `DuplicateVerifierVoteError` is thrown with clear messaging

**Why this matters:**
- Prevents a verifier from changing their vote
- Prevents accidental double-submissions
- Ensures fair voting (1 vote per verifier)
- Immutable approval record

### Rejection as Veto

- A single rejection immediately marks the milestone as rejected
- Subsequent approvals cannot override a rejection
- This is an all-or-nothing model: if ANY verifier rejects, the milestone fails

**Rationale:**
- Ensures security-critical milestones cannot be approved despite dissent
- Prevents collusion (one verifier can't outvote another's rejection)
- Clear veto semantics

### Threshold Validation

- The `approvalThreshold` is set at milestone creation time
- Cannot be changed after milestone creation (immutable)
- Prevents manipulation of threshold requirements

## Usage Examples

### 1. Simple Single-Verifier Approval (Legacy)

```typescript
// Milestone with threshold 1 (default)
const milestone = createMilestoneWithThreshold(
  vaultId,
  'Complete Phase 1',
  1 // Single approval required
)

// Verifier approves
const approval = await recordMilestoneApproval(
  milestone.id,
  'verifier-1',
  'approved'
)

// Check if threshold met
const isComplete = await hasMilestoneMetThreshold(milestone.id, 1) // true
```

### 2. 2-of-3 Approval Threshold

```typescript
// Require 2 out of 3 verifiers to approve
const milestone = createMilestoneWithThreshold(
  vaultId,
  'Security Checkpoint',
  2 // 2-of-3 threshold
)

// First verifier approves
await recordMilestoneApproval(milestone.id, 'verifier-1', 'approved')

// Second verifier approves - threshold met
await recordMilestoneApproval(milestone.id, 'verifier-2', 'approved')

// Check progress
const progress = await getMilestoneApprovalProgress(milestone.id, 2)
console.log(progress.isComplete) // true
console.log(progress.approvalPercentage) // 66.67
```

### 3. Handling Duplicate Vote Prevention

```typescript
try {
  // First vote
  await recordMilestoneApproval(milestone.id, 'verifier-1', 'approved')
  
  // Try to vote again
  await recordMilestoneApproval(milestone.id, 'verifier-1', 'approved')
} catch (error) {
  if (error instanceof DuplicateVerifierVoteError) {
    console.error('Verifier already voted:', error.message)
    // Handle duplicate vote in UI
  }
}
```

### 4. Rejection as Veto

```typescript
// Setup: 2-of-3 threshold
const milestone = createMilestoneWithThreshold(vaultId, 'Audit', 2)

// Two verifiers approve
await recordMilestoneApproval(milestone.id, 'v1', 'approved')
await recordMilestoneApproval(milestone.id, 'v2', 'approved')

let progress = await getMilestoneApprovalProgress(milestone.id, 2)
console.log(progress.isComplete) // true (2 approvals)

// Third verifier rejects
await recordMilestoneApproval(milestone.id, 'v3', 'rejected')

progress = await getMilestoneApprovalProgress(milestone.id, 2)
console.log(progress.isRejected) // true (any rejection fails milestone)
console.log(progress.isComplete) // false
```

## Testing Strategy

### Test Coverage (95%+ target)

#### Unit Tests
- **Approval Recording**: Recording single/multiple votes, status tracking
- **Duplicate Prevention**: Attempts to vote twice, error handling
- **Threshold Checking**: Meeting/not meeting thresholds at various levels
- **Vote Counting**: Accurate counts by status
- **Edge Cases**: Empty IDs, special characters, long IDs

#### Integration Tests
- **M-of-N Workflows**: 2-of-3, 3-of-5, etc. full approval flows
- **Rejection Handling**: Veto scenarios and impact
- **Mixed Statuses**: Combinations of approved, rejected, pending
- **Consistency**: Data consistency across operations

#### Security Tests
- **Duplicate Prevention**: Double voting attempts fail reliably
- **Veto Enforcement**: Rejection is immutable
- **Constraint Enforcement**: Database constraints prevent violations

See [tests/multiVerifier.test.ts](../tests/multiVerifier.test.ts) for complete test suite.

## Migration and Backward Compatibility

### Database Migration

```bash
npm run migrate:latest
```

Migration file: `db/migrations/20260429000000_add_multi_verifier_support.cjs`

**Changes:**
1. Adds `approval_threshold` column to `milestones` table (defaults to 1)
2. Creates new `milestone_approvals` table with unique constraint
3. Creates supporting indexes for performance

### Backward Compatibility

- Existing milestones automatically get `approval_threshold = 1`
- Single-verifier approval flow unchanged (use threshold of 1)
- Legacy code continues to work with new approval system

## Performance Considerations

### Indexes

The `milestone_approvals` table includes these indexes:

```sql
idx_milestone_approvals_milestone_id         -- Get all votes for a milestone
idx_milestone_approvals_verifier_user_id     -- Get all votes by a verifier
idx_milestone_approvals_status               -- Filter by status
idx_milestone_approvals_milestone_status     -- Combined queries (milestone + status)
idx_milestone_approvals_unique              -- Enforce single vote per verifier
```

### Query Efficiency

- `hasMilestoneMetThreshold()`: O(1) - single COUNT query with index
- `getMilestoneApprovals()`: O(n) where n = number of votes (typically small)
- `hasVerifierVoted()`: O(1) - indexed lookup
- Threshold checking uses indexed scans, not table scans

### Recommendations

- Limit milestone approval thresholds to reasonable values (typically 2-5)
- Archive old milestone_approvals records after milestone completion
- Monitor index performance if storing millions of milestone_approvals records

## Error Handling

### DuplicateVerifierVoteError

```typescript
export class DuplicateVerifierVoteError extends Error {
  constructor(milestoneId: string, verifierUserId: string)
  name: 'DuplicateVerifierVoteError'
  message: 'Verifier {id} has already voted on milestone {id}'
}
```

**When thrown:**
- Verifier attempts to vote on same milestone twice
- Caught in routes and returned as `409 Conflict`

### Other Errors

- `400 Bad Request`: Invalid input (bad milestone ID, invalid status)
- `404 Not Found`: Milestone or vault not found
- `409 Conflict`: Duplicate vote or vault not active

## Future Enhancements

### Potential Improvements

1. **Vote Revocation**: Allow verifiers to retract votes (with audit trail)
2. **Weighted Votes**: Give some verifiers higher voting power
3. **Time-based Constraints**: Votes only valid within certain time window
4. **Conditional Thresholds**: Different thresholds based on milestone type
5. **Appeal Process**: Challenge rejected milestones with higher threshold

### Configuration

```typescript
interface MilestoneApprovalConfig {
  approvalThreshold: number
  allowRevocation?: boolean
  votingDuration?: number // milliseconds
  weightedVotes?: Record<string, number>
}
```

## Troubleshooting

### Milestone stuck in partial approval

**Problem**: Milestone has approvals but not enough to meet threshold

**Solution**: Contact remaining verifiers or increase approval threshold if authority permits

### Duplicate vote errors

**Problem**: Verifier gets "already voted" error but claims they never voted

**Solution**: Check audit logs; vote may have been recorded in partial failure scenario

### Performance degradation with many approvals

**Problem**: Threshold checking or approval listing is slow

**Solution**: Add more verifiers to distribute votes; check index statistics; archive old approvals

## Audit and Logging

All milestone approvals are tracked with:
- Timestamp of approval
- Verifier identity (immutable)
- Approval status (immutable)
- Milestone ID (immutable)

This creates an immutable audit trail of all verifier decisions.

## References

- Database Migrations: [20260429000000_add_multi_verifier_support.cjs](../db/migrations/20260429000000_add_multi_verifier_support.cjs)
- Service Implementation: [src/services/verifiers.ts](../src/services/verifiers.ts)
- Milestone Service: [src/services/milestones.ts](../src/services/milestones.ts)
- Routes: [src/routes/milestones.ts](../src/routes/milestones.ts)
- Tests: [tests/multiVerifier.test.ts](../tests/multiVerifier.test.ts)
