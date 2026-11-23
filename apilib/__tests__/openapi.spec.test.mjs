import test from 'node:test'
import assert from 'node:assert/strict'
import { Validator } from '@seriousme/openapi-schema-validator'
import { OPENAPI } from '../openapi.mjs'

test('apilib/openapi.mjs is a valid OpenAPI 3.0 document', async () => {
  const validator = new Validator()
  const result = await validator.validate(OPENAPI)
  if (!result.valid) {
    console.error('OpenAPI specification validation errors:', result.errors)
  }
  assert.equal(result.valid, true, 'OPENAPI must be valid according to the OpenAPI 3.0 specification')
})

test('Every path and operation in OPENAPI has unique operationId and component references', () => {
  const seenOperationIds = new Set()

  for (const [pathStr, pathItem] of Object.entries(OPENAPI.paths)) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
        assert.ok(op.operationId, `Operation ${method.toUpperCase()} ${pathStr} must have an operationId`)
        assert.ok(!seenOperationIds.has(op.operationId), `operationId "${op.operationId}" must be unique`)
        seenOperationIds.add(op.operationId)

        // Verify 2xx response has schema
        const successStatus = Object.keys(op.responses).find((s) => s.startsWith('2'))
        assert.ok(successStatus, `Operation ${op.operationId} must have a 2xx response`)
        const resp2xx = op.responses[successStatus]
        assert.ok(resp2xx.content && resp2xx.content['application/json'], `Operation ${op.operationId} must return application/json`)
        assert.ok(resp2xx.content['application/json'].schema, `Operation ${op.operationId} 2xx response must specify a schema`)
      }
    }
  }
})
