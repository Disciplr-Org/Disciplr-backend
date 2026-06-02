import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { registerSchema, loginSchema, refreshSchema } from '../lib/validation.js'
import { createVaultSchema } from '../services/vaultValidation.js'
import { UserRole } from '../types/user.js'

extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

// --- Security Schemes ---
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

// --- Shared Schemas ---
const ErrorSchema = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string().openapi({ example: 'Invalid request parameters' }),
      details: z.unknown().optional(),
      requestId: z.string().optional().openapi({ example: 'req_123' }),
    }),
  })
)

const VaultSchema = registry.register(
  'Vault',
  z.object({
    id: z.string().uuid(),
    creator: z.string(),
    amount: z.string(),
    status: z.enum(['active', 'completed', 'failed', 'cancelled']),
    startTimestamp: z.string().datetime(),
    endTimestamp: z.string().datetime(),
    successDestination: z.string(),
    failureDestination: z.string(),
    createdAt: z.string().datetime(),
  })
)

const MilestoneSchema = registry.register(
  'Milestone',
  z.object({
    id: z.string().uuid(),
    vaultId: z.string().uuid(),
    description: z.string(),
    status: z.enum(['pending', 'verified']),
    createdAt: z.string().datetime(),
    verifiedAt: z.string().datetime().optional(),
  })
)

// --- Paths ---

// Health
registry.registerPath({
  method: 'get',
  path: '/api/health',
  summary: 'Check API health',
  tags: ['Health'],
  responses: {
    200: {
      description: 'API is healthy',
      content: {
        'application/json': {
          schema: z.object({
            status: z.string().openapi({ example: 'ok' }),
            timestamp: z.string().datetime(),
            uptime: z.number(),
            jobs: z.any(),
          }),
        },
      },
    },
  },
})

// Auth
registry.registerPath({
  method: 'post',
  path: '/api/auth/register',
  summary: 'Register a new user',
  tags: ['Auth'],
  request: {
    body: {
      content: {
        'application/json': { schema: registerSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'User registered successfully',
      content: { 'application/json': { schema: z.any() } },
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/auth/login',
  summary: 'Login user',
  tags: ['Auth'],
  request: {
    body: {
      content: {
        'application/json': { schema: loginSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: { 'application/json': { schema: z.any() } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

// Vaults
registry.registerPath({
  method: 'get',
  path: '/api/vaults',
  summary: 'List vaults',
  tags: ['Vaults'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of vaults',
      content: { 'application/json': { schema: z.array(VaultSchema) } },
    },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/vaults',
  summary: 'Create a new vault',
  tags: ['Vaults'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': { schema: createVaultSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Vault created',
      content: { 'application/json': { schema: z.any() } },
    },
  },
})

// Milestones
registry.registerPath({
  method: 'get',
  path: '/api/vaults/{vaultId}/milestones',
  summary: 'Get milestones for a vault',
  tags: ['Milestones'],
  parameters: [
    {
      name: 'vaultId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: {
      description: 'List of milestones',
      content: {
        'application/json': {
          schema: z.object({ milestones: z.array(MilestoneSchema) }),
        },
      },
    },
  },
})

// Jobs
registry.registerPath({
  method: 'post',
  path: '/api/jobs/enqueue',
  summary: 'Enqueue a background job',
  tags: ['Jobs'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            type: z.string(),
            payload: z.any(),
            delayMs: z.number().optional(),
            maxAttempts: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: 'Job enqueued',
      content: { 'application/json': { schema: z.any() } },
    },
  },
})

// Analytics
registry.registerPath({
  method: 'get',
  path: '/api/analytics/summary',
  summary: 'Get analytics summary',
  tags: ['Analytics'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Analytics summary',
      content: { 'application/json': { schema: z.any() } },
    },
  },
})

// ==================== JOBS ROUTES ====================

// GET /api/jobs/metrics
registry.registerPath({
  method: 'get',
  path: '/api/jobs/metrics',
  summary: 'Get queue metrics',
  tags: ['Jobs'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Queue metrics',
      content: {
        'application/json': {
          schema: z.object({
            running: z.boolean(),
            queueDepth: z.number(),
            delayedJobs: z.number(),
            activeJobs: z.number(),
            totals: z.object({
              executions: z.number(),
              failed: z.number(),
            }),
          }),
        },
      },
    },
  },
})

// GET /api/jobs/deadletters
registry.registerPath({
  method: 'get',
  path: '/api/jobs/deadletters',
  summary: 'List dead-letter jobs',
  tags: ['Jobs'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of dead-letter jobs',
      content: {
        'application/json': {
          schema: z.object({
            deadLetters: z.array(z.any()),
          }),
        },
      },
    },
  },
})

// GET /api/jobs/deadletters/:id
registry.registerPath({
  method: 'get',
  path: '/api/jobs/deadletters/{id}',
  summary: 'Get a dead-letter job by ID',
  tags: ['Jobs'],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Dead-letter job details' },
    404: { description: 'Job not found' },
  },
})

// POST /api/jobs/deadletters/:id/replay
registry.registerPath({
  method: 'post',
  path: '/api/jobs/deadletters/{id}/replay',
  summary: 'Replay a dead-letter job',
  tags: ['Jobs'],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    202: { description: 'Job replayed' },
    404: { description: 'Job not found' },
  },
})

// GET /api/jobs/health
registry.registerPath({
  method: 'get',
  path: '/api/jobs/health',
  summary: 'Get queue health status',
  tags: ['Jobs'],
  responses: {
    200: {
      description: 'Queue health',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['ok', 'degraded', 'down']),
            timestamp: z.string().datetime(),
            queue: z.object({
              running: z.boolean(),
              queueDepth: z.number(),
              delayedJobs: z.number(),
              activeJobs: z.number(),
              failureRate: z.number(),
            }),
          }),
        },
      },
    },
  },
})

