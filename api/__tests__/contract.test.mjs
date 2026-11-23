import test from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import app from '../index.mjs'
import { OPENAPI } from '../../apilib/openapi.mjs'

const ajv = new Ajv({
  allErrors: true,
  strict: false,
})
addFormats(ajv)

// Add components.schemas to Ajv so $ref links resolve correctly
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`)
}

function expectMatchesSpec(res, method, pathPattern) {
  const methodLower = method.toLowerCase()
  const pathItem = OPENAPI.paths[pathPattern]
  assert.ok(pathItem, `Path pattern "${pathPattern}" not found in OPENAPI spec`)

  const operation = pathItem[methodLower]
  assert.ok(operation, `Method "${methodLower.toUpperCase()}" not found for path "${pathPattern}" in OPENAPI spec`)

  const statusCode = String(res.status)
  const responseSpec = operation.responses[statusCode] || operation.responses.default
  assert.ok(responseSpec, `Status code ${statusCode} not documented for ${method} ${pathPattern}`)

  const schema = responseSpec.content?.['application/json']?.schema
  assert.ok(schema, `Missing JSON response schema for ${method} ${pathPattern} (${statusCode})`)

  const validate = ajv.compile(schema)
  const valid = validate(res.body)
  if (!valid) {
    console.error(`Schema validation errors for ${method} ${pathPattern} (${statusCode}):`, validate.errors)
  }
  assert.equal(valid, true, `Response body does not match schema for ${method} ${pathPattern} (${statusCode}): ${JSON.stringify(validate.errors)}`)
}

test('Contract test: GET /health matches schema', async () => {
  const res = await request(app).get('/api/health')
  assert.equal(res.status, 200)
  expectMatchesSpec(res, 'GET', '/health')
})

test('Contract test: GET /openapi.json returns valid spec object', async () => {
  const res = await request(app).get('/api/openapi.json')
  assert.equal(res.status, 200)
  expectMatchesSpec(res, 'GET', '/openapi.json')
})

test('Contract test: POST /vaults validates request and response schemas (success and 400)', async () => {
  const validPayload = {
    name: 'Contract Test Vault',
    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
    amount: 1500,
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    successDestination: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
    failureDestination: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
    milestones: [
      {
        title: 'Initial Contract Milestone',
        amount: 500,
        dueDate: new Date(Date.now() + 10 * 86400000).toISOString(),
      },
      {
        title: 'Final Contract Milestone',
        amount: 1000,
        dueDate: new Date(Date.now() + 25 * 86400000).toISOString(),
      },
    ],
  }

  // 201 Success
  const resSuccess = await request(app).post('/api/vaults').send(validPayload)
  assert.equal(resSuccess.status, 201)
  expectMatchesSpec(resSuccess, 'POST', '/vaults')

  // 400 Bad Request
  const resBadRequest = await request(app).post('/api/vaults').send({ amount: -50 })
  assert.equal(resBadRequest.status, 400)
  expectMatchesSpec(resBadRequest, 'POST', '/vaults')
})

test('Contract test: GET /vaults returns VaultList schema with count and data', async () => {
  const res = await request(app).get('/api/vaults')
  assert.equal(res.status, 200)
  expectMatchesSpec(res, 'GET', '/vaults')
})

test('Contract test: GET /vaults/:id returns VaultWithActivityEnvelope or 404 Error schema', async () => {
  // 404
  const res404 = await request(app).get('/api/vaults/vault-nonexistent')
  assert.equal(res404.status, 404)
  expectMatchesSpec(res404, 'GET', '/vaults/{id}')

  // 200
  const resList = await request(app).get('/api/vaults')
  const existingVault = resList.body.data[0]
  assert.ok(existingVault)

  const res200 = await request(app).get(`/api/vaults/${existingVault.id}`)
  assert.equal(res200.status, 200)
  expectMatchesSpec(res200, 'GET', '/vaults/{id}')
})

test('Contract test: POST /vaults/:id/milestones/:mid/validate matches schema (200, 403, 404, 409)', async () => {
  const resList = await request(app).get('/api/vaults')
  const activeVault = resList.body.data.find((v) => v.status === 'active')
  assert.ok(activeVault)
  const pendingMilestone = activeVault.milestones.find((m) => m.status === 'pending')
  assert.ok(pendingMilestone)

  // 403 Forbidden (wrong verifier)
  const res403 = await request(app)
    .post(`/api/vaults/${activeVault.id}/milestones/${pendingMilestone.id}/validate`)
    .send({ verifier: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22' })
  assert.equal(res403.status, 403)
  expectMatchesSpec(res403, 'POST', '/vaults/{id}/milestones/{mid}/validate')

  // 404 Not Found (unknown milestone)
  const res404 = await request(app)
    .post(`/api/vaults/${activeVault.id}/milestones/unknown-mid/validate`)
    .send({ verifier: activeVault.verifier })
  assert.equal(res404.status, 404)
  expectMatchesSpec(res404, 'POST', '/vaults/{id}/milestones/{mid}/validate')

  // 200 Success
  const res200 = await request(app)
    .post(`/api/vaults/${activeVault.id}/milestones/${pendingMilestone.id}/validate`)
    .send({ verifier: activeVault.verifier })
  assert.equal(res200.status, 200)
  expectMatchesSpec(res200, 'POST', '/vaults/{id}/milestones/{mid}/validate')

  // 409 Conflict (already validated)
  const res409 = await request(app)
    .post(`/api/vaults/${activeVault.id}/milestones/${pendingMilestone.id}/validate`)
    .send({ verifier: activeVault.verifier })
  assert.equal(res409.status, 409)
  expectMatchesSpec(res409, 'POST', '/vaults/{id}/milestones/{mid}/validate')
})

test('Contract test: POST /vaults/:id/fail matches schema (200, 403, 404, 409)', async () => {
  // Create a new vault specifically for fail testing
  const createRes = await request(app).post('/api/vaults').send({
    name: 'Vault to Fail',
    creator: 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ',
    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
    amount: 1000,
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    milestones: [
      { title: 'Task to Fail', amount: 1000, dueDate: new Date(Date.now() + 15 * 86400000).toISOString() },
    ],
  })
  assert.equal(createRes.status, 201)
  const vault = createRes.body.data

  // 404 Not Found
  const res404 = await request(app)
    .post('/api/vaults/unknown-vault-id/fail')
    .send({ verifier: vault.verifier })
  assert.equal(res404.status, 404)
  expectMatchesSpec(res404, 'POST', '/vaults/{id}/fail')

  // 403 Forbidden
  const res403 = await request(app)
    .post(`/api/vaults/${vault.id}/fail`)
    .send({ verifier: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22' })
  assert.equal(res403.status, 403)
  expectMatchesSpec(res403, 'POST', '/vaults/{id}/fail')

  // 200 Success
  const res200 = await request(app)
    .post(`/api/vaults/${vault.id}/fail`)
    .send({ verifier: vault.verifier })
  assert.equal(res200.status, 200)
  expectMatchesSpec(res200, 'POST', '/vaults/{id}/fail')

  // 409 Conflict
  const res409 = await request(app)
    .post(`/api/vaults/${vault.id}/fail`)
    .send({ verifier: vault.verifier })
  assert.equal(res409.status, 409)
  expectMatchesSpec(res409, 'POST', '/vaults/{id}/fail')
})

test('Contract test: GET /transactions matches ActivityList schema', async () => {
  const res = await request(app).get('/api/transactions')
  assert.equal(res.status, 200)
  expectMatchesSpec(res, 'GET', '/transactions')
})

test('Contract test: GET /stats matches StatsEnvelope schema', async () => {
  const res = await request(app).get('/api/stats')
  assert.equal(res.status, 200)
  expectMatchesSpec(res, 'GET', '/stats')
})
