import { describe, it, expect } from '@jest/globals'
import { generateOpenApiSpec } from '../docs/openapi-generator.js'

type Operation = {
  operationId?: string
  tags?: string[]
  security?: Array<Record<string, unknown>>
  parameters?: Array<{ name: string; in: string; required?: boolean }>
  responses?: Record<string, unknown>
  requestBody?: unknown
}

const spec = generateOpenApiSpec() as {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, unknown> }
}

const expectedOperations: Array<{ path: string; method: string; operationId: string }> = [
  { path: '/api/admin/verifiers', method: 'get', operationId: 'adminListVerifiers' },
  { path: '/api/admin/verifiers', method: 'post', operationId: 'adminCreateVerifier' },
  { path: '/api/admin/verifiers/{userId}', method: 'get', operationId: 'adminGetVerifier' },
  { path: '/api/admin/verifiers/{userId}', method: 'patch', operationId: 'adminUpdateVerifier' },
  { path: '/api/admin/verifiers/{userId}', method: 'delete', operationId: 'adminDeleteVerifier' },
  { path: '/api/admin/verifiers/{userId}/approve', method: 'post', operationId: 'adminApproveVerifier' },
  { path: '/api/admin/verifiers/{userId}/suspend', method: 'post', operationId: 'adminSuspendVerifier' },
  { path: '/api/admin/verifiers/{userId}/reinstate', method: 'post', operationId: 'adminReinstateVerifier' },
  { path: '/api/admin/verifiers/{userId}/deactivate', method: 'post', operationId: 'adminDeactivateVerifier' },
  { path: '/api/admin/verifiers/{userId}/reactivate', method: 'post', operationId: 'adminReactivateVerifier' },
]

describe('OpenAPI admin verifier paths', () => {
  it.each(expectedOperations)('documents $method $path', ({ path, method, operationId }) => {
    const operation = spec.paths[path]?.[method]

    expect(operation).toBeDefined()
    expect(operation.operationId).toBe(operationId)
    expect(operation.tags).toContain('Admin Verifiers')
    expect(operation.security).toEqual([{ bearerAuth: [] }])
    expect(operation.responses?.['401']).toBeDefined()
    expect(operation.responses?.['403']).toBeDefined()
  })

  it('declares userId as a required path parameter on every per-verifier route', () => {
    for (const { path, method } of expectedOperations) {
      if (!path.includes('{userId}')) continue

      const params = spec.paths[path][method].parameters ?? []
      const userId = params.find((param) => param.name === 'userId' && param.in === 'path')

      expect(userId).toBeDefined()
      expect(userId?.required).toBe(true)
    }
  })

  it('documents the list endpoint pagination query parameters and envelope', () => {
    const operation = spec.paths['/api/admin/verifiers'].get
    const params = operation.parameters ?? []

    expect(params.map((param) => param.name).sort()).toEqual(['limit', 'offset'])
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['VerifierListResponse', 'VerifierPagination']),
    )
  })

  it('documents the mutation responses including 409 conflicts and 204 delete', () => {
    const approve = spec.paths['/api/admin/verifiers/{userId}/approve'].post
    expect(Object.keys(approve.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '404', '409', '429']),
    )

    const remove = spec.paths['/api/admin/verifiers/{userId}'].delete
    expect(Object.keys(remove.responses ?? {})).toEqual(
      expect.arrayContaining(['204', '400', '404']),
    )
  })

  it('reuses the shared error and profile components', () => {
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        'VerifierProfile',
        'VerifierStats',
        'VerifierWithStats',
        'VerifierMutationResponse',
        'VerifierErrorResponse',
        'ErrorEnvelope',
      ]),
    )
  })
})
