import { describe, it, expect } from '@jest/globals'
import { isValidStellarAddress } from '../services/vaultValidation.js'

describe('Stellar address checksum validation', () => {
  it('accepts a freshly generated Stellar ed25519 public key', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk')
    const kp = Keypair.random()
    const pub = kp.publicKey()

    const ok = await isValidStellarAddress(pub)
    expect(ok).toBe(true)
  })

  it.each([
    ['non-Stellar input', 'not-a-key'],
    ['a short G-address', 'G' + 'A'.repeat(10)],
    ['a full-length address with an invalid base32 character', 'G' + 'A'.repeat(54) + '0'],
  ])('rejects %s', async (_description, address) => {
    expect(await isValidStellarAddress(address)).toBe(false)
  })

  it('rejects a correctly shaped address with a bad checksum', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk')
    const kp = Keypair.random()
    const pub = kp.publicKey()
    const corrupted = pub.slice(0, -1) + (pub.slice(-1) === 'A' ? 'B' : 'A')

    expect(await isValidStellarAddress(corrupted)).toBe(false)
  })
})
