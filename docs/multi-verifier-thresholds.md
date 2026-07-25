# Multi-Verifier Milestone Approval Thresholds

## Overview

The multi-verifier milestone approval system enables vault creators to define M-of-N approval thresholds for milestone validation. Instead of requiring a single designated verifier to approve a milestone, the system allows multiple verifiers to vote on milestone completion, with the milestone being marked as verified only when the threshold is reached.

## Veto Semantics (Rejection-Quorum Settlement)

A milestone transitions to **irrevocably rejected** as soon as it becomes mathematically impossible to ever reach the approval threshold — not only when all verifiers have explicitly rejected.

### Veto Math

Given:
- **M** = `approvalThreshold` (approvals required)
- **N** = total verifiers in the pool
- **approved** = votes cast as `approved`
- **rejected** = votes cast as `rejected`
- **remaining** = `N - (approved + rejected)` (verifiers yet to vote)

**maxPossibleApprovals** = `approved + remaining`

A milestone is **vetoed** (`isRejected = true`) when:

```
maxPossibleApprovals < M
```

Equivalently: `rejected > N - M` (rejection budget exceeded).

### Examples

| Threshold (M) | Pool (N) | Approved | Rejected | maxPossible | isRejected |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 2 | 3 | 0 | 1 | 2 | ❌ not yet |
| 2 | 3 | 0 | 2 | 1 | ✅ vetoed |
| 2 | 3 | 2 | 1 | 2 | ❌ complete (not vetoed) |
| 3 | 5 | 0 | 3 | 2 | ✅ vetoed |
| 1 | 1 | 0 | 1 | 0 | ✅ vetoed |

### Late-Vote Rejection (Settled State)

The `/approve` endpoint checks settlement state **before** recording a vote. If a milestone is already `isComplete` or `isRejected`, the endpoint returns `409 Conflict` — no vote is recorded. `DuplicateVerifierVoteError` is still enforced at the DB layer regardless.

### Legacy / No-N Mode

When `totalVerifiers` (N) is not provided, the system falls back to **any-rejection-vetoes** semantics (`isRejected = rejected > 0`). This preserves backward compatibility with single-verifier milestones (threshold 1).

### `isComplete` vs `isRejected`

- `isComplete = true` requires: `approved >= M` **and** `isRejected = false`
- Both can be false simultaneously (voting still in progress)
- Once `isRejected = true`, it cannot be reversed (votes are immutable)

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
  approvalThreshold: number,
  totalVerifiers?: number,   // N — enables veto math when provided
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

Returns comprehensive approval progress. When `totalVerifiers` is supplied, `isRejected` uses veto math (`maxPossibleApprovals < M`). Without it, any rejection vetoes (legacy). `approvalPercentage` = `approved / totalVoted * 100`.

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

### Rejection as Veto (N-based)

A milestone is irrevocably rejected only when it is **mathematically impossible** to ever reach the approval threshold — not on the first rejection. The veto condition is:

```
maxPossibleApprovals = approved + (N - totalVoted) < M
```

This means:
- For a 2-of-3 milestone, **one** rejection does not veto (two approvals are still possible)
- For a 2-of-3 milestone, **two** rejections do veto (only one approval remains possible, which is < 2)
- Once vetoed, the state is irreversible — no further votes can change `isRejected`

**Backward compatibility:** When N (total verifiers) is not provided, the system falls back to
legacy semantics where any single rejection immediately vetoes the milestone.

**Why this matters:**
- Allows dissenting minority votes without blocking valid majority approval
- Prevents premature rejection of milestones where consensus is still possible
- Clear, deterministic settlement: `rejected > N - M` triggers veto

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

### 4. Veto by Rejection (N-based)

```typescript
// Setup: 2-of-3 threshold, N=3 verifiers
const milestone = createMilestoneWithThreshold(vaultId, 'Audit', 2)

// One rejection: maxPossible = 0 + 2 remaining = 2 >= 2 → NOT yet vetoed
await recordMilestoneApproval(milestone.id, 'v1', 'rejected')
let progress = await getMilestoneApprovalProgress(milestone.id, 2, 3)
console.log(progress.isRejected) // false (can still reach 2 approvals)

// Two rejections: maxPossible = 0 + 1 remaining = 1 < 2 → VETOED
await recordMilestoneApproval(milestone.id, 'v2', 'rejected')
progress = await getMilestoneApprovalProgress(milestone.id, 2, 3)
console.log(progress.isRejected) // true
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
