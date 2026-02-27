import request from 'supertest'
import { app } from '../app.js'
import { signToken } from '../middleware/auth.js'
import {
  decryptEvidenceForTesting,
  findValidationTransactionById,
  resetValidationTransactions,
} from '../services/verifications.js'

const authHeader = (role: 'user' | 'verifier' | 'admin', sub = 'verifier-1'): string =>
  `Bearer ${signToken({ sub, role })}`

const payload = {
  vaultId: 'vault-001',
  milestoneId: 'milestone-001',
  verdict: 'approved' as const,
  evidence: {
    mimeType: 'text/plain',
    data: 'proof-contents',
  },
}

describe('verification endpoints security controls', () => {
  beforeEach(() => {
    resetValidationTransactions()
  })

  it('enforces verifier role restrictions on create and read endpoints', async () => {
    const unauthenticated = await request(app)
      .post('/api/verifications/validations')
      .set('Idempotency-Key', 'k-1')
      .send(payload)
    expect(unauthenticated.status).toBe(401)

    const forbidden = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('user', 'user-1'))
      .set('Idempotency-Key', 'k-2')
      .send(payload)
    expect(forbidden.status).toBe(403)

    const verifierCreate = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('verifier', 'verifier-2'))
      .set('Idempotency-Key', 'k-3')
      .send(payload)
    expect(verifierCreate.status).toBe(201)

    const listForbidden = await request(app)
      .get('/api/verifications/validations')
      .set('Authorization', authHeader('user', 'user-2'))
    expect(listForbidden.status).toBe(403)

    const listAllowed = await request(app)
      .get('/api/verifications/validations')
      .set('Authorization', authHeader('admin', 'admin-1'))
    expect(listAllowed.status).toBe(200)
    expect(listAllowed.body.count).toBe(1)
  })

  it('implements idempotent validation transaction creation', async () => {
    const first = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('verifier', 'verifier-idem'))
      .set('Idempotency-Key', 'idempotency-123')
      .send(payload)
    expect(first.status).toBe(201)
    expect(first.body.replayed).toBe(false)

    const replay = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('verifier', 'verifier-idem'))
      .set('Idempotency-Key', 'idempotency-123')
      .send(payload)
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(first.body.id)
    expect(replay.body.replayed).toBe(true)

    const conflict = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('verifier', 'verifier-idem'))
      .set('Idempotency-Key', 'idempotency-123')
      .send({
        ...payload,
        verdict: 'rejected',
      })
    expect(conflict.status).toBe(409)
  })

  it('stores evidence encrypted at rest', async () => {
    const create = await request(app)
      .post('/api/verifications/validations')
      .set('Authorization', authHeader('verifier', 'verifier-enc'))
      .set('Idempotency-Key', 'enc-1')
      .send(payload)
    expect(create.status).toBe(201)
    expect(create.body.evidence.encrypted).toBe(true)

    const stored = findValidationTransactionById(create.body.id)
    expect(stored).toBeDefined()
    expect(stored!.evidence.ciphertext).not.toContain(payload.evidence.data)

    const decrypted = decryptEvidenceForTesting(stored!)
    expect(decrypted.data).toBe(payload.evidence.data)
    expect(decrypted.mimeType).toBe(payload.evidence.mimeType)
  })
})
