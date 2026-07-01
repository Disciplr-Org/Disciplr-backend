import { jest } from '@jest/globals'

// In-memory credential store keyed by credential_id
const credentialStore = new Map<string, { userId: string; publicKey: string; counter: number }>()

const mockPrisma = {
  $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Parse the query to determine which operation is being called
    const sql = strings.join('?')
    if (sql.includes('SELECT "credential_id"')) {
      const credentialId = values[0] as string
      const existing = credentialStore.get(credentialId)
      return existing ? [{ credential_id: credentialId }] : []
    }
    if (sql.includes('SELECT "counter"')) {
      const credentialId = values[0] as string
      const existing = credentialStore.get(credentialId)
      return existing ? [{ counter: existing.counter }] : []
    }
    return []
  }),
  $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('INSERT INTO "webauthn_credentials"')) {
      const [userId, credentialId, publicKey] = values as [string, string, string]
      credentialStore.set(credentialId, { userId, publicKey, counter: 0 })
    } else if (sql.includes('UPDATE "webauthn_credentials"')) {
      const [newCounter, credentialId] = values as [number, string]
      const existing = credentialStore.get(credentialId)
      if (existing) {
        existing.counter = newCounter
      }
    }
    return 1
  }),
}

jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: () => mockPrisma,
  prismaStorage: { getStore: () => undefined },
}))

const { AuthService } = await import('../services/auth.service.js')

describe('WebAuthn credential registration uniqueness', () => {
  beforeEach(() => {
    credentialStore.clear()
    jest.clearAllMocks()
  })

  it('registers a new credential successfully', async () => {
    const result = await AuthService.registerWebAuthnCredential('user-1', 'cred-abc', 'pubkey-abc')
    expect(result).toEqual({ userId: 'user-1', credentialId: 'cred-abc', publicKey: 'pubkey-abc' })
    expect(credentialStore.has('cred-abc')).toBe(true)
  })

  it('rejects duplicate credential registration', async () => {
    await AuthService.registerWebAuthnCredential('user-1', 'cred-dup', 'pubkey-1')
    await expect(
      AuthService.registerWebAuthnCredential('user-2', 'cred-dup', 'pubkey-2'),
    ).rejects.toThrow('Credential already registered')
  })

  it('allows different credentials for the same user', async () => {
    await AuthService.registerWebAuthnCredential('user-1', 'cred-1', 'pubkey-1')
    await AuthService.registerWebAuthnCredential('user-1', 'cred-2', 'pubkey-2')
    expect(credentialStore.size).toBe(2)
  })
})

describe('WebAuthn assertion counter verification', () => {
  const CREDENTIAL_ID = 'cred-counter-test'

  beforeEach(async () => {
    credentialStore.clear()
    jest.clearAllMocks()
    await AuthService.registerWebAuthnCredential('user-1', CREDENTIAL_ID, 'pubkey-x')
    // Seed counter to 5 to allow regression tests
    credentialStore.get(CREDENTIAL_ID)!.counter = 5
  })

  it('accepts a monotonically increasing counter', async () => {
    const result = await AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 6)
    expect(result).toEqual({ credentialId: CREDENTIAL_ID, counter: 6 })
    expect(credentialStore.get(CREDENTIAL_ID)!.counter).toBe(6)
  })

  it('accepts a large counter increment', async () => {
    const result = await AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 999)
    expect(result.counter).toBe(999)
  })

  it('rejects an equal counter (clone detection)', async () => {
    await expect(AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 5)).rejects.toThrow(
      'Counter regression detected',
    )
  })

  it('rejects a counter lower than stored (clone detection)', async () => {
    await expect(AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 4)).rejects.toThrow(
      'Counter regression detected',
    )
  })

  it('rejects counter 0 against a stored counter of 5', async () => {
    await expect(AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 0)).rejects.toThrow(
      'Counter regression detected',
    )
  })

  it('does not update the stored counter on rejection', async () => {
    await expect(AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 3)).rejects.toThrow()
    expect(credentialStore.get(CREDENTIAL_ID)!.counter).toBe(5)
  })

  it('throws when credential does not exist', async () => {
    await expect(AuthService.verifyWebAuthnAssertion('nonexistent-cred', 1)).rejects.toThrow(
      'Credential not found',
    )
  })

  it('accepts counter 1 when stored counter is 0 (fresh credential)', async () => {
    credentialStore.get(CREDENTIAL_ID)!.counter = 0
    const result = await AuthService.verifyWebAuthnAssertion(CREDENTIAL_ID, 1)
    expect(result.counter).toBe(1)
  })
})
