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

// ==================== ADMIN VERIFIERS ROUTES ====================

const verifierStatusSchema = z
  .enum(['pending', 'approved', 'suspended', 'deactivated'])
  .openapi({
    description:
      'Verifier lifecycle status. Allowed transitions: pending→approved|deactivated, ' +
      'approved→suspended|deactivated, suspended→approved|deactivated, deactivated→pending|approved.',
    example: 'approved',
  })

const VerifierProfileSchema = registry.register(
  'VerifierProfile',
  z.object({
    userId: z.string().openapi({
      description: 'Stellar public key that identifies the verifier',
      example: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    }),
    displayName: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    status: verifierStatusSchema,
    createdAt: z.string().datetime(),
    approvedAt: z.string().datetime().nullable().optional(),
    suspendedAt: z.string().datetime().nullable().optional(),
    deactivatedAt: z.string().datetime().nullable().optional(),
  })
)

const VerifierStatsSchema = registry.register(
  'VerifierStats',
  z.object({
    totalVerifications: z.number().int().openapi({ example: 12 }),
    approvals: z.number().int().openapi({ example: 9 }),
    rejections: z.number().int().openapi({ example: 3 }),
    disputes: z.number().int().openapi({ example: 1 }),
    approvalRatio: z.number().openapi({ example: 0.75 }),
    rejectionRatio: z.number().openapi({ example: 0.25 }),
    disputeRate: z.number().openapi({ example: 0.0833 }),
  })
)

const VerifierWithStatsSchema = registry.register(
  'VerifierWithStats',
  z.object({
    profile: VerifierProfileSchema,
    stats: VerifierStatsSchema,
  })
)

const VerifierPaginationSchema = registry.register(
  'VerifierPagination',
  z.object({
    limit: z.number().int().openapi({ description: 'Page size in effect (max 200)', example: 50 }),
    offset: z.number().int().openapi({ description: 'Zero-based offset of the first item', example: 0 }),
    count: z.number().int().openapi({ description: 'Number of items in this page', example: 2 }),
    hasMore: z.boolean().openapi({ description: 'Whether another page is likely available', example: false }),
  })
)

const VerifierListResponseSchema = registry.register(
  'VerifierListResponse',
  z.object({
    verifiers: z.array(VerifierWithStatsSchema),
    pagination: VerifierPaginationSchema,
  })
)

const VerifierCreateResponseSchema = registry.register(
  'VerifierCreateResponse',
  z.object({
    profile: VerifierProfileSchema,
    stats: VerifierStatsSchema,
    auditLogId: z.string().optional().openapi({ description: 'Audit log entry id when one was written' }),
  })
)

const VerifierMutationResponseSchema = registry.register(
  'VerifierMutationResponse',
  z.object({
    profile: VerifierProfileSchema,
    stats: VerifierStatsSchema,
    auditLogId: z.string().nullable().openapi({
      description: 'Audit log entry id, or null when the request was a no-op',
    }),
    changedFields: z.array(z.string()).openapi({
      description: 'Profile fields changed by this request',
      example: ['status'],
    }),
  })
)

const CreateVerifierRequestSchema = registry.register(
  'CreateVerifierRequest',
  z.object({
    userId: z.string().min(1).openapi({
      description: 'Stellar public key of the verifier to create',
      example: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    }),
    displayName: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    status: verifierStatusSchema.optional(),
    reason: z.string().optional().openapi({ description: 'Reason recorded on the audit log entry' }),
  })
)

const UpdateVerifierRequestSchema = registry.register(
  'UpdateVerifierRequest',
  z.object({
    displayName: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    status: verifierStatusSchema.optional(),
    reason: z.string().optional().openapi({ description: 'Reason recorded on the audit log entry' }),
  })
)

const VerifierReasonRequestSchema = registry.register(
  'VerifierReasonRequest',
  z.object({
    reason: z.string().optional().openapi({ description: 'Reason recorded on the audit log entry' }),
  })
)

const VerifierErrorResponseSchema = registry.register(
  'VerifierErrorResponse',
  z.object({
    error: z.string().openapi({ example: 'verifier not found' }),
  })
)

