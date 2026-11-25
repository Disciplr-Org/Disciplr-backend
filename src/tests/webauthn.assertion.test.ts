import { jest } from '@jest/globals'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'

/**
 * WebAuthn assertion verification tests.
 *
 * These tests exercise the public AuthService API for step-up:
 *   - a challenge nonce is never a valid step-up session
 *   - an assertion with an invalid signature is rejected
 *   - an assertion for the wrong challenge is rejected
 *   - an assertion for the wrong origin is rejected
 *   - a counter regression is rejected
 *   - a valid assertion issues a single-use session bound to user and action
 */

const ORIGIN = 'https://app.disciplr.test'
const RP_ID = 'app.disciplr.test'
const CREDENTIAL_ID = 'credential-webauthn-assertion'
const USER_ID = 'user-1'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const STORED_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const credentialStore = new Map<string, { userId: string; publicKey: string; counter: number }>()

const mockPrisma = {
  $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('SELECT "user_id", "public_key"')) {
      const credentialId = values[0] as string
      const credential = credentialStore.get(credentialId)
      return credential
        ? [{ user_id: credential.userId, public_key: credential.publicKey }]
        : []
    }
    if (sql.includes('SELECT "counter"')) {
      const credentialId = values[0] as string
      const credential = credentialStore.get(credentialId)
      return credential ? [{ counter: credential.counter }] : []
    }
    return []
  }),
  $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('UPDATE "webauthn_credentials"')) {
      const [newCounter, credentialId] = values as [number, string]
      const credential = credentialStore.get(credentialId)
      if (credential) credential.counter = newCounter
    }
    return 1
  }),
}

jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: () => mockPrisma,
  prismaStorage: { getStore: () => undefined },
}))

const { AuthService } = await import('../services/auth.service.js')
const { InMemoryStepUpStore, setStepUpStore } = await import('../services/stepUpStore.js')

interface AssertionFixture {
  nonce: string
  userId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  origin: string
}

async function createAssertion(options: {
  action?: string
  challengeNonce?: string
  origin?: string
  signCount?: number
  invalidSignature?: boolean
} = {}): Promise<AssertionFixture> {
  const challenge = await AuthService.issueStepUpChallenge(USER_ID, options.action)
  const clientDataBytes = Buffer.from(JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(options.challengeNonce ?? challenge.nonce, 'utf8').toString('base64url'),
    origin: options.origin ?? ORIGIN,
  }))

  const authenticatorData = Buffer.alloc(37)
  createHash('sha256').update(RP_ID).digest().copy(authenticatorData, 0)
  authenticatorData[32] = 0x05 // UP | UV
  authenticatorData.writeUInt32BE(options.signCount ?? 1, 33)

  const signedData = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientDataBytes).digest(),
  ])
  const signatureBytes = sign('sha256', signedData, privateKey)
  if (options.invalidSignature) {
    signatureBytes[signatureBytes.length - 1] ^= 0x01
  }

  return {
    nonce: challenge.nonce,
    userId: USER_ID,
    credentialId: CREDENTIAL_ID,
    clientDataJSON: clientDataBytes.toString('base64url'),
    authenticatorData: authenticatorData.toString('base64url'),
    signature: signatureBytes.toString('base64url'),
    origin: ORIGIN,
  }
}

describe('WebAuthn step-up assertion verification', () => {
  beforeEach(() => {
    setStepUpStore(new InMemoryStepUpStore())
    credentialStore.clear()
    credentialStore.set(CREDENTIAL_ID, { userId: USER_ID, publicKey: STORED_PUBLIC_KEY, counter: 0 })
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects a raw challenge nonce used as a step-up session id', async () => {
    const challenge = await AuthService.issueStepUpChallenge(USER_ID)
    const session = await AuthService.validateStepUpSession(challenge.nonce, 300)
    expect(session).toBeNull()
  })

  it('rejects an assertion with an invalid signature', async () => {
    const assertion = await createAssertion({ invalidSignature: true })
    const result = await AuthService.verifyStepUpAssertion(assertion)
    expect(result.stepUpSessionId).toBeNull()
    expect(result.reason).toBe('Invalid signature')
  })

  it('rejects an assertion for the wrong challenge', async () => {
    const assertion = await createAssertion({ challengeNonce: 'a-different-challenge' })
    const result = await AuthService.verifyStepUpAssertion(assertion)
    expect(result.stepUpSessionId).toBeNull()
    expect(result.reason).toBe('Challenge mismatch')
  })

  it('rejects an assertion for the wrong origin', async () => {
    const assertion = await createAssertion({ origin: 'https://evil.example' })
    const result = await AuthService.verifyStepUpAssertion(assertion)
    expect(result.stepUpSessionId).toBeNull()
    expect(result.reason).toBe('Origin mismatch')
  })

  it('rejects a counter regression', async () => {
    credentialStore.get(CREDENTIAL_ID)!.counter = 5
    const assertion = await createAssertion({ signCount: 4 })
    const result = await AuthService.verifyStepUpAssertion(assertion)
    expect(result.stepUpSessionId).toBeNull()
    expect(credentialStore.get(CREDENTIAL_ID)!.counter).toBe(5)
  })

  it('issues a single-use session on a valid assertion', async () => {
    const assertion = await createAssertion({ action: 'cancel-vault' })
    const result = await AuthService.verifyStepUpAssertion(assertion)
    expect(result.stepUpSessionId).toBeTruthy()
    expect(result.stepUpSessionId).not.toEqual(assertion.nonce)

    const first = await AuthService.validateStepUpSession(
      result.stepUpSessionId!,
      300,
      'cancel-vault',
    )
    expect(first).toEqual({ userId: USER_ID, sessionId: result.stepUpSessionId })

    const second = await AuthService.validateStepUpSession(
      result.stepUpSessionId!,
      300,
      'cancel-vault',
    )
    expect(second).toBeNull()
    expect(credentialStore.get(CREDENTIAL_ID)!.counter).toBe(1)
  })
})
