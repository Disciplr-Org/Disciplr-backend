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

  it('rejects malformed addresses and bad checksums', async () => {
    expect(await isValidStellarAddress('not-a-key')).toBe(false)
    // Wrong length / characters
    expect(await isValidStellarAddress('G' + 'A'.repeat(10))).toBe(false)

    // Change one character of a valid key to corrupt checksum
    const { Keypair } = await import('@stellar/stellar-sdk')
    const kp = Keypair.random()
    const pub = kp.publicKey()
    // flip last character
    const corrupted = pub.slice(0, -1) + (pub.slice(-1) === 'A' ? 'B' : 'A')
    expect(await isValidStellarAddress(corrupted)).toBe(false)
  })
})
