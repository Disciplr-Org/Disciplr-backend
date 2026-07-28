import express, { type Express } from 'express'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { parse } from 'yaml'
import { beforeAll, describe, expect, it, jest } from '@jest/globals'

type OpenApiSpec = {
  paths: Record<string, Record<string, { responses?: Record<string, ResponseSpec> }>>
  components?: { schemas?: Record<string, Schema> }
}

type ResponseSpec = {
  content?: Record<string, { schema?: Schema }>
}

type Schema = {
  $ref?: string
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  anyOf?: Schema[]
  oneOf?: Schema[]
  allOf?: Schema[]
  def?: {
    type?: string
    shape?: Record<string, Schema>
    innerType?: Schema
  }
}

type ContractCase = {
  name: string
  method: 'get' | 'post'
  documentedPath: string
  actualPath: string
  expectedStatus: number
  headers?: Record<string, string>
  body?: unknown
  capture?: (body: any) => void
}

const spec = parse(readFileSync('docs/openapi.yaml', 'utf8')) as OpenApiSpec
const userId = '11111111-1111-4111-8111-111111111111'
let exportJobId = ''

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = {
      userId: req.header('x-test-user-id') ?? userId,
      role: req.header('x-test-role') ?? 'USER',
    }
    next()
  },
  requireAdmin: (req: any, res: any, next: () => void) => {
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ error: 'Forbidden: Admin role required' })
      return
    }
    next()
  },
  requireUserAuth: (req: any, res: any, next: () => void) => {
    const headerUserId = req.header('x-user-id')
    if (!headerUserId) {
      res.status(401).json({ error: 'Authentication required.' })
      return
    }
    req.authUser = { userId: headerUserId }
    next()
  },
  signDownloadToken: (jobId: string, signedUserId: string) => `download.${jobId}.${signedUserId}`,
  verifyDownloadToken: (token: string) => {
    const [, jobId, signedUserId] = token.split('.')
    return jobId && signedUserId ? { jobId, userId: signedUserId } : null
  },
}))

jest.unstable_mockModule('../middleware/apiKeyAuth.js', () => ({
  authenticateApiKey: (requiredScopes: string[] = []) => (req: any, _res: any, next: () => void) => {
    req.apiKeyAuth = {
      apiKeyId: 'contract-api-key',
      userId,
      orgId: null,
      scopes: requiredScopes,
      label: 'OpenAPI contract test key',
    }
    next()
  },
  requireScopes: () => (_req: any, _res: any, next: () => void) => next(),
}))

jest.unstable_mockModule('../db/pool.js', () => ({
  getPgPool: () => null,
}))

const transactionRows = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: userId,
    vault_id: 'contract-vault',
    type: 'creation',
    amount: '10.0000000',
    asset_code: null,
    tx_hash: 'contract_tx_hash',
    from_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    to_account: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    memo: 'contract fixture',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    stellar_ledger: 123,
    stellar_timestamp: new Date('2026-01-01T00:00:00.000Z'),
    explorer_url: 'https://stellar.expert/explorer/public/tx/contract',
  },
]

class MockQuery {
  private rows: any[]
  private limitValue?: number

  constructor(rows: any[]) {
    this.rows = rows
  }

  where(columnOrCallback: string | (() => void), value?: unknown) {
    if (typeof columnOrCallback === 'string' && value !== undefined) {
      this.rows = this.rows.filter((row) => row[columnOrCallback] === value)
    }
    return this
  }

  orWhere() {
    return this
  }

  andWhere() {
    return this
  }

  orderBy() {
    return this
  }

  clone() {
    return new MockQuery([...this.rows])
  }

  count() {
    return {
      first: async () => ({ total: this.rows.length }),
    }
  }

  limit(limit: number) {
    this.limitValue = limit
    return this
  }

  select() {
    return Promise.resolve(this.rows.slice(0, this.limitValue))
  }

  first() {
    return Promise.resolve(this.rows[0])
  }
}

const mockDb = (table: string) => {
  if (table === 'transactions') {
    return new MockQuery([...transactionRows])
  }
  if (table === 'vaults') {
    return new MockQuery([{ id: 'contract-vault', user_id: userId }])
  }
  return new MockQuery([])
}

jest.unstable_mockModule('../db/index.js', () => ({
  db: mockDb,
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
  default: mockDb,
}))

jest.unstable_mockModule('../services/exportQuota.js', () => ({
  checkAndIncrementExportQuota: jest.fn(async () => ({ allowed: true })),
  resetOrgQuotas: jest.fn(async () => undefined),
}))

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => ({
    EXPORT_DAILY_QUOTA_LIMIT: 100,
    CORS_ORIGINS: undefined,
    MAX_JSON_BODY_SIZE: '500kb',
    PORT: 3000,
    SERVICE_NAME: 'disciplr-backend',
  }),
  parseCorsOrigins: () => ['http://localhost:3000'],
  config: {
    env: 'test',
    nodeEnv: 'test',
    logLevel: 'silent',
    port: 3000,
    serviceName: 'disciplr-backend',
    corsOrigins: ['http://localhost:3000'],
    maxJsonBodySize: '500kb',
  },
}))