// ==================== TRANSACTIONS ROUTES ====================

// GET /api/transactions
registry.registerPath({
  method: 'get',
  path: '/api/transactions',
  summary: 'Get user transaction history',
  tags: ['Transactions'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'type', in: 'query', schema: { type: 'string' } },
    { name: 'vault_id', in: 'query', schema: { type: 'string' } },
    { name: 'date_from', in: 'query', schema: { type: 'string', format: 'date' } },
    { name: 'date_to', in: 'query', schema: { type: 'string', format: 'date' } },
    { name: 'amount_min', in: 'query', schema: { type: 'string' } },
    { name: 'amount_max', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
  ],
  responses: {
    200: {
      description: 'Transaction list',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(z.any()),
            pagination: z.object({
              limit: z.number(),
              cursor: z.string().optional(),
              next_cursor: z.string().optional(),
              has_more: z.boolean(),
              count: z.number(),
            }),
          }),
        },
      },
    },
  },
})

// GET /api/transactions/:id
registry.registerPath({
  method: 'get',
  path: '/api/transactions/{id}',
  summary: 'Get transaction by ID',
  tags: ['Transactions'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Transaction details' },
    404: { description: 'Transaction not found' },
  },
})

// GET /api/transactions/vault/:vaultId
registry.registerPath({
  method: 'get',
  path: '/api/transactions/vault/{vaultId}',
  summary: 'Get transactions for a vault',
  tags: ['Transactions'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'vaultId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Vault transactions' },
    404: { description: 'Vault not found' },
  },
})

// ==================== ANALYTICS ROUTES (Missing) ====================

// GET /api/analytics/vaults
registry.registerPath({
  method: 'get',
  path: '/api/analytics/vaults',
  summary: 'Get vault analytics',
  tags: ['Analytics'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Vault analytics',
      content: {
        'application/json': {
          schema: z.object({
            vaults: z.array(z.any()),
            generatedAt: z.string().datetime(),
          }),
        },
      },
    },
  },
})

// GET /api/analytics/vaults/:id
registry.registerPath({
  method: 'get',
  path: '/api/analytics/vaults/{id}',
  summary: 'Get vault analytics by ID',
  tags: ['Analytics'],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Vault analytics' },
  },
})

// GET /api/analytics/milestones/trends
registry.registerPath({
  method: 'get',
  path: '/api/analytics/milestones/trends',
  summary: 'Get milestone trends',
  tags: ['Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
    { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
    { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week'] } },
  ],
  responses: {
    200: {
      description: 'Milestone trends',
      content: {
        'application/json': {
          schema: z.object({
            from: z.string().datetime(),
            to: z.string().datetime(),
            groupBy: z.enum(['day', 'week']),
            buckets: z.array(z.any()),
          }),
        },
      },
    },
  },
})

// GET /api/analytics/behavior
registry.registerPath({
  method: 'get',
  path: '/api/analytics/behavior',
  summary: 'Get user behavior analytics',
  tags: ['Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
    { name: 'baseScorePerSuccess', in: 'query', schema: { type: 'integer', default: 10 } },
    { name: 'penaltyPerFailure', in: 'query', schema: { type: 'integer', default: 5 } },
    { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
    { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
  ],
  responses: {
    200: {
      description: 'User behavior score',
      content: {
        'application/json': {
          schema: z.object({
            userId: z.string(),
            successes: z.number(),
            failures: z.number(),
            behaviorScore: z.number(),
            evaluatedFrom: z.string().datetime().nullable(),
            evaluatedTo: z.string().datetime().nullable(),
          }),
        },
      },
    },
  },
})

// ==================== ADMIN ROUTES ====================

// GET /api/admin/users
registry.registerPath({
  method: 'get',
  path: '/api/admin/users',
  summary: 'List all users (admin)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'role', in: 'query', schema: { type: 'string', enum: ['USER', 'VERIFIER', 'ADMIN'] } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] } },
    { name: 'search', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
    { name: 'includeDeleted', in: 'query', schema: { type: 'boolean', default: false } },
  ],
  responses: {
    200: { description: 'List of users' },
  },
})

// PATCH /api/admin/users/:id/role
registry.registerPath({
  method: 'patch',
  path: '/api/admin/users/{id}/role',
  summary: 'Update user role',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: z.object({
          role: z.enum(['USER', 'VERIFIER', 'ADMIN']),
        }),
      },
    },
  },
  responses: {
    200: { description: 'Role updated' },
    400: { description: 'Invalid role' },
    404: { description: 'User not found' },
  },
})

// PATCH /api/admin/users/:id/status
registry.registerPath({
  method: 'patch',
  path: '/api/admin/users/{id}/status',
  summary: 'Update user status',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: z.object({
          status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
        }),
      },
    },
  },
  responses: {
    200: { description: 'Status updated' },
    404: { description: 'User not found' },
  },
})

