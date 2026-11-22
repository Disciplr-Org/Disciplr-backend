import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { registerSchema, loginSchema } from '../lib/validation.js'

extendZodWithOpenApi(z)

// ==================== EXPORT SCHEMAS ====================

export const ExportRequestSchema = z.object({
  format: z.enum(['csv', 'json']).openapi({ description: 'Output format for the export', example: 'json' }),
  scope: z.enum(['vaults', 'transactions', 'analytics', 'all']).openapi({ description: 'Data scope for the export', example: 'all' }),
  targetUserId: z.string().optional().openapi({ description: 'Target user ID (admin-only exports)', example: 'user_123' }),
}).openapi('ExportRequest')

export const ExportJobResponseSchema = z.object({
  jobId: z.string().openapi({ description: 'Export job identifier', example: 'job_abc123' }),
  statusUrl: z.string().openapi({ description: 'URL to poll for job status', example: '/api/exports/status/job_abc123' }),
  pollIntervalMs: z.number().openapi({ description: 'Recommended polling interval in milliseconds', example: 1000 }),
}).openapi('ExportJobResponse')

export const ExportJobStatusSchema = z.object({
  jobId: z.string().openapi({ example: 'job_abc123' }),
  status: z.enum(['pending', 'running', 'done', 'failed']).openapi({ example: 'done' }),
  attempts: z.number().openapi({ example: 1 }),
  maxAttempts: z.number().openapi({ example: 3 }),
  completedAt: z.string().datetime().optional().openapi({ example: '2026-06-02T10:00:00Z' }),
  downloadUrl: z.string().optional().openapi({ description: 'Download URL (present when status is done)', example: '/api/exports/download/token_xyz' }),
  expiresInSeconds: z.number().optional().openapi({ example: 3600 }),
  error: z.string().optional().openapi({ description: 'Error message if status is failed' }),
}).openapi('ExportJobStatus')

export const registry = new OpenAPIRegistry()

// --- Security Schemes ---
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
})

// --- Shared Schemas ---
export const PaginationCursor = registry.register('PaginationCursor', z.object({
  limit: z.number(),
  cursor: z.string().optional(),
  next_cursor: z.string().optional(),
  has_more: z.boolean(),
  count: z.number(),
}))

const ErrorEnvelope = registry.register('ErrorEnvelope', z.object({
  error: z.object({
    code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
    message: z.string().openapi({ example: 'Invalid request parameters' }),
    details: z.unknown().optional(),
    requestId: z.string().optional().openapi({ example: 'req_123' }),
  }),
}))

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
            service: z.string(),
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
    400: { description: 'Bad request', content: { 'application/json': { schema: z.any() } } },
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
    401: { description: 'Unauthorized', content: { 'application/json': { schema: z.any() } } },
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
      description: 'Paginated list of vaults',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(VaultSchema),
            pagination: z.any(),
          }),
        },
      },
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
        'application/json': {
          schema: z.object({
            creator: z.string(),
            amount: z.string(),
            endTimestamp: z.string().datetime(),
            successDestination: z.string(),
            failureDestination: z.string(),
            milestones: z.array(z.object({ description: z.string() })).optional(),
          }),
        },
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
            pagination: z.any(),
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
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            role: z.enum(['USER', 'VERIFIER', 'ADMIN']),
          }),
        },
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
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']),
          }),
        },
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
  request: {
    body: {
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
  },
  responses: {
    200: { description: 'Vault cancelled' },
    400: { description: 'Invalid reason code' },
    404: { description: 'Vault not found' },
    409: { description: 'Vault already cancelled or not cancellable' },
  },
})

// ==================== EXPORT ROUTES ====================

export const ExportRequestRef = registry.register('ExportRequest', ExportRequestSchema)
export const ExportJobResponseRef = registry.register('ExportJobResponse', ExportJobResponseSchema)
export const ExportJobStatusRef = registry.register('ExportJobStatus', ExportJobStatusSchema)

// POST /api/exports/me
registry.registerPath({
  method: 'post',
  path: '/api/exports/me',
  summary: 'Enqueue a personal data export job',
  tags: ['Exports'],
  security: [{ bearerAuth: [] }],
  request: {
    query: ExportRequestSchema.pick({ format: true, scope: true }),
  },
  responses: {
    202: {
      description: 'Export job enqueued',
      content: { 'application/json': { schema: ExportJobResponseRef } },
    },
    400: { description: 'Invalid format or scope', content: { 'application/json': { schema: z.any() } } },
    429: { description: 'Export quota exceeded' },
    409: { description: 'Idempotency key conflict' },
  },
})

