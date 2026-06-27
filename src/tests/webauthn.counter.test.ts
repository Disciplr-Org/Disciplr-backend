import { beforeEach, describe, expect, it, mock } from 'bun:test'

type CredentialRow = {
  user_id: string
  credential_id: string
  public_key: string
  sign_count: number
}

const credentials = new Map<string, CredentialRow>()

const prisma = {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?')
    if (sql.includes('FROM "webauthn_credentials"')) {
      const credentialId = String(values[0])
      const row = credentials.get(credentialId)
      return row ? [{ ...row }] : []
    }
    throw new Error(`Unexpected query: ${sql}`)
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?')
    if (sql.includes('INSERT INTO "webauthn_credentials"')) {
      const [userId, credentialId, publicKey, signCount] = values
      const id = String(credentialId)
      if (credentials.has(id)) {
        throw new Error('duplicate key value violates unique constraint "webauthn_credentials_credential_id_key"')
      }
      credentials.set(id, {
        user_id: String(userId),
        credential_id: id,
        public_key: String(publicKey),
        sign_count: Number(signCount),
      })
      return 1
    }

    if (sql.includes('UPDATE "webauthn_credentials"')) {
      const [signCount, credentialId] = values
      const id = String(credentialId)
      const existing = credentials.get(id)
      if (!existing) return 0
      credentials.set(id, { ...existing, sign_count: Number(signCount) })
      return 1
    }

    throw new Error(`Unexpected execute: ${sql}`)
  },
}

mock.module('../lib/prismaScope.js', () => ({
  getPrisma: () => prisma,
}))

const { AuthService } = await import('../services/auth.service.js')

describe('WebAuthn credential counter and uniqueness checks', () => {
  beforeEach(() => {
    credentials.clear()
  })

  it('rejects duplicate credential registration instead of silently updating it', async () => {
    await AuthService.registerWebAuthnCredential('user-a', 'credential-1', 'public-key-a', 0)

    await expect(
      AuthService.registerWebAuthnCredential('user-b', 'credential-1', 'public-key-b', 0),
    ).rejects.toThrow('WebAuthn credential already registered')

    expect(credentials.get('credential-1')).toMatchObject({
      user_id: 'user-a',
      public_key: 'public-key-a',
      sign_count: 0,
    })
  })

  it('accepts a monotonically increasing assertion counter and persists it', async () => {
    await AuthService.registerWebAuthnCredential('user-a', 'credential-2', 'public-key-a', 7)

    const result = await AuthService.verifyWebAuthnAssertionCounter('credential-2', 8)

    expect(result).toEqual({
      userId: 'user-a',
      credentialId: 'credential-2',
      previousSignCount: 7,
      signCount: 8,
    })
    expect(credentials.get('credential-2')?.sign_count).toBe(8)
  })

  it('rejects equal and lower counters as cloned-authenticator rollback attempts', async () => {
    await AuthService.registerWebAuthnCredential('user-a', 'credential-3', 'public-key-a', 10)

    await expect(AuthService.verifyWebAuthnAssertionCounter('credential-3', 10))
      .rejects.toThrow('WebAuthn signature counter rollback detected')
    await expect(AuthService.verifyWebAuthnAssertionCounter('credential-3', 9))
      .rejects.toThrow('WebAuthn signature counter rollback detected')

    expect(credentials.get('credential-3')?.sign_count).toBe(10)
  })

  it('rejects unsafe or missing counters without mutating stored state', async () => {
    await AuthService.registerWebAuthnCredential('user-a', 'credential-4', 'public-key-a', 3)

    await expect(AuthService.verifyWebAuthnAssertionCounter('credential-4', Number.NaN))
      .rejects.toThrow('WebAuthn signature counter rollback detected')
    await expect(AuthService.verifyWebAuthnAssertionCounter('credential-4', 3.5))
      .rejects.toThrow('WebAuthn signature counter rollback detected')
    await expect(AuthService.verifyWebAuthnAssertionCounter('missing-credential', 1))
      .rejects.toThrow('WebAuthn credential not found')

    expect(credentials.get('credential-4')?.sign_count).toBe(3)
  })

  it('rejects invalid initial registration counters', async () => {
    await expect(AuthService.registerWebAuthnCredential('user-a', 'credential-5', 'public-key-a', -1))
      .rejects.toThrow('WebAuthn signature counter must be a non-negative integer')
    await expect(AuthService.registerWebAuthnCredential('user-a', 'credential-5', 'public-key-a', 1.5))
      .rejects.toThrow('WebAuthn signature counter must be a non-negative integer')

    expect(credentials.has('credential-5')).toBe(false)
  })
})