// Route handlers respond with `{ error: string }`; errors handed to the global
// error handler (e.g. AppError.validation for an invalid Stellar key) use the
// shared ErrorEnvelope instead, so both shapes are documented for those codes.
const VerifierOrEnvelopeErrorSchema = z.union([
  ErrorEnvelope,
  VerifierErrorResponseSchema,
])

const verifierUserIdParameter = {
  name: 'userId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const },
  description: 'Verifier identifier (Stellar public key)',
}

const verifierSecurity = [{ bearerAuth: [] }]

const verifierErrorResponse = (
  description: string,
  schema: z.ZodTypeAny = VerifierErrorResponseSchema,
) => ({
  description,
  content: { 'application/json': { schema } },
})

const requestIdHeader = {
  'X-Request-Id': {
    description: 'Request correlation id; echoes the inbound x-request-id header when supplied',
    schema: { type: 'string' as const },
  },
}

// GET /api/admin/verifiers
registry.registerPath({
  method: 'get',
  path: '/api/admin/verifiers',
  operationId: 'adminListVerifiers',
  summary: 'List verifier profiles with aggregate stats',
  description:
    'Returns verifier profiles ordered by the underlying table order. `limit` is ' +
    'clamped to 200 and defaults to 50; invalid values fall back to the defaults.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  ],
  responses: {
    200: {
      description: 'Paginated verifier profiles with aggregate verification stats',
      content: { 'application/json': { schema: VerifierListResponseSchema } },
    },
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    500: verifierErrorResponse('Unexpected server error', VerifierOrEnvelopeErrorSchema),
  },
})

