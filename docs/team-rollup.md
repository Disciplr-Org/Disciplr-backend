# Team Rollup Reporting

## Endpoint

`GET /api/organizations/:orgId/teams/rollup`

Requires authentication and `owner` or `admin` organization role (enforced by `requireOrgRole` middleware).

## Response Shape

```json
{
  "orgId": "uuid",
  "teams": [
    {
      "teamId": "uuid",
      "name": "Team Alpha",
      "slug": "team-alpha",
      "vaultCount": 5,
      "totalCapital": "1234.56",
      "activeVaults": 2,
      "completedVaults": 2,
      "failedVaults": 1,
      "milestoneCount": 10,
      "milestonesCompleted": 6,
      "slashRate": 0.3333
    }
  ],
  "orgTotals": {
    "teamCount": 3,
    "vaultCount": 15,
    "totalCapital": "5000.00",
    "activeVaults": 6,
    "completedVaults": 5,
    "failedVaults": 4,
    "milestoneCount": 30,
    "milestonesCompleted": 18,
    "slashRate": 0.4444
  },
  "generatedAt": "2026-06-27T12:00:00.000Z"
}
```

## Field Definitions

| Field | Type | Description |
|---|---|---|
| `teamId` | string (UUID) | Team identifier |
| `name` | string | Team display name |
| `slug` | string | URL-safe team slug |
| `vaultCount` | integer | Number of vaults assigned to this team |
| `totalCapital` | string | Sum of all vault amounts (string to preserve precision) |
| `activeVaults` | integer | Vaults with `status = 'active'` |
| `completedVaults` | integer | Vaults with `status = 'completed'` |
| `failedVaults` | integer | Vaults with `status = 'failed'` |
| `milestoneCount` | integer | Total milestones across team vaults |
| `milestonesCompleted` | integer | Milestones with `status = 'approved'` |
| `slashRate` | float | Ratio of failed vaults to resolved vaults (failed / (completed + failed)) |
| `orgTotals` | object | Aggregated sums across all teams |

## Deduplication

Vaults are assigned to teams via the `memberships` table: a vault's `creator` is matched to a `memberships.user_id` with a non-null `team_id` within the same organization. When a vault creator belongs to multiple teams, each vault is assigned to exactly one team using `ROW_NUMBER()` partitioned by vault ID, ordered by team ID. This prevents double-counting of vault capital or counts across teams.

## Tenant Isolation

All queries are strictly scoped by `organization_id`:

- Teams are filtered by `t.organization_id = :orgId`
- Vaults are filtered by `v.organization_id = :orgId`
- Memberships are filtered by `m.organization_id = :orgId`
- Soft-deleted vaults and milestones (`deleted_at IS NOT NULL`) are excluded

Cross-org leakage is structurally impossible because every CTE in the rollup query constrains on the same `orgId` parameter.

## Performance

The rollup is computed from persisted data in a single SQL round-trip (one `db.raw()` call with three CTEs). There are no N+1 queries. The query leverages existing indexes on `vaults.organization_id` and `teams.organization_id`.

## Edge Cases

- **Org with zero teams**: Returns an empty `teams` array and zeroed `orgTotals`.
- **Team with no vaults**: Returns the team entry with all numeric fields set to 0 via `COALESCE`.
- **Empty milestone/vault data**: All counts default to 0; `slashRate` is 0 when no vaults have resolved.
- **Soft-deleted records**: Excluded via `deleted_at IS NULL` checks on both vaults and milestones.
