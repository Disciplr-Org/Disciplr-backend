# GraphQL API

The Disciplr backend provides a read-only GraphQL endpoint to fetch nested data efficiently in a single request.
This is especially useful for dashboards that need to aggregate vaults, milestones, validations, and analytics without multiple round-trips.

## Endpoint

```
POST /api/organizations/:orgId/graphql
```

## Authentication and authorization

Every request to the GraphQL endpoint must:

1. **Carry a valid JWT** in the `Authorization: Bearer <token>` header.
   Requests without a token, or with an expired/invalid token, receive `401 Unauthorized`.

2. **Be made by a member of the target organization.**
   The caller's user id (from the JWT) must have an active membership in `:orgId`.
   Non-members receive `403 Forbidden`.

Both checks run _before_ any resolver executes, via the standard `authenticate` and
`requireOrgAccess` middleware applied to the router.

## Org-scoped resolver guarantees

After the middleware layer passes, every resolver enforces tenant isolation:

| Resolver | Enforcement |
|---|---|
| `vault(id: …)` | Fetches the vault then compares `vault.orgId` against the caller's `orgId`. Returns `null` + `FORBIDDEN` error if the vault belongs to a different org or has no org. |
| `vaults` | Filters the full vault list to `vault.orgId === orgId`. Never leaks cross-tenant rows. |
| `vault.validations` | DataLoader is seeded only with vault IDs that belong to the caller's org. Verifications for other-org targets are excluded. |
| `milestone.validations` | Same DataLoader scope — milestone IDs are only loaded when their parent vault is in the caller's org. |
| `vault.analytics` | Read-only analytics summary; no tenant-scoped data is exposed. |

### Error shape for FORBIDDEN

When a resolver rejects a cross-org argument the response is `200 OK` with:

```json
{
  "data": { "vault": null },
  "errors": [
    {
      "message": "Forbidden: resource does not belong to your organization",
      "extensions": { "code": "FORBIDDEN" }
    }
  ]
}
```

## Query restrictions

| Guard | Value |
|---|---|
| Max query depth | 5 |
| Mutations | Not supported — use the REST API |

Queries exceeding the depth limit are rejected at validation time before any resolver runs.

## Schema

```graphql
type Query {
  vault(id: String): Vault
  vaults(filter: String, cursor: String): [Vault]
}

type Vault {
  id: String
  amount: String
  startDate: String
  endDate: String
  verifier: String
  successDestination: String
  failureDestination: String
  creator: String
  status: String
  createdAt: String
  milestones: [Milestone]
  validations: [Validation]
  analytics: Analytics
}

type Milestone {
  id: String
  vaultId: String
  title: String
  description: String
  dueDate: String
  amount: String
  sortOrder: Int
  verifierUserId: String
  createdAt: String
  validations: [Validation]
}

type Validation {
  id: String
  verifierUserId: String
  targetId: String
  result: String
  evidenceHash: String
  disputed: Boolean
  timestamp: String
}

type Analytics {
  totalVaults: Int
  activeVaults: Int
  completedVaults: Int
  failedVaults: Int
  totalLockedCapital: String
  activeCapital: String
  successRate: Float
  lastUpdated: String
}
```

## Example

```graphql
query {
  vaults {
    id
    amount
    status
    analytics {
      totalVaults
      successRate
    }
    milestones {
      title
      amount
      dueDate
      validations {
        verifierUserId
        result
      }
    }
    validations {
      verifierUserId
      result
    }
  }
}
```

```bash
curl -X POST https://api.example.com/api/organizations/org-abc/graphql \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ vaults { id amount status } }"}'
```