// GET /api/admin/verifiers/:userId
registry.registerPath({
  method: 'get',
  path: '/api/admin/verifiers/{userId}',
  operationId: 'adminGetVerifier',
  summary: 'Get a verifier profile and its stats',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  responses: {
    200: {
      description: 'Verifier profile and aggregate stats',
      content: { 'application/json': { schema: VerifierWithStatsSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    500: verifierErrorResponse('Unexpected server error', VerifierOrEnvelopeErrorSchema),
  },
})

// POST /api/admin/verifiers
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers',
  operationId: 'adminCreateVerifier',
  summary: 'Create a verifier profile',
  description:
    '`userId` must be a valid Stellar public key. When `status` is omitted the ' +
    'profile is created as `pending`. A unique-constraint violation returns 409.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  request: {
    body: { content: { 'application/json': { schema: CreateVerifierRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Verifier profile created',
      content: { 'application/json': { schema: VerifierCreateResponseSchema } },
    },
    400: verifierErrorResponse(
      'Missing userId, invalid Stellar public key, non-string displayName, non-object metadata or invalid status',
      VerifierOrEnvelopeErrorSchema,
    ),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    409: verifierErrorResponse('Verifier already exists'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// PATCH /api/admin/verifiers/:userId
registry.registerPath({
  method: 'patch',
  path: '/api/admin/verifiers/{userId}',
  operationId: 'adminUpdateVerifier',
  summary: 'Update a verifier profile',
  description:
    'Only the provided fields are updated. `displayName` and `metadata` accept ' +
    '`null` to clear them. Status changes follow the verifier transition matrix; ' +
    'an illegal transition returns 409.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: UpdateVerifierRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Updated verifier profile',
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Non-string displayName, non-object metadata or invalid status'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// DELETE /api/admin/verifiers/:userId
registry.registerPath({
  method: 'delete',
  path: '/api/admin/verifiers/{userId}',
  operationId: 'adminDeleteVerifier',
  summary: 'Delete a verifier profile',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: VerifierReasonRequestSchema } },
    },
  },
  responses: {
    204: { description: 'Verifier profile deleted; no content returned' },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// POST /api/admin/verifiers/:userId/approve
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers/{userId}/approve',
  operationId: 'adminApproveVerifier',
  summary: 'Approve a verifier',
  description:
    'Creates the verifier profile as `approved` when it does not exist yet, ' +
    'otherwise transitions the existing profile. A second in-flight transition ' +
    'for the same verifier returns 429.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: VerifierReasonRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Verifier approved',
      headers: requestIdHeader,
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    429: verifierErrorResponse('A concurrent transition for this verifier is already in progress'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// POST /api/admin/verifiers/:userId/suspend
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers/{userId}/suspend',
  operationId: 'adminSuspendVerifier',
  summary: 'Suspend a verifier',
  description:
    'Creates the verifier profile as `suspended` when it does not exist yet, ' +
    'otherwise transitions the existing profile. A second in-flight transition ' +
    'for the same verifier returns 429.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: VerifierReasonRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Verifier suspended',
      headers: requestIdHeader,
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    429: verifierErrorResponse('A concurrent transition for this verifier is already in progress'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// POST /api/admin/verifiers/:userId/reinstate
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers/{userId}/reinstate',
  operationId: 'adminReinstateVerifier',
  summary: 'Reinstate a suspended or deactivated verifier',
  description:
    'Restores a previously approved verifier to `approved`, otherwise to ' +
    '`pending`. Reinstating an already active (`approved`/`pending`) verifier ' +
    'is a no-op returning an empty `changedFields` and a `null` `auditLogId`.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: VerifierReasonRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Verifier reinstated (or already active)',
      headers: requestIdHeader,
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// POST /api/admin/verifiers/:userId/deactivate
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers/{userId}/deactivate',
  operationId: 'adminDeactivateVerifier',
  summary: 'Deactivate a verifier',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: VerifierReasonRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Verifier deactivated',
      headers: requestIdHeader,
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    500: verifierErrorResponse('Unexpected server error'),
  },
})

// POST /api/admin/verifiers/:userId/reactivate
registry.registerPath({
  method: 'post',
  path: '/api/admin/verifiers/{userId}/reactivate',
  operationId: 'adminReactivateVerifier',
  summary: 'Reactivate a deactivated verifier',
  description: 'Transitions a deactivated verifier back to `pending`, pending re-approval.',
  tags: ['Admin Verifiers'],
  security: verifierSecurity,
  parameters: [verifierUserIdParameter],
  request: {
    body: { content: { 'application/json': { schema: VerifierReasonRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Verifier reactivated as pending',
      headers: requestIdHeader,
      content: { 'application/json': { schema: VerifierMutationResponseSchema } },
    },
    400: verifierErrorResponse('Invalid userId (empty or longer than 128 characters)'),
    401: verifierErrorResponse('Missing or invalid bearer token'),
    403: verifierErrorResponse('Admin role required'),
    404: verifierErrorResponse('Verifier not found'),
    409: verifierErrorResponse('Invalid verifier status transition'),
    500: verifierErrorResponse('Unexpected server error'),
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


// ==================== ORG VAULTS & SAVED SEARCHES ====================
// Routes from src/routes/orgVaults.ts, mounted at /api/organizations.

const PagePagination = registry.register(
  'PagePagination',
  z.object({
    page: z.number().int().openapi({ example: 1 }),
    pageSize: z.number().int().openapi({ example: 20 }),
    total: z.number().int().openapi({ example: 42 }),
    totalPages: z.number().int().openapi({ example: 3 }),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  }),
)

const OrgErrorResponse = z.object({
  error: z.string().openapi({ example: 'Internal server error' }),
})

const ORG_ID_PARAM = {
  name: 'orgId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const, example: 'org_123' },
}

const SEARCH_ID_PARAM = {
  name: 'searchId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const },
}

const PAGE_PARAM = {
  name: 'page',
  in: 'query' as const,
  schema: { type: 'integer' as const, minimum: 1, default: 1 },
}

const PAGE_SIZE_PARAM = {
  name: 'pageSize',
  in: 'query' as const,
  schema: { type: 'integer' as const, minimum: 1, maximum: 100, default: 20 },
}

const CURSOR_LIMIT_PARAM = {
  name: 'limit',
  in: 'query' as const,
  schema: { type: 'integer' as const, minimum: 1, maximum: 100, default: 20 },
}

const OrgVaultStatus = z.enum([
  'draft',
  'active',
  'completed',
  'failed',
  'cancelled',
])

const OrgVaultSchema = registry.register(
  'OrgVault',
  z.object({
    id: z.string(),
    creator: z.string(),
    verifier: z.string(),
    amount: z.string().openapi({ example: '100.0000000' }),
    status: OrgVaultStatus,
    orgId: z.string(),
    startTimestamp: z.string().datetime(),
    endTimestamp: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
)

const SavedSearchQueryDefinitionSchema = registry.register(
  'SavedSearchQueryDefinition',
  z.object({
    q: z.string().max(200).optional().openapi({ description: 'Free-text search term (sanitized)' }),
    status: OrgVaultStatus.optional(),
    verifier: z.string().max(256).optional(),
    amount_min: z.string().regex(/^\d+(\.\d+)?$/).optional().openapi({ description: 'Inclusive lower amount bound' }),
    amount_max: z.string().regex(/^\d+(\.\d+)?$/).optional().openapi({ description: 'Inclusive upper amount bound' }),
    date_from: z.string().optional().openapi({ description: 'ISO 8601 date or timestamp (inclusive lower created_at bound)' }),
    date_to: z.string().optional().openapi({ description: 'ISO 8601 date or timestamp (inclusive upper created_at bound)' }),
    sort_by: z.enum(['created_at', 'amount', 'end_date', 'status']).optional(),
    sort_order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
)

const OrgVaultSearchSchema = registry.register(
  'OrgVaultSearch',
  z.object({
    id: z.string(),
    org_id: z.string(),
    name: z.string().openapi({ example: 'High-value active vaults' }),
    query_definition: SavedSearchQueryDefinitionSchema,
    alerts_enabled: z.boolean(),
    alert_recipient: z.string().nullable(),
    alert_frequency_ms: z.number().int().openapi({ example: 3_600_000 }),
    last_evaluated_at: z.string().datetime().nullable(),
    last_result_hash: z.string().nullable(),
    created_by: z.string(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
)

const OrgVaultSearchResultSchema = registry.register(
  'OrgVaultSearchResult',
  z.object({
    id: z.string(),
    creator: z.string(),
    verifier: z.string(),
    amount: z.string(),
    status: OrgVaultStatus,
    organization_id: z.string(),
    start_date: z.string().datetime(),
    end_date: z.string().datetime(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
)

// GET /api/organizations/:orgId/vaults
registry.registerPath({
  method: 'get',
  path: '/api/organizations/{orgId}/vaults',
  summary: 'List vaults belonging to an organization',
  description:
    'Offset-paginated listing of the org\'s non-deleted vaults, with optional status/creator filters and sorting.',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    PAGE_PARAM,
    PAGE_SIZE_PARAM,
    {
      name: 'sortBy',
      in: 'query',
      schema: { type: 'string', enum: ['createdAt', 'amount', 'endTimestamp', 'status'] },
    },
    { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'active', 'completed', 'failed', 'cancelled'] } },
    { name: 'creator', in: 'query', schema: { type: 'string' } },
  ],
  responses: {
    200: {
      description: 'Paginated org vaults',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(OrgVaultSchema),
            pagination: PagePagination,
          }),
        },
      },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Caller is not a member of the organization', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// POST /api/organizations/:orgId/vault-searches
registry.registerPath({
  method: 'post',
  path: '/api/organizations/{orgId}/vault-searches',
  summary: 'Create a saved vault search',
  description:
    'Creates a saved search for the org. Requires owner/admin. Each org may keep at most 20 saved searches; when alerts are enabled the recipient is required and the frequency must be at least one hour.',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
  ],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(255),
            query_definition: SavedSearchQueryDefinitionSchema,
            alerts_enabled: z.boolean().optional().default(false),
            alert_recipient: z.string().optional().openapi({ description: 'Required when alerts_enabled is true' }),
            alert_frequency_ms: z
              .number()
              .int()
              .min(3_600_000)
              .optional()
              .openapi({ description: 'Minimum 3600000 (1 hour)', example: 3_600_000 }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Saved search created',
      content: {
        'application/json': {
          schema: z.object({ search: OrgVaultSearchSchema }),
        },
      },
    },
    400: { description: 'Invalid name, query_definition or alert settings', content: { 'application/json': { schema: OrgErrorResponse } } },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
    422: { description: 'Org has reached the saved-search limit (20)', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/organizations/:orgId/vault-searches
registry.registerPath({
  method: 'get',
  path: '/api/organizations/{orgId}/vault-searches',
  summary: 'List saved vault searches',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
  ],
  responses: {
    200: {
      description: 'Saved searches, newest first',
      content: {
        'application/json': {
          schema: z.object({ searches: z.array(OrgVaultSearchSchema) }),
        },
      },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Caller is not a member of the organization', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/organizations/:orgId/vault-searches/:searchId
registry.registerPath({
  method: 'get',
  path: '/api/organizations/{orgId}/vault-searches/{searchId}',
  summary: 'Get a saved vault search',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    SEARCH_ID_PARAM,
  ],
  responses: {
    200: {
      description: 'Saved search',
      content: {
        'application/json': {
          schema: z.object({ search: OrgVaultSearchSchema }),
        },
      },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Caller is not a member of the organization', content: { 'application/json': { schema: OrgErrorResponse } } },
    404: { description: 'Saved search not found', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// DELETE /api/organizations/:orgId/vault-searches/:searchId
registry.registerPath({
  method: 'delete',
  path: '/api/organizations/{orgId}/vault-searches/{searchId}',
  summary: 'Delete a saved vault search',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    SEARCH_ID_PARAM,
  ],
  responses: {
    204: { description: 'Saved search deleted' },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
    404: { description: 'Saved search not found', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/organizations/:orgId/vaults/search
registry.registerPath({
  method: 'get',
  path: '/api/organizations/{orgId}/vaults/search',
  summary: 'Search an organization\'s vaults',
  description:
    'Full-text search (tsvector with an ILIKE fallback) plus structured filters, cursor-paginated on (created_at DESC, id DESC).',
  tags: ['Org Vaults'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    { name: 'q', in: 'query', schema: { type: 'string', maxLength: 200, description: 'Sanitized free-text term' } },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'active', 'completed', 'failed', 'cancelled'] } },
    { name: 'verifier', in: 'query', schema: { type: 'string' } },
    { name: 'amount_min', in: 'query', schema: { type: 'string' } },
    { name: 'amount_max', in: 'query', schema: { type: 'string' } },
    { name: 'date_from', in: 'query', schema: { type: 'string', description: 'ISO 8601 lower bound on created_at' } },
    { name: 'date_to', in: 'query', schema: { type: 'string', description: 'ISO 8601 upper bound on created_at' } },
    { name: 'cursor', in: 'query', schema: { type: 'string', description: 'Opaque cursor from a previous page' } },
    CURSOR_LIMIT_PARAM,
  ],
  responses: {
    200: {
      description: 'Matching vaults',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(OrgVaultSearchResultSchema),
            pagination: PaginationCursor,
          }),
        },
      },
    },
    400: { description: 'Invalid cursor', content: { 'application/json': { schema: OrgErrorResponse } } },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Caller is not a member of the organization', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// ==================== ORG ANALYTICS ====================
// Routes from src/routes/orgAnalytics.ts, mounted at /api/orgs
// (and at the /api/organizations alias).

const OrgAnalyticsSchema = registry.register(
  'OrgAnalytics',
  z.object({
    orgId: z.string(),
    analytics: z.object({
      totalCapital: z.string().openapi({ example: '4200.0000000' }),
      successRate: z.number().openapi({ description: 'completed / (completed + failed)', example: 0.75 }),
      activeVaults: z.number().int(),
      completedVaults: z.number().int(),
      failedVaults: z.number().int(),
    }),
    teamPerformance: z.array(
      z.object({
        creator: z.string(),
        vaultCount: z.number().int(),
        totalAmount: z.string(),
        successRate: z.number(),
      }),
    ),
    generatedAt: z.string().datetime(),
  }),
)

const OrgRiskAnalyticsSchema = registry.register(
  'OrgRiskAnalytics',
  z.object({
    orgId: z.string(),
    generatedAt: z.string().datetime(),
    range: z.object({
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
    }),
    analytics: z.object({
      totalVaults: z.number().int(),
      activeVaults: z.number().int(),
      resolvedVaults: z.number().int(),
      slashedVaults: z.number().int(),
      slashRate: z.number(),
      capitalAtRisk: z.string(),
    }),
  }),
)

const CohortRetentionSchema = registry.register(
  'CohortRetention',
  z.object({
    cohorts: z.array(
      z.object({
        cohort_period: z.string().openapi({ example: '2026-01' }),
        cohort_size: z.number().int(),
        retained_count: z.number().int(),
        retention_rate: z.number().openapi({ description: 'Fraction in [0, 1]' }),
      }),
    ),
    range: z.number().int().nullable(),
    generatedAt: z.string().datetime(),
  }),
)

const TeamRollupEntrySchema = z.object({
  teamId: z.string(),
  name: z.string(),
  slug: z.string(),
  vaultCount: z.number().int(),
  totalCapital: z.string(),
  activeVaults: z.number().int(),
  completedVaults: z.number().int(),
  failedVaults: z.number().int(),
  milestoneCount: z.number().int(),
  milestonesCompleted: z.number().int(),
  slashRate: z.number(),
})

const TeamRollupSchema = registry.register(
  'TeamRollup',
  z.object({
    orgId: z.string(),
    teams: z.array(TeamRollupEntrySchema),
    orgTotals: TeamRollupEntrySchema.omit({ teamId: true, name: true, slug: true }).extend({
      teamCount: z.number().int(),
    }),
    generatedAt: z.string().datetime(),
  }),
)

const AnalyticsReportSchema = registry.register(
  'OrgAnalyticsReport',
  z.object({
    id: z.string(),
    orgId: z.string(),
    snapshotAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    sizeBytes: z.number().int(),
    downloadUrl: z.string().nullable().openapi({ description: 'Signed S3 URL or local download path' }),
  }),
)

// GET /api/orgs/:orgId/analytics/risk
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/analytics/risk',
  summary: 'Get org risk analytics',
  description: 'Slash rate, capital at risk and vault counts, optionally scoped to a date window.',
  tags: ['Org Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    { name: 'startDate', in: 'query', schema: { type: 'string', description: 'ISO 8601 window start' } },
    { name: 'endDate', in: 'query', schema: { type: 'string', description: 'ISO 8601 window end' } },
  ],
  responses: {
    200: {
      description: 'Risk analytics',
      content: { 'application/json': { schema: OrgRiskAnalyticsSchema } },
    },
    400: { description: 'Invalid date range', content: { 'application/json': { schema: OrgErrorResponse } } },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/orgs/:orgId/analytics
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/analytics',
  summary: 'Get org vault analytics',
  description: 'Totals, success rate and a per-creator team-performance breakdown, aggregated from Postgres.',
  tags: ['Org Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
  ],
  responses: {
    200: {
      description: 'Org analytics',
      content: { 'application/json': { schema: OrgAnalyticsSchema } },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Failed to generate org analytics', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/orgs/:orgId/cohort-retention
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/cohort-retention',
  summary: 'Get cohort retention',
  description:
    'Retention cohorts read from the vault_cohort_retention materialized view. Note: the view is global, not scoped to the org.',
  tags: ['Org Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    { name: 'range', in: 'query', schema: { type: 'integer', minimum: 1, description: 'Number of most-recent cohorts to return' } },
  ],
  responses: {
    200: {
      description: 'Cohort retention data',
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            orgId: z.string(),
            data: CohortRetentionSchema,
          }),
        },
      },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/orgs/:orgId/teams/rollup
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/teams/rollup',
  summary: 'Get org team rollup',
  description: 'Per-team vault, capital and milestone totals plus org-wide totals.',
  tags: ['Org Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
  ],
  responses: {
    200: {
      description: 'Team rollup',
      content: { 'application/json': { schema: TeamRollupSchema } },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
    500: { description: 'Failed to generate team rollup', content: { 'application/json': { schema: OrgErrorResponse } } },
  },
})

// GET /api/orgs/:orgId/analytics/reports
registry.registerPath({
  method: 'get',
  path: '/api/orgs/{orgId}/analytics/reports',
  summary: 'List org analytics reports',
  description: 'Point-in-time analytics reports, newest first, with a signed download URL when available.',
  tags: ['Org Analytics'],
  security: [{ bearerAuth: [] }],
  parameters: [
    ORG_ID_PARAM,
    PAGE_PARAM,
    PAGE_SIZE_PARAM,
  ],
  responses: {
    200: {
      description: 'Paginated analytics reports',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(AnalyticsReportSchema),
            pagination: PagePagination,
          }),
        },
      },
    },
    401: { description: 'Authentication required', content: { 'application/json': { schema: OrgErrorResponse } } },
    403: { description: 'Owner or admin role required', content: { 'application/json': { schema: OrgErrorResponse } } },
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