// POST /api/exports/admin
registry.registerPath({
  method: 'post',
  path: '/api/exports/admin',
  summary: 'Enqueue an admin export job (all users or target user)',
  tags: ['Exports'],
  security: [{ bearerAuth: [] }],
  request: {
    query: ExportRequestSchema,
  },
  responses: {
    202: {
      description: 'Export job enqueued',
      content: { 'application/json': { schema: ExportJobResponseRef } },
    },
    400: { description: 'Invalid format or scope', content: { 'application/json': { schema: z.any() } } },
    403: { description: 'Admin access required' },
    429: { description: 'Export quota exceeded' },
    409: { description: 'Idempotency key conflict' },
  },
})

// GET /api/exports/status/:jobId
registry.registerPath({
  method: 'get',
  path: '/api/exports/status/{jobId}',
  summary: 'Poll export job status',
  tags: ['Exports'],
  security: [{ bearerAuth: [] }],
  parameters: [
    { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
  ],
  responses: {
    200: {
      description: 'Export job status',
      content: { 'application/json': { schema: ExportJobStatusRef } },
    },
    403: { description: 'Access denied' },
    404: { description: 'Job not found' },
  },
})

// GET /api/exports/download/:token
registry.registerPath({
  method: 'get',
  path: '/api/exports/download/{token}',
  summary: 'Download completed export file',
  tags: ['Exports'],
  parameters: [
    { name: 'token', in: 'path', required: true, schema: { type: 'string' }, description: 'Signed download token from status response' },
  ],
  responses: {
    200: {
      description: 'Export file content',
      content: {
        'application/json': { schema: z.any() },
        'text/csv': { schema: z.any() },
      },
    },
    401: { description: 'Invalid or expired download token' },
    404: { description: 'Export not ready or not found' },
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


// ==================== WEBHOOK SCHEMAS ====================

export const WebhookSubscriptionSchema = registry.register(
  'WebhookSubscription',
  z.object({
    id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    url: z.string().url().openapi({ example: 'https://example.com/webhook' }),
    events: z.array(z.string()).openapi({ example: ['vault.created', 'vault.completed'] }),
    active: z.boolean().openapi({ example: true }),
    orgId: z.string().optional().openapi({ example: 'org_123' }),
    createdAt: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
  }),
)

export const CreateWebhookRequestSchema = registry.register(
  'CreateWebhookRequest',
  z.object({
    url: z.string().url().openapi({ example: 'https://example.com/webhook' }),
    events: z.array(z.string()).min(1).openapi({ example: ['vault.created', 'vault.completed'] }),
    active: z.boolean().optional().default(true).openapi({ example: true }),
  }),
)

export const CreateWebhookResponseSchema = registry.register(
  'CreateWebhookResponse',
  z.object({
    secret: z.string().openapi({ description: 'Generated webhook signing secret (only shown once)', example: 'a1b2c3d4e5f67890' }),
    subscription: WebhookSubscriptionSchema,
  }),
)

export const RotateWebhookSecretResponseSchema = registry.register(
  'RotateWebhookSecretResponse',
  z.object({
    secret: z.string().openapi({ description: 'New webhook signing secret', example: 'f6e5d4c3b2a10987' }),
    subscription: WebhookSubscriptionSchema,
  }),
)

export const WebhookDeadLetterSchema = registry.register(
  'WebhookDeadLetter',
  z.object({
    id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    subscriber_id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174001' }),
    event_id: z.string().openapi({ example: 'evt_123' }),
    event_type: z.string().openapi({ example: 'vault.failed' }),
    payload: z.record(z.string(), z.unknown()).openapi({ example: { vaultId: '123' } }),
    last_error: z.string().openapi({ example: 'HTTP 500: Internal Server Error' }),
    attempts: z.number().openapi({ example: 5 }),
    failed_at: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
    replayed_at: z.string().datetime().nullable().openapi({ example: null }),
  }),
)

export const FieldPolicySchema = registry.register(
  'FieldPolicy',
  z.object({
    mode: z.enum(['default', 'allowlist', 'denylist']).openapi({ example: 'default' }),
    fields: z.array(z.string()).openapi({ example: ['email', 'address'] }),
    stripPii: z.boolean().openapi({ example: true }),
  }),
)

export const AdminWebhookSubscriberSchema = registry.register(
  'AdminWebhookSubscriber',
  z.object({
    id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    organization_id: z.string().openapi({ example: 'org_123' }),
    url: z.string().url().openapi({ example: 'https://example.com/webhook' }),
    events: z.array(z.string()).openapi({ example: ['vault.created'] }),
    active: z.boolean().openapi({ example: true }),
    created_at: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
    rotated_at: z.string().datetime().nullable().optional().openapi({ example: null }),
    field_policy: FieldPolicySchema.optional(),
  }),
)

export const EgressAllowlistEntrySchema = registry.register(
  'EgressAllowlistEntry',
  z.object({
    id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    organizationId: z.string().openapi({ example: 'org_123' }),
    host: z.string().openapi({ example: 'api.example.com' }),
    createdAt: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
  }),
)

export const SubscriberDeliveryStatsSchema = registry.register(
  'SubscriberDeliveryStats',
  z.object({
    subscriber_id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    window: z.string().openapi({ example: '24h' }),
    window_start: z.string().datetime().openapi({ example: '2026-06-01T10:00:00Z' }),
    window_end: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
    attempt_count: z.number().openapi({ example: 120 }),
    success_count: z.number().openapi({ example: 118 }),
    failure_count: z.number().openapi({ example: 2 }),
    success_rate: z.number().openapi({ example: 0.9833 }),
    p50_latency_ms: z.number().nullable().openapi({ example: 45 }),
    p95_latency_ms: z.number().nullable().openapi({ example: 120 }),
    last_failure_reason: z.string().nullable().openapi({ example: 'ETIMEDOUT' }),
    breaker_state: z.string().nullable().openapi({ example: 'CLOSED' }),
  }),
)

// ==================== WEBHOOK ROUTES ====================

// POST /api/webhooks
registry.registerPath({
  method: 'post',
  path: '/api/webhooks',
  operationId: 'createWebhookSubscription',
  summary: 'Create a webhook subscription for an organization',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      orgId: z.string().openapi({ description: 'Organization ID', example: 'org_123' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateWebhookRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Webhook subscription created',
      content: { 'application/json': { schema: CreateWebhookResponseSchema } },
    },
    400: {
      description: 'Bad request (missing orgId or invalid body)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (member access required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    422: {
      description: 'Unprocessable entity (URL not permitted by egress policy)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/webhooks
registry.registerPath({
  method: 'get',
  path: '/api/webhooks',
  operationId: 'listWebhookSubscriptions',
  summary: 'List webhook subscriptions for an organization',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      orgId: z.string().openapi({ description: 'Organization ID', example: 'org_123' }),
    }),
  },
  responses: {
    200: {
      description: 'List of webhook subscriptions',
      content: {
        'application/json': {
          schema: z.object({
            subscriptions: z.array(WebhookSubscriptionSchema),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (missing orgId)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (member access required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/webhooks/:id
registry.registerPath({
  method: 'get',
  path: '/api/webhooks/{id}',
  operationId: 'getWebhookSubscription',
  summary: 'Get a webhook subscription by ID',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Webhook subscription ID (UUID)',
    },
    {
      name: 'orgId',
      in: 'query',
      required: true,
      schema: { type: 'string' },
      description: 'Organization ID',
    },
  ],
  responses: {
    200: {
      description: 'Webhook subscription details',
      content: {
        'application/json': {
          schema: z.object({
            subscription: WebhookSubscriptionSchema,
          }),
        },
      },
    },
    400: {
      description: 'Bad request (invalid ID format or missing orgId)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (member access required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Webhook subscription not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/webhooks/:id/rotate-secret
registry.registerPath({
  method: 'post',
  path: '/api/webhooks/{id}/rotate-secret',
  operationId: 'rotateWebhookSecret',
  summary: 'Rotate signing secret for a webhook subscription',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Webhook subscription ID (UUID)',
    },
    {
      name: 'orgId',
      in: 'query',
      required: true,
      schema: { type: 'string' },
      description: 'Organization ID',
    },
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({}).openapi({ description: 'Empty body expected' }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Webhook secret rotated successfully',
      content: { 'application/json': { schema: RotateWebhookSecretResponseSchema } },
    },
    400: {
      description: 'Bad request (invalid ID format or missing orgId)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (member access required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Webhook subscription not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// DELETE /api/webhooks/:id
registry.registerPath({
  method: 'delete',
  path: '/api/webhooks/{id}',
  operationId: 'deleteWebhookSubscription',
  summary: 'Delete a webhook subscription',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Webhook subscription ID (UUID)',
    },
    {
      name: 'orgId',
      in: 'query',
      required: true,
      schema: { type: 'string' },
      description: 'Organization ID',
    },
  ],
  responses: {
    200: {
      description: 'Webhook subscription deleted',
      content: {
        'application/json': {
          schema: z.object({
            deleted: z.boolean().openapi({ example: true }),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (invalid ID format or missing orgId)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (member access required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Webhook subscription not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/admin/webhooks/dead-letters
registry.registerPath({
  method: 'get',
  path: '/api/admin/webhooks/dead-letters',
  operationId: 'listWebhookDeadLetters',
  summary: 'List webhook dead-letter queue entries (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().optional().openapi({ example: 50, default: 50 }),
      offset: z.coerce.number().optional().openapi({ example: 0, default: 0 }),
      subscriber_id: z.string().optional().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    }),
  },
  responses: {
    200: {
      description: 'List of dead-letter deliveries',
      content: {
        'application/json': {
          schema: z.object({
            webhook_dead_letters: z.array(WebhookDeadLetterSchema),
            count: z.number().openapi({ example: 10 }),
            total: z.number().openapi({ example: 25 }),
            limit: z.number().openapi({ example: 50 }),
            offset: z.number().openapi({ example: 0 }),
            has_more: z.boolean().openapi({ example: false }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/dead-letters/:id/replay
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/dead-letters/{id}/replay',
  operationId: 'replayWebhookDeadLetter',
  summary: 'Replay a specific dead-letter webhook delivery (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Dead letter entry ID',
    },
  ],
  responses: {
    202: {
      description: 'Dead letter replayed',
      content: {
        'application/json': {
          schema: z.object({
            replayed: z.boolean().openapi({ example: true }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Dead letter not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/subscribers
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/subscribers',
  operationId: 'upsertAdminWebhookSubscriber',
  summary: 'Idempotently register or update a subscriber (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: z.string().openapi({ example: 'org_123' }),
            url: z.string().url().openapi({ example: 'https://example.com/webhook' }),
            secret: z.string().openapi({ example: 'sec_123' }),
            events: z.array(z.string()).optional().openapi({ example: ['vault.created'] }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Webhook subscriber registered or updated',
      content: { 'application/json': { schema: AdminWebhookSubscriberSchema } },
    },
    400: {
      description: 'Bad request (missing required fields)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    422: {
      description: 'Unprocessable entity (URL not permitted by egress policy)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/admin/webhooks/subscribers
registry.registerPath({
  method: 'get',
  path: '/api/admin/webhooks/subscribers',
  operationId: 'listAdminWebhookSubscribers',
  summary: 'List active subscribers for an organization (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      organization_id: z.string().openapi({ example: 'org_123' }),
    }),
  },
  responses: {
    200: {
      description: 'List of active subscribers',
      content: {
        'application/json': {
          schema: z.object({
            subscribers: z.array(AdminWebhookSubscriberSchema),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (missing organization_id)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/subscribers/:id/rotate-secret
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/subscribers/{id}/rotate-secret',
  operationId: 'rotateAdminWebhookSubscriberSecret',
  summary: 'Rotate signing secret for a subscriber with grace window (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Subscriber ID',
    },
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: z.string().openapi({ example: 'org_123' }),
            new_secret: z.string().openapi({ example: 'new_sec_123' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Secret rotated successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
            rotated_at: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (missing organization_id or new_secret)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Subscriber not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/admin/webhooks/pause/status
registry.registerPath({
  method: 'get',
  path: '/api/admin/webhooks/pause/status',
  operationId: 'getWebhookPauseStatus',
  summary: 'Get current webhook delivery pause status (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Current delivery pause status',
      content: {
        'application/json': {
          schema: z.object({
            paused: z.boolean().openapi({ example: false }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/pause
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/pause',
  operationId: 'pauseWebhookDelivery',
  summary: 'Halt all outbound webhook delivery (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Webhook delivery paused',
      content: {
        'application/json': {
          schema: z.object({
            paused: z.literal(true).openapi({ example: true }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/resume
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/resume',
  operationId: 'resumeWebhookDelivery',
  summary: 'Resume all outbound webhook delivery (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Webhook delivery resumed',
      content: {
        'application/json': {
          schema: z.object({
            paused: z.literal(false).openapi({ example: false }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/:id/replay
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/{id}/replay',
  operationId: 'replayWebhookWindow',
  summary: 'Replay dead-letter entries for a subscriber within a time window (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Subscriber ID',
    },
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            start_time: z.string().datetime().openapi({ example: '2026-06-01T00:00:00Z' }),
            end_time: z.string().datetime().openapi({ example: '2026-06-02T00:00:00Z' }),
            replay_marker: z.string().optional().openapi({ example: 'marker_abc' }),
            max_events: z.number().int().min(1).optional().openapi({ example: 500 }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Window replay executed',
      content: {
        'application/json': {
          schema: z.object({
            replayed: z.boolean().openapi({ example: true }),
            count: z.number().openapi({ example: 10 }),
            success_count: z.number().openapi({ example: 10 }),
            failure_count: z.number().openapi({ example: 0 }),
            replay_marker: z.string().optional().openapi({ example: 'marker_abc' }),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (invalid timestamps or params)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Subscriber not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/admin/webhooks/egress-allowlist
registry.registerPath({
  method: 'get',
  path: '/api/admin/webhooks/egress-allowlist',
  operationId: 'listEgressAllowlist',
  summary: 'List egress allowlist entries for an organization (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      organization_id: z.string().openapi({ example: 'org_123' }),
    }),
  },
  responses: {
    200: {
      description: 'List of egress allowlist entries',
      content: {
        'application/json': {
          schema: z.object({
            egress_allowlist: z.array(EgressAllowlistEntrySchema),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (missing organization_id)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/admin/webhooks/egress-allowlist
registry.registerPath({
  method: 'post',
  path: '/api/admin/webhooks/egress-allowlist',
  operationId: 'addEgressAllowlistEntry',
  summary: 'Add host to an organization egress allowlist (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: z.string().openapi({ example: 'org_123' }),
            host: z.string().openapi({ example: 'api.example.com' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Egress allowlist entry created',
      content: { 'application/json': { schema: EgressAllowlistEntrySchema } },
    },
    400: {
      description: 'Bad request (missing organization_id or host)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// DELETE /api/admin/webhooks/egress-allowlist
registry.registerPath({
  method: 'delete',
  path: '/api/admin/webhooks/egress-allowlist',
  operationId: 'removeEgressAllowlistEntry',
  summary: 'Remove host from an organization egress allowlist (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: z.string().openapi({ example: 'org_123' }),
            host: z.string().openapi({ example: 'api.example.com' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Egress allowlist entry removed',
      content: {
        'application/json': {
          schema: z.object({
            removed: z.boolean().openapi({ example: true }),
          }),
        },
      },
    },
    400: {
      description: 'Bad request (missing organization_id or host)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Entry not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/admin/webhooks/:id/stats
registry.registerPath({
  method: 'get',
  path: '/api/admin/webhooks/{id}/stats',
  operationId: 'getSubscriberDeliveryStats',
  summary: 'Get aggregated delivery analytics for a subscriber (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Subscriber ID',
    },
    {
      name: 'window',
      in: 'query',
      required: false,
      schema: { type: 'string', default: '24h' },
      description: 'Time window (e.g. 1h, 24h, 72h, 3d)',
    },
  ],
  responses: {
    200: {
      description: 'Subscriber delivery stats',
      content: { 'application/json': { schema: SubscriberDeliveryStatsSchema } },
    },
    400: {
      description: 'Bad request (invalid window parameter)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Subscriber not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// PATCH /api/admin/webhooks/subscribers/:id/field-policy
registry.registerPath({
  method: 'patch',
  path: '/api/admin/webhooks/subscribers/{id}/field-policy',
  operationId: 'updateSubscriberFieldPolicy',
  summary: 'Update field masking policy for a subscriber (admin)',
  tags: ['Webhooks'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Subscriber ID',
    },
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organization_id: z.string().openapi({ example: 'org_123' }),
            field_policy: FieldPolicySchema,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Field policy updated',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
            field_policy: FieldPolicySchema,
          }),
        },
      },
    },
    400: {
      description: 'Bad request (invalid organization_id or field_policy)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (admin required)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Subscriber not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
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