// DELETE /api/admin/users/:id
registry.registerPath({
  method: 'delete',
  path: '/api/admin/users/{id}',
  summary: 'Delete user (soft or hard)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
    { name: 'hard', in: 'query', schema: { type: 'boolean', default: false } },
  ],
  responses: {
    200: { description: 'User deleted' },
    400: { description: 'Cannot delete own account' },
    404: { description: 'User not found' },
  },
})

// POST /api/admin/users/:id/restore
registry.registerPath({
  method: 'post',
  path: '/api/admin/users/{id}/restore',
  summary: 'Restore a soft-deleted user',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'User restored' },
    400: { description: 'User not deleted' },
    404: { description: 'User not found' },
  },
})

// POST /api/admin/users/:userId/revoke-sessions
registry.registerPath({
  method: 'post',
  path: '/api/admin/users/{userId}/revoke-sessions',
  summary: 'Revoke all user sessions',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'userId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Sessions revoked' },
  },
})

// GET /api/admin/audit-logs
registry.registerPath({
  method: 'get',
  path: '/api/admin/audit-logs',
  summary: 'List audit logs',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'actor_user_id', in: 'query', schema: { type: 'string' } },
    { name: 'action', in: 'query', schema: { type: 'string' } },
    { name: 'target_type', in: 'query', schema: { type: 'string' } },
    { name: 'target_id', in: 'query', schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
  ],
  responses: {
    200: {
      description: 'Audit logs',
      content: {
        'application/json': {
          schema: z.object({
            audit_logs: z.array(z.any()),
            count: z.number(),
            total: z.number(),
            limit: z.number().optional(),
            offset: z.number(),
            has_more: z.boolean(),
          }),
        },
      },
    },
  },
})

// GET /api/admin/audit-logs/:id
registry.registerPath({
  method: 'get',
  path: '/api/admin/audit-logs/{id}',
  summary: 'Get audit log by ID',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  responses: {
    200: { description: 'Audit log details' },
    404: { description: 'Not found' },
  },
})

// POST /api/admin/overrides/vaults/:id/cancel
registry.registerPath({
  method: 'post',
  path: '/api/admin/overrides/vaults/{id}/cancel',
  summary: 'Admin override to cancel a vault',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    },
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: z.object({
          reasonCode: z.enum([
            'USER_REQUEST',
            'FRAUD_DETECTED',
            'SYSTEM_ERROR',
            'POLICY_VIOLATION',
            'EMERGENCY_ADMIN_ACTION',
            'COMPLIANCE_REQUIREMENT',
            'TESTING_CLEANUP',
          ]),
          reason: z.string().optional(),
          idempotencyKey: z.string().optional(),
          details: z.string().optional(),
        }),
      },
    },
  },
  responses: {
    200: { description: 'Vault cancelled' },
    400: { description: 'Invalid reason code' },
    404: { description: 'Vault not found' },
    409: { description: 'Vault already cancelled or not cancellable' },
  },
})

// GET /api/admin/db/metrics
registry.registerPath({
  method: 'get',
  path: '/api/admin/db/metrics',
  summary: 'Get database pool metrics',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Database metrics',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              timestamp: z.string().datetime(),
              isHealthy: z.boolean(),
              pool: z.object({
                available: z.number(),
                waiting: z.number(),
                total: z.number(),
                capacity: z.number(),
              }),
              slowQueries: z.array(z.any()),
              warnings: z.array(z.string()),
            }),
          }),
        },
      },
    },
  },
})


export function generateOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Disciplr API',
      version: '0.1.0',
      description: 'API documentation for Disciplr backend',
    },
    servers: [{ url: '/api' }],
  })
}