const normalizeSchema = (schema: Schema): Schema => {
  if (schema.def?.type === 'optional') {
    return normalizeSchema(schema.def.innerType ?? {})
  }
  if (schema.def?.type === 'object' && schema.def.shape) {
    const required = Object.entries(schema.def.shape)
      .filter(([, child]) => child.def?.type !== 'optional' && child.type !== 'optional')
      .map(([key]) => key)

    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(schema.def.shape).map(([key, child]) => [key, normalizeSchema(child)]),
      ),
      required,
    }
  }
  if (schema.def?.type && !schema.type) {
    return { ...schema, type: schema.def.type }
  }
  return schema
}

const resolveSchema = (schema: Schema): Schema => {
  if (!schema.$ref) {
    return normalizeSchema(schema)
  }

  const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)
  if (!match) {
    throw new Error(`Unsupported $ref: ${schema.$ref}`)
  }

  const resolved = spec.components?.schemas?.[match[1]]
  if (!resolved) {
    throw new Error(`Missing schema for $ref: ${schema.$ref}`)
  }

  return normalizeSchema(resolved)
}

const validateValue = (schemaInput: Schema | undefined, value: unknown, path = '$'): string[] => {
  if (!schemaInput || Object.keys(schemaInput).length === 0) {
    return []
  }

  const schema = resolveSchema(schemaInput)

  if (schema.allOf) {
    return schema.allOf.flatMap((child) => validateValue(child, value, path))
  }

  if (schema.anyOf && !schema.anyOf.some((child) => validateValue(child, value, path).length === 0)) {
    return [`${path}: value did not match any allowed schema`]
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => validateValue(child, value, path).length === 0)
    return matches.length === 1 ? [] : [`${path}: value matched ${matches.length} oneOf schemas`]
  }

  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: expected one of ${JSON.stringify(schema.enum)}, received ${JSON.stringify(value)}`]
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.includes('null') && value === null) {
    return []
  }

  const effectiveType = types.find((type) => type !== 'null')
  if (!effectiveType && !schema.properties && !schema.items) {
    return []
  }

  if (effectiveType === 'object' || schema.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path}: expected object, received ${Array.isArray(value) ? 'array' : typeof value}`]
    }

    const objectValue = value as Record<string, unknown>
    const properties = schema.properties ?? {}
    const requiredErrors = (schema.required ?? [])
      .filter((key) => !(key in objectValue))
      .map((key) => `${path}/${key}: missing required property`)
    const extraErrors = Object.keys(objectValue)
      .filter((key) => !(key in properties))
      .map((key) => `${path}/${key}: undocumented property`)
    const childErrors = Object.entries(properties).flatMap(([key, child]) => (
      key in objectValue ? validateValue(child, objectValue[key], `${path}/${key}`) : []
    ))

    return [...requiredErrors, ...extraErrors, ...childErrors]
  }

  if (effectiveType === 'array') {
    if (!Array.isArray(value)) {
      return [`${path}: expected array, received ${typeof value}`]
    }
    return value.flatMap((item, index) => validateValue(schema.items, item, `${path}/${index}`))
  }

  if (effectiveType === 'string' && typeof value !== 'string') {
    return [`${path}: expected string, received ${typeof value}`]
  }

  if ((effectiveType === 'number' || effectiveType === 'integer') && typeof value !== 'number') {
    return [`${path}: expected ${effectiveType}, received ${typeof value}`]
  }

  if (effectiveType === 'boolean' && typeof value !== 'boolean') {
    return [`${path}: expected boolean, received ${typeof value}`]
  }

  return []
}

const responseSchemaFor = (documentedPath: string, method: ContractCase['method'], status: number): Schema | undefined => {
  const operation = spec.paths[documentedPath]?.[method]
  if (!operation) {
    throw new Error(`OpenAPI path is missing: ${method.toUpperCase()} ${documentedPath}`)
  }

  const responseSpec = operation.responses?.[String(status)]
  if (!responseSpec) {
    throw new Error(`OpenAPI response is missing: ${method.toUpperCase()} ${documentedPath} ${status}`)
  }

  return responseSpec.content?.['application/json']?.schema
}

const expectMatchesOpenApi = (
  documentedPath: string,
  method: ContractCase['method'],
  status: number,
  body: unknown,
) => {
  const errors = validateValue(responseSchemaFor(documentedPath, method, status), body)
  if (errors.length > 0) {
    throw new Error(`${method.toUpperCase()} ${documentedPath} ${status}\n${errors.join('\n')}`)
  }
  expect(errors).toEqual([])
}

