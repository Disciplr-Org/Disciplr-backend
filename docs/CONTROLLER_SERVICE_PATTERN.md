# Controller vs Service Pattern

## Overview

This document describes the layered architecture pattern used in the Disciplr backend.

## Current Architecture

### Routes Layer (Controllers)

Routes in this codebase serve as the **controller layer**. They handle:
- HTTP request parsing and response formatting
- Authentication and authorization
- Input validation
- Calling appropriate service methods
- Error handling and status codes

Example from `src/routes/vaults.ts`:
```typescript
vaultsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const { creator, amount, endTimestamp, successDestination, failureDestination } = req.body

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({ error: 'Missing required vault fields' })
    return
  }

  // Delegate to service
  const newDbVault = await VaultService.createVault({...})
  res.status(201).json(vault)
})
```

### Services Layer

Services contain **business logic** and data operations:
- Database queries and mutations
- Business rule enforcement
- Data transformation
- Integration with external systems (e.g., Stellar)

Example from `src/services/vault.service.ts`:
```typescript
export class VaultService {
  static async createVault(data: CreateVaultInput): Promise<Vault> {
    // Business logic here
    // Database operations
  }
}
```

### Repository Pattern

For complex database operations, services may use repositories:
- `src/repositories/milestoneRepository.ts`
- Direct knex queries in routes/services for simpler operations

## Best Practices

### Thin Controllers (Routes)

Routes should be thin:
- ✅ Parse request, validate input, call service, format response
- ❌ Implement business logic directly
- ❌ Perform raw database queries (delegate to services)

### Business Logic in Services

Services should:
- ✅ Encapsulate business rules
- ✅ Handle data transformation
- ✅ Manage database operations
- ❌ Handle HTTP status codes (return data/errors to routes)

### Testing

- **Unit tests**: Test services in isolation
- **Integration tests**: Test routes with real HTTP requests
- Services should be testable without HTTP layer

## Migration Example

If a route has fat logic, refactor by:

1. Extract business logic to a service function
2. Keep routing/validation in the route handler
3. Service returns data or throws typed errors
4. Route catches errors and sets appropriate HTTP status

```typescript
// Before: Fat route
vaultsRouter.post('/', async (req, res) => {
  // Business logic mixed with HTTP handling
  const vault = await db('vaults').insert({...})
  await updateAnalytics()
  createAuditLog(...)
  res.status(201).json(vault)
})

// After: Thin route + service
vaultsRouter.post('/', async (req, res) => {
  try {
    const vault = await VaultService.createVault(req.body)
    res.status(201).json(vault)
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})
```

## Exception Handling

Services throw typed errors:
```typescript
export class VaultNotFoundError extends Error {
  constructor(vaultId: string) {
    super(`Vault ${vaultId} not found`)
    this.name = 'VaultNotFoundError'
  }
}
```

Routes catch and convert to HTTP responses.

## Request-Scoped Prisma Client (AsyncLocalStorage)

### Problem

Services previously imported the Prisma singleton directly:

```typescript
import { prisma } from '../lib/prisma.js'
```

This makes it impossible to share a single `$transaction` client across multiple
helpers called within the same request without threading the client through every
argument list.

### Solution

`src/lib/prismaScope.ts` exposes an `AsyncLocalStorage<{ prisma }>` store and a
`getPrisma()` helper.  Services call `getPrisma()` instead of using the
singleton import directly.  The `withRequestPrisma` middleware populates the
store at the start of every request.

```
Request → withRequestPrisma → ALS store = { prisma: singleton }
                            → route handler
                                → ServiceA.method()   ← getPrisma() == store.prisma
                                → ServiceB.method()   ← getPrisma() == store.prisma
```

### Using $transaction across services

Because all helpers in a request share the same ALS context you can wrap them in
a transaction at the route layer without changing service signatures:

```typescript
// route handler
const result = await getPrisma().$transaction(async (tx) => {
  prismaStorage.run({ prisma: tx as any }, async () => {
    await UserService.softDeleteUser(userId)   // getPrisma() → tx
    await AuthService.logout(refreshToken)     // getPrisma() → tx
  })
})
```

### getPrisma() fallback

If called outside an active ALS context (background jobs, scripts, tests that
don't use the middleware) `getPrisma()` returns the global singleton.  No
callers break.

### Files

| File | Role |
|---|---|
| `src/lib/prismaScope.ts` | ALS store + `getPrisma()` |
| `src/middleware/withRequestPrisma.ts` | Express middleware that seeds the store |
| `src/tests/prismaScope.test.ts` | Unit tests |

### Service migration checklist

Replace direct singleton imports with `getPrisma()`:

```typescript
// Before
import { prisma } from '../lib/prisma.js'
await prisma.refreshToken.updateMany(...)

// After
import { getPrisma } from '../lib/prismaScope.js'
await getPrisma().refreshToken.updateMany(...)
```
