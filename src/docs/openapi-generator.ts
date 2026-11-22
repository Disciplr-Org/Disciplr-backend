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
const PaginationCursor = registry.register('PaginationCursor', z.object({
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


// ==================== NOTIFICATION SCHEMAS ====================

export const NotificationSchema = registry.register(
  'Notification',
  z.object({
    id: z.string().uuid().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
    user_id: z.string().openapi({ example: 'user_123' }),
    type: z.string().openapi({ example: 'vault_failure' }),
    title: z.string().openapi({ example: 'Vault deadline missed' }),
    message: z.string().openapi({ example: 'The deadline for vault 123 has expired.' }),
    data: z.record(z.string(), z.unknown()).nullable().openapi({ example: { vaultId: '123' } }),
    idempotency_key: z.string().nullable().openapi({ example: 'key_123' }),
    read_at: z.string().datetime().nullable().openapi({ example: '2026-06-02T10:00:00Z' }),
    archived_at: z.string().datetime().nullable().openapi({ example: null }),
    created_at: z.string().datetime().openapi({ example: '2026-06-02T09:00:00Z' }),
  }),
)

export const NotificationListResponseSchema = registry.register(
  'NotificationListResponse',
  z.object({
    data: z.array(NotificationSchema),
    pagination: PaginationCursor,
  }),
)

export const UserNotificationPreferencesSchema = registry.register(
  'UserNotificationPreferences',
  z.object({
    id: z.string().nullable().openapi({ example: 'pref_123' }),
    user_id: z.string().openapi({ example: 'user_123' }),
    timezone: z.string().openapi({ description: 'IANA timezone identifier', example: 'UTC' }),
    quiet_hours_enabled: z.boolean().openapi({ description: 'Whether quiet hours are enabled', example: false }),
    quiet_hours_start: z.string().openapi({ description: 'Quiet hours start in HH:MM format', example: '22:00' }),
    quiet_hours_end: z.string().openapi({ description: 'Quiet hours end in HH:MM format', example: '08:00' }),
    created_at: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
    updated_at: z.string().datetime().openapi({ example: '2026-06-02T10:00:00Z' }),
  }),
)

export const UpdateUserNotificationPreferencesSchema = registry.register(
  'UpdateUserNotificationPreferences',
  z.object({
    timezone: z.string().optional().openapi({ description: 'Valid IANA timezone identifier', example: 'America/New_York' }),
    quiet_hours_enabled: z.boolean().optional().openapi({ description: 'Whether quiet hours are enabled', example: true }),
    quiet_hours_start: z.string().optional().openapi({ description: 'Quiet hours start in HH:MM format', example: '22:00' }),
    quiet_hours_end: z.string().optional().openapi({ description: 'Quiet hours end in HH:MM format', example: '08:00' }),
  }),
)

export const OrgNotificationPreferencesSchema = registry.register(
  'OrgNotificationPreferences',
  z.object({
    organizationId: z.string().openapi({ example: 'org_123' }),
    categories: z.record(z.string(), z.boolean()).openapi({
      example: {
        vault_failure: true,
        milestone_reminder: true,
        milestone_reminder_deferred: true,
        milestone_reminder_processed: true,
        milestone_digest: true,
      },
    }),
    channels: z.record(z.string(), z.boolean()).openapi({
      example: {
        email: true,
      },
    }),
  }),
)

export const UpdateOrgNotificationPreferencesSchema = registry.register(
  'UpdateOrgNotificationPreferences',
  z.object({
    categories: z.record(z.string(), z.boolean()).optional().openapi({
      description: 'Map of notification category to enabled flag',
      example: { vault_failure: true, milestone_reminder: false },
    }),
    channels: z.record(z.string(), z.boolean()).optional().openapi({
      description: 'Map of delivery channel to enabled flag',
      example: { email: true },
    }),
  }),
)

// ==================== NOTIFICATION ROUTES ====================

// GET /api/notifications
registry.registerPath({
  method: 'get',
  path: '/api/notifications',
  operationId: 'listNotifications',
  summary: 'List user notifications',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      status: z.enum(['all', 'read', 'unread']).optional().openapi({ description: 'Filter by read status', example: 'all' }),
      includeArchived: z.string().optional().openapi({ description: 'Include archived notifications (true/1)', example: 'false' }),
      limit: z.coerce.number().optional().openapi({ description: 'Number of notifications to return', example: 20 }),
      cursor: z.string().optional().openapi({ description: 'Pagination cursor', example: 'cur_abc123' }),
    }),
  },
  responses: {
    200: {
      description: 'List of notifications with pagination cursor',
      content: { 'application/json': { schema: NotificationListResponseSchema } },
    },
    400: {
      description: 'Bad request (invalid status or cursor)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// PATCH /api/notifications/:id/read
registry.registerPath({
  method: 'patch',
  path: '/api/notifications/{id}/read',
  operationId: 'markNotificationAsRead',
  summary: 'Mark a notification as read',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Notification ID',
    },
  ],
  responses: {
    200: {
      description: 'Notification marked as read',
      content: { 'application/json': { schema: NotificationSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    404: {
      description: 'Notification not found',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// POST /api/notifications/read-all
registry.registerPath({
  method: 'post',
  path: '/api/notifications/read-all',
  operationId: 'markAllNotificationsAsRead',
  summary: 'Mark all notifications as read',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'All notifications marked as read',
      content: {
        'application/json': {
          schema: z.object({
            updated: z.number().openapi({ description: 'Number of notifications marked as read', example: 5 }),
          }),
        },
      },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/users/me/notification-preferences
registry.registerPath({
  method: 'get',
  path: '/api/users/me/notification-preferences',
  operationId: 'getUserNotificationPreferences',
  summary: 'Get user notification preferences',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Current user notification preferences',
      content: { 'application/json': { schema: UserNotificationPreferencesSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// PUT /api/users/me/notification-preferences
registry.registerPath({
  method: 'put',
  path: '/api/users/me/notification-preferences',
  operationId: 'updateUserNotificationPreferences',
  summary: 'Update user notification preferences',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateUserNotificationPreferencesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated user notification preferences',
      content: { 'application/json': { schema: UserNotificationPreferencesSchema } },
    },
    400: {
      description: 'Bad request (invalid timezone or time format)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// DELETE /api/users/me/notification-preferences
registry.registerPath({
  method: 'delete',
  path: '/api/users/me/notification-preferences',
  operationId: 'resetUserNotificationPreferences',
  summary: 'Reset user notification preferences to defaults',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Default user notification preferences',
      content: { 'application/json': { schema: UserNotificationPreferencesSchema } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
})

// GET /api/orgs/:orgId/notification-preferences
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/notification-preferences',
  operationId: 'getOrgNotificationPreferences',
  summary: 'Get organization notification preferences',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'orgId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Organization ID',
    },
  ],
  responses: {
    200: {
      description: 'Organization notification preferences',
      content: { 'application/json': { schema: OrgNotificationPreferencesSchema } },
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

// PUT /api/orgs/:orgId/notification-preferences
registry.registerPath({
  method: 'put',
  path: '/api/orgs/{orgId}/notification-preferences',
  operationId: 'updateOrgNotificationPreferences',
  summary: 'Update organization notification preferences',
  tags: ['Notifications'],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      name: 'orgId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Organization ID',
    },
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateOrgNotificationPreferencesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated organization notification preferences',
      content: { 'application/json': { schema: OrgNotificationPreferencesSchema } },
    },
    400: {
      description: 'Bad request (invalid category or channel)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    403: {
      description: 'Forbidden (owner or admin required)',
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