describe('OpenAPI response contracts', () => {
  let app: Express

  beforeAll(async () => {
    const { createHealthRouter } = await import('../routes/health.js')
    const { vaultsRouter } = await import('../routes/vaults.js')
    const { transactionsRouter } = await import('../routes/transactions.js')
    const { analyticsRouter } = await import('../routes/analytics.js')
    const { createExportRouter } = await import('../routes/exports.js')
    const { resetExportJobs } = await import('../services/exportQueue.js')
    const { resetOrgQuotas } = await import('../services/exportQuota.js')
    const { notFound } = await import('../middleware/notFound.js')
    const { errorHandler } = await import('../middleware/errorHandler.js')

    await resetExportJobs()
    await resetOrgQuotas()

    const jobSystem = {
      enqueue: jest.fn(),
      getMetrics: () => ({
        running: true,
        queueDepth: 0,
        delayedJobs: 0,
        activeJobs: 0,
        totals: { enqueued: 0, executions: 0, completed: 0, failed: 0, retried: 0 },
      }),
    }

    app = express()
    app.use(express.json())
    app.use('/api/health', createHealthRouter(jobSystem as never))
    app.use('/api/vaults', vaultsRouter)
    app.use('/api/transactions', transactionsRouter)
    app.use('/api/analytics', analyticsRouter)
    app.use('/api/exports', createExportRouter(jobSystem as never))
    app.use(notFound)
    app.use(errorHandler)
  })

  const cases: ContractCase[] = [
    {
      name: 'health',
      method: 'get',
      documentedPath: '/api/health',
      actualPath: '/api/health',
      expectedStatus: 200,
    },
    {
      name: 'vaults',
      method: 'get',
      documentedPath: '/api/vaults',
      actualPath: '/api/vaults',
      expectedStatus: 200,
    },
    {
      name: 'transactions with cursor pagination',
      method: 'get',
      documentedPath: '/api/transactions',
      actualPath: '/api/transactions?limit=1',
      expectedStatus: 200,
      headers: { 'x-user-id': userId },
    },
    {
      name: 'vault analytics',
      method: 'get',
      documentedPath: '/api/analytics/vaults',
      actualPath: '/api/analytics/vaults',
      expectedStatus: 200,
    },
    {
      name: 'milestone trends',
      method: 'get',
      documentedPath: '/api/analytics/milestones/trends',
      actualPath: '/api/analytics/milestones/trends?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z',
      expectedStatus: 200,
    },
    {
      name: 'behavior analytics',
      method: 'get',
      documentedPath: '/api/analytics/behavior',
      actualPath: `/api/analytics/behavior?userId=${userId}`,
      expectedStatus: 200,
    },
    {
      name: 'export request',
      method: 'post',
      documentedPath: '/api/exports/me',
      actualPath: '/api/exports/me?format=json&scope=all',
      expectedStatus: 202,
      capture: (body) => {
        exportJobId = body.jobId
      },
    },
    {
      name: 'export status',
      method: 'get',
      documentedPath: '/api/exports/status/{jobId}',
      actualPath: '/api/exports/status/__JOB_ID__',
      expectedStatus: 200,
    },
  ]

  it.each(cases)('matches the documented $name response', async (contractCase) => {
    const actualPath = contractCase.actualPath.replace('__JOB_ID__', exportJobId)
    let call = request(app)[contractCase.method](actualPath)

    for (const [name, value] of Object.entries(contractCase.headers ?? {})) {
      call = call.set(name, value)
    }

    if (contractCase.body) {
      call = call.send(contractCase.body)
    }

    const response = await call
    const documentedResponses = spec.paths[contractCase.documentedPath]?.[contractCase.method]?.responses ?? {}

    if (!Object.keys(documentedResponses).includes(String(response.status))) {
      throw new Error(
        `${contractCase.method.toUpperCase()} ${contractCase.documentedPath} returned undocumented status ${response.status}`,
      )
    }
    expect(response.status).toBe(contractCase.expectedStatus)

    contractCase.capture?.(response.body)
    expectMatchesOpenApi(
      contractCase.documentedPath,
      contractCase.method,
      response.status,
      response.body,
    )
  })

  it('validates shared ErrorEnvelope responses', async () => {
    const response = await request(app).get('/api/not-documented').set('x-request-id', 'contract-request')

    expect(response.status).toBe(404)
    const errors = validateValue({ $ref: '#/components/schemas/ErrorEnvelope' }, response.body)
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
    expect(errors).toEqual([])
  })

  it('reports missing and extra fields with JSON paths', () => {
    const schema = {
      type: 'object',
      properties: {
        requiredName: { type: 'string' },
      },
      required: ['requiredName'],
    }

    expect(validateValue(schema, { extraName: true })).toEqual([
      '$/requiredName: missing required property',
      '$/extraName: undocumented property',
    ])
  })
})
