# GraphQL API

The Disciplr backend provides a read-only GraphQL endpoint to fetch nested data efficiently in a single request. 
This is especially useful for dashboards that need to aggregate vaults, milestones, validations, and analytics without multiple round-trips.

## Endpoint

`POST /api/organizations/:orgId/graphql`

## Authentication
The GraphQL endpoint uses the same authentication and organization-based access control as the REST API.
You must provide a valid `Authorization: Bearer <token>` header, and you must be an authorized member of the organization specified in the URL.

## Schema Highlights
- `Vault`: Contains core vault properties (amount, status, etc.), nested `milestones`, nested `validations`, and rolled-up `analytics`.
- `Milestone`: Contains milestone details and nested `validations`.
- `Validation`: Represents a verifier's approval or rejection.
- `Analytics`: Organization-wide rolled up analytics.

## Query Restrictions
To prevent abusive queries:
1. **Depth Limiting**: Queries are restricted to a maximum depth of 5. Nested queries beyond this depth will be rejected.
2. **Read-Only**: Only queries are supported. Mutations must be performed through the REST API.

## Example Query

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
